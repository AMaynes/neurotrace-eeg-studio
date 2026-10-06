import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { COMMON_EVENT_KEYWORDS, createEventLabelMatcher, eventKeywords } from "../app/directory-event-index.ts";
import { directoryEventCache, setDirectoryEventQuery } from "../app/directory-event-client.ts";

// Execute the actual component and effect lifecycle; scanning is tested separately
// against a worker double. Rendering must never read recording bytes itself.
const componentSource = await readFile(new URL("../app/directory-sessions.tsx", import.meta.url), "utf8");
const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(componentSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const require = createRequire(import.meta.url);

function elements(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props?.children, predicate)];
}

function harness(count, options = {}) {
  let cursor = 0;
  const hooks = [], effects = [], scans = [];
  const exports = {};
  new Function("require", "exports", compiled)((name) => {
    if (name === "react") return {
      useState(initial) {
        const index = cursor++;
        if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
        return [hooks[index], (value) => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }];
      },
      useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
      useEffect(effect, dependencies) {
        const index = cursor++;
        const prior = hooks[index];
        if (!prior || dependencies.some((value, i) => value !== prior.dependencies[i])) {
          effects.push(() => { prior?.cleanup?.(); hooks[index] = { dependencies, cleanup: effect() }; });
        }
      },
    };
    if (name === "./directory-event-index") return { COMMON_EVENT_KEYWORDS, createEventLabelMatcher, eventKeywords };
    if (name === "./directory-event-client") return {
      directoryEventCache, setDirectoryEventQuery,
      scanDirectoryEvents: async (plan, signal, notify, retry) => { scans.push({ plan, signal, notify, retry }); },
    };
    if (name.endsWith(".css")) return {};
    return require(name);
  }, exports);
  const actions = [];
  const props = {
    plan: {
      format: "edf",
      recordings: Array.from({ length: count }, (_, index) => ({
        id: `session-${index}`, label: `session-${index}`, relativePath: `folder/session-${index}.edf`,
        // Reading bytes from any catalog entry must fail this test immediately.
        primary: { arrayBuffer() { throw new Error("Catalog attempted to read recording bytes"); } }, files: [],
      })),
      supportingFiles: [],
    },
    busy: false, statuses: {},
    onOpen: (recording) => actions.push(["open", recording.id]),
    onClose: () => actions.push(["close"]),
    onClear: () => actions.push(["clear"]),
    ...options,
  };
  return {
    props, actions, scans,
    get cache() { return directoryEventCache(props.plan); },
    render() {
      cursor = 0;
      const tree = exports.DirectorySessions(props);
      for (const effect of effects.splice(0)) effect();
      return tree;
    },
    unmount() { for (const hook of hooks) hook?.cleanup?.(); },
    button(tree, label) {
      const found = elements(tree, (node) => node.type === "button" && node.props["aria-label"] === label)[0];
      assert.ok(found, `find button ${label}`);
      return found;
    },
    rows(tree) { return elements(tree, (node) => node.type === "li" && node.props["data-recording-id"]); },
    input(tree) { return elements(tree, (node) => node.props?.id === "directory-event-query")[0]; },
    type(tree, query) { this.input(tree).props.onChange({ target: { value: query } }); },
    search(tree, query) { this.type(tree, query); this.button(this.render(), "Search event labels").props.onClick(); },
  };
}

function content(tree) {
  if (Array.isArray(tree)) return tree.map(content).join("");
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  return tree && typeof tree === "object" ? content(tree.props?.children) : "";
}

const ready = (...labels) => ({ state: "ready", labels, warnings: [] });

test("directory catalog renders at most 50 entries and paginates without reading recordings", () => {
  const ui = harness(123);
  let tree = ui.render();
  assert.equal(ui.rows(tree).length, 50);
  assert.equal(ui.rows(tree)[0].props["data-recording-id"], "session-0");
  assert.equal(ui.button(tree, "Previous sessions").props.disabled, true);
  ui.button(tree, "Next sessions").props.onClick();
  tree = ui.render();
  assert.equal(ui.rows(tree)[0].props["data-recording-id"], "session-50");
  ui.button(tree, "Next sessions").props.onClick();
  tree = ui.render();
  assert.equal(ui.rows(tree).length, 23);
  assert.equal(ui.rows(tree)[0].props["data-recording-id"], "session-100");
  assert.equal(ui.button(tree, "Next sessions").props.disabled, true);
  ui.button(tree, "Previous sessions").props.onClick();
  assert.equal(ui.rows(ui.render())[0].props["data-recording-id"], "session-50");
  const largeDirectory = harness(10_000);
  assert.equal(largeDirectory.rows(largeDirectory.render()).length, 50);
});

test("directory actions identify the exact recording and distinguish resume, retry, and confirmation", () => {
  const ui = harness(5, { statuses: {
    "session-1": { state: "loaded" },
    "session-2": { state: "confirmation" },
    "session-3": { state: "error", message: "Choose the matching MAT file." },
    "session-4": { state: "opening" },
  } });
  const tree = ui.render();
  for (const [index, label] of [[0, "Open"], [1, "Resume"], [2, "Resume"], [3, "Retry"]]) {
    const button = ui.button(tree, `${label} folder/session-${index}.edf`);
    assert.equal(button.props.disabled, false);
    button.props.onClick();
  }
  assert.deepEqual(ui.actions, [["open", "session-0"], ["open", "session-1"], ["open", "session-2"], ["open", "session-3"]]);
  assert.equal(ui.button(tree, "Opening… folder/session-4.edf").props.disabled, true);
  assert.ok(elements(tree, (node) => node.props?.children === "Choose the matching MAT file.").length);
});

test("busy directory blocks opening, clearing and dismissal, and keeps dialog semantics", () => {
  const ui = harness(3, { busy: true });
  const tree = ui.render();
  const dialog = elements(tree, (node) => node.props?.role === "dialog")[0];
  assert.equal(dialog.props["aria-modal"], "true");
  assert.equal(dialog.props["aria-labelledby"], "directory-sessions-heading");
  assert.equal(dialog.props.id, "directory-sessions-dialog");
  assert.ok(elements(tree, (node) => node.type === "button").every((button) => button.props.disabled));
  const backdrop = {};
  tree.props.onMouseDown({ target: backdrop, currentTarget: backdrop });
  assert.deepEqual(ui.actions, []);
  ui.props.busy = false;
  ui.render().props.onMouseDown({ target: backdrop, currentTarget: backdrop });
  assert.deepEqual(ui.actions, [["close"]]);
});

test("switching to a smaller catalog clamps its page to a valid range", () => {
  const ui = harness(150);
  ui.button(ui.render(), "Next sessions").props.onClick();
  ui.button(ui.render(), "Next sessions").props.onClick();
  ui.props.plan = { ...ui.props.plan, recordings: ui.props.plan.recordings.slice(0, 2) };
  const tree = ui.render();
  assert.equal(ui.rows(tree).length, 2);
  assert.equal(ui.rows(tree)[0].props["data-recording-id"], "session-0");
  assert.equal(elements(tree, (node) => node.props?.["aria-label"] === "Directory pages").length, 0);
});

test("project catalogs identify archives and explain missing embedded recordings without reading them", () => {
  const ui = harness(1);
  const project = ui.props.plan.recordings[0];
  project.relativePath = "folder/review.neurotrace";
  ui.props.plan.format = "neurotrace";
  const tree = ui.render();
  assert.ok(elements(tree, (node) => node.type === "strong" && node.props.children === "NeuroTrace project").length);
  const note = elements(tree, (node) => node.props?.className === "directory-sessions-note")[0];
  assert.match(note.props.children, /Nearby files are not added/);
  assert.match(note.props.children, /without recording data require the matching original recording/);
  ui.button(tree, "Open folder/review.neurotrace").props.onClick();
  assert.deepEqual(ui.actions, [["open", project.id]]);
});

test("search filters actual event text, not filenames, and clearing restores the whole catalog", () => {
  const ui = harness(4, { statuses: { "session-2": { state: "loaded" } } });
  Object.assign(ui.cache.entries, {
    "session-0": ready("Artifact"), "session-1": ready("Button press"),
    "session-2": ready("EEG Onset", "SZ end"), "session-3": ready(),
  });
  ui.props.plan.recordings[0].relativePath = "seizure.edf";
  ui.search(ui.render(), " Seizure, EEG onset ");
  let tree = ui.render();
  assert.deepEqual(ui.rows(tree).map((row) => row.props["data-recording-id"]), ["session-2"]);
  assert.match(content(ui.rows(tree)[0]), /Session 3/);
  assert.match(content(tree), /Events: EEG Onset/);
  ui.button(tree, "Resume folder/session-2.edf").props.onClick();
  assert.deepEqual(ui.actions, [["open", "session-2"]]);
  ui.button(tree, "Clear event label filter").props.onClick();
  assert.equal(ui.rows(ui.render()).length, 4);
  ui.search(ui.render(), "Not present");
  tree = ui.render();
  assert.equal(ui.rows(tree).length, 0);
  assert.match(content(tree), /No sessions contain these event-label keywords/);
});

test("ellipsis presets stage editable keywords until submitted and Escape closes the picker before the directory", () => {
  const ui = harness(2);
  ui.cache.entries["session-0"] = ready("SZ onset");
  ui.cache.entries["session-1"] = ready("Button press");
  let tree = ui.render();
  ui.button(tree, "Common event keywords").props.onClick();
  tree = ui.render();
  assert.equal(ui.button(tree, "Common event keywords").props["aria-expanded"], true);
  const presets = elements(tree, (node) => node.type === "button" && content(node).startsWith("Seizure"));
  assert.equal(presets.length, 1);
  presets[0].props.onClick();
  tree = ui.render();
  assert.equal(ui.button(tree, "Common event keywords").props["aria-expanded"], false);
  assert.equal(ui.rows(tree).length, 2, "choosing a preset does not apply it");
  assert.equal(ui.cache.query, "");
  assert.match(ui.input(tree).props.value, /seizure, seiz/);
  ui.button(tree, "Search event labels").props.onClick();
  tree = ui.render();
  assert.equal(ui.rows(tree).length, 1);
  assert.equal(ui.rows(tree)[0].props["data-recording-id"], "session-0");
  ui.button(tree, "Clear event label filter").props.onClick();
  ui.search(ui.render(), "button");
  assert.equal(ui.rows(ui.render())[0].props["data-recording-id"], "session-1");
  ui.button(ui.render(), "Common event keywords").props.onClick();
  tree = ui.render();
  let focused = false, prevented = false, stopped = false;
  ui.button(tree, "Common event keywords").props.ref.current = { focus() { focused = true; } };
  const row = elements(tree, (node) => node.props?.["data-shortcut-scope"] === "directory-keywords")[0];
  row.props.onKeyDown({ key: "Escape", preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.ok(focused && prevented && stopped);
  assert.deepEqual(ui.actions, []);
  assert.equal(ui.button(ui.render(), "Common event keywords").props["aria-expanded"], false);
  // The page's capture handler must let this local Escape reach the picker.
  assert.match(pageSource, /if \(event\.key === "Escape" && target\?\.closest\("\[data-shortcut-scope='directory-keywords'\]"\)\) return;/);
});

test("filtered pagination resets for a new query and keeps exact recording identities", () => {
  const ui = harness(151);
  for (let i = 0; i < 151; i++) ui.cache.entries[`session-${i}`] = ready(i % 2 ? "Seizure" : "Button");
  ui.button(ui.render(), "Next sessions").props.onClick();
  ui.button(ui.render(), "Next sessions").props.onClick();
  ui.search(ui.render(), "seizure");
  let tree = ui.render();
  assert.equal(ui.rows(tree).length, 50);
  assert.equal(ui.rows(tree)[0].props["data-recording-id"], "session-1");
  assert.match(content(tree), /Page 1 of 2/);
  ui.button(tree, "Next sessions").props.onClick();
  tree = ui.render();
  assert.equal(ui.rows(tree).length, 25);
  assert.equal(ui.rows(tree)[0].props["data-recording-id"], "session-101");
  ui.button(tree, "Open folder/session-101.edf").props.onClick();
  assert.deepEqual(ui.actions, [["open", "session-101"]]);
  ui.search(tree, "button");
  assert.equal(ui.rows(ui.render())[0].props["data-recording-id"], "session-0");
});

test("unchecked and partially checked sessions are explicit and can be included or retried", () => {
  const ui = harness(4);
  Object.assign(ui.cache.entries, {
    "session-0": ready("Button"),
    "session-1": { state: "partial", labels: ["Seizure"], warnings: ["Unreadable sidecar"] },
    "session-2": { state: "error", labels: [], warnings: ["Unsupported metadata"] },
  });
  ui.search(ui.render(), "seizure");
  let tree = ui.render();
  assert.deepEqual(ui.rows(tree).map((row) => row.props["data-recording-id"]), ["session-1"]);
  assert.match(content(tree), /Results are incomplete/);
  const checkbox = elements(tree, (node) => node.type === "input" && node.props.type === "checkbox")[0];
  checkbox.props.onChange({ target: { checked: true } });
  tree = ui.render();
  assert.deepEqual(ui.rows(tree).map((row) => row.props["data-recording-id"]), ["session-1", "session-2", "session-3"]);
  assert.match(content(tree), /Unsupported metadata/);
  const retry = elements(tree, (node) => node.type === "button" && content(node).startsWith("Retry 2"))[0];
  retry.props.onClick();
  ui.render();
  assert.deepEqual(Object.keys(ui.cache.entries), ["session-0", "session-1", "session-2"], "retry keeps prior labels visible while scanning");
  assert.equal(ui.scans.length, 2);
  assert.equal(ui.scans[1].retry, true);
  assert.ok(ui.scans[0].signal.aborted);
  ui.unmount();
});

test("scan effects stop on close or busy import and query survives reopening only its own catalog", () => {
  const ui = harness(2);
  ui.render();
  assert.equal(ui.scans.length, 1);
  ui.scans[0].notify("session-0");
  assert.match(content(ui.render()), /Checking event labels…/);
  ui.search(ui.render(), "Seizure");
  ui.props.busy = true;
  ui.render();
  assert.ok(ui.scans[0].signal.aborted);
  assert.equal(ui.scans.length, 1);
  ui.props.busy = false;
  ui.render();
  assert.equal(ui.scans.length, 2);
  ui.unmount();
  assert.ok(ui.scans[1].signal.aborted);
  const reopened = harness(0, { plan: ui.props.plan });
  assert.equal(reopened.input(reopened.render()).props.value, "");
  assert.ok(reopened.button(reopened.render(), "Remove keyword Seizure"));
  const other = harness(2);
  assert.equal(elements(other.render(), (node) => node.props?.id === "directory-event-query")[0].props.value, "");
  reopened.unmount(); other.unmount();
});

test("typing does not filter, reset pagination or persist draft; Enter commits removable deduplicated OR tags", () => {
  const ui = harness(110);
  for (let i = 0; i < 110; i++) ui.cache.entries[`session-${i}`] = ready(i % 2 ? "EEG Onset" : "Button");
  ui.button(ui.render(), "Next sessions").props.onClick();
  ui.type(ui.render(), "  EEG onset, eeg ONSET, , ");
  let tree = ui.render();
  assert.match(content(tree), /Page 2 of 3/);
  assert.equal(ui.rows(tree).length, 50);
  assert.equal(ui.cache.query, "");
  let prevented = false, stopped = false;
  const enter = { key: "Enter", nativeEvent: { isComposing: true }, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } };
  ui.input(tree).props.onKeyDown(enter);
  assert.equal(ui.cache.query, "", "IME confirmation must not prematurely apply a tag");
  enter.nativeEvent = { isComposing: false, keyCode: 229 };
  ui.input(tree).props.onKeyDown(enter);
  assert.equal(ui.cache.query, "");
  enter.nativeEvent = { isComposing: false, keyCode: 13 };
  ui.input(tree).props.onKeyDown(enter);
  tree = ui.render();
  assert.ok(prevented && stopped);
  assert.equal(ui.cache.query, "EEG onset");
  assert.equal(ui.input(tree).props.value, "");
  assert.match(content(tree), /Page 1 of 2/);
  assert.equal(ui.rows(tree)[0].props["data-recording-id"], "session-1");
  assert.ok(ui.button(tree, "Remove keyword EEG onset"));
  assert.equal(ui.button(tree, "Search event labels").props.disabled, true);
  ui.type(tree, "not yet applied");
  assert.equal(ui.cache.query, "EEG onset");
  ui.search(ui.render(), "Button, EEG ONSET");
  tree = ui.render();
  assert.equal(ui.cache.query, "EEG onset, Button");
  assert.equal(ui.rows(tree)[0].props["data-recording-id"], "session-0");
  ui.button(tree, "Remove keyword EEG onset").props.onClick();
  assert.equal(ui.cache.query, "Button");
  ui.button(ui.render(), "Remove keyword Button").props.onClick();
  assert.equal(ui.cache.query, "");
  assert.match(content(ui.render()), /110 of 110 sessions shown/);
  ui.type(ui.render(), ", ,  ");
  assert.equal(ui.button(ui.render(), "Search event labels").props.disabled, true);
  ui.button(ui.render(), "Clear event label filter").props.onClick();
  assert.equal(ui.input(ui.render()).props.value, "");
  assert.equal(ui.scans.length, 1, "editing tags never restarts file indexing");
  ui.unmount();
});
