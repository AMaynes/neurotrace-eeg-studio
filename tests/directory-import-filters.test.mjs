/*
Purpose: Checks directory import filters behavior with deterministic fixtures and controlled runtime boundaries.
File Dependencies: app/directory-event-client.ts, app/directory-import-filters.tsx, app/event-keywords.ts.
*/


import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { directoryEventCache, filterDirectoryPlan } from "../app/directory-event-client.ts";
import { COMMON_EVENT_KEYWORDS, eventKeywordPresetState, eventKeywords } from "../app/event-keywords.ts";

const source = await readFile(new URL("../app/directory-import-filters.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const require = createRequire(import.meta.url);
const tick = () => new Promise(resolve => setImmediate(resolve));
const text = tree => Array.isArray(tree) ? tree.map(text).join("") : typeof tree === "string" || typeof tree === "number" ? String(tree) : text(tree?.props?.children ?? []);
function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate));
  if (!tree?.props) return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props.children, predicate)];
}
function harness(mode = "update", scan = async () => {}) {
  let cursor = 0, dirty = false;
  const hooks = [], effects = [], actions = [], scans = [], exports = {};
  new Function("require", "exports", code)(name => {
    if (name === "react") return {
      useState(initial) {
        const index = cursor++;
        if (!(index in hooks)) hooks[index] = initial;
        return [hooks[index], value => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; dirty = true; }];
      },
      useRef(initial) { return hooks[cursor++] ??= { current: initial }; },
      useEffect(effect, dependencies) {
        const index = cursor++, prior = hooks[index];
        if (!prior || dependencies.some((value, i) => value !== prior.dependencies[i])) {
          hooks[index] = { dependencies };
          effects.push(() => { prior?.cleanup?.(); hooks[index].cleanup = effect(); });
        }
      },
    };
    if (name === "./directory-event-client") return { directoryEventCache, filterDirectoryPlan,
      scanDirectoryEvents: (...args) => { scans.push(args); return scan(...args); } };
    if (name === "./event-keywords") return { COMMON_EVENT_KEYWORDS, eventKeywordPresetState, eventKeywords };
    if (name.endsWith(".css")) return {};
    return require(name);
  }, exports);
  const plan = { format: "edf", supportingFiles: [], recordings: ["seizure", "sleep", "spike"].map(id => ({ id, relativePath: `${id}.edf` })) };
  for (const { id } of plan.recordings) directoryEventCache(plan).entries[id] = { state: "ready", labels: [id], warnings: [] };
  const props = { plan, mode, busy: false, onLoad: value => actions.push(value) };
  const ui = { props, actions, scans,
    render() {
      let tree;
      for (let attempts = 0; attempts < 10; attempts++) {
        cursor = 0; dirty = false; tree = exports.DirectoryImportFilters(props);
        if (!dirty) break;
      }
      assert.equal(dirty, false, "component settles after a plan change");
      for (const effect of effects.splice(0)) effect();
      return tree;
    },
    button(name) { return nodes(ui.render(), node => node.type === "button" && text(node) === name)[0]; },
    input() { return nodes(ui.render(), node => node.type === "input")[0]; },
    type(value) { ui.input().props.onChange({ target: { value } }); },
    open() { ui.button(mode === "update" ? "Change folder filters" : "Add filters").props.onClick(); },
  };
  return ui;
}

test("loaded-folder filters apply in one action and do not change the list while typing", async () => {
  const ui = harness();
  assert.equal(ui.button("Apply to folder"), undefined);
  ui.open(); ui.type("seizure");
  assert.equal(ui.button("Apply filters"), undefined, "no second preview-only Apply action");
  assert.deepEqual(ui.actions, []);
  ui.button("Apply to folder").props.onClick(); await tick();
  assert.deepEqual(ui.actions[0].recordings.map(item => item.id), ["seizure"]);
  assert.equal(ui.actions[0].eventKeywordFilter, "seizure");
  assert.equal(ui.scans[0][3], true, "explicit apply retries incomplete metadata checks");
});

test("common keyword presets are selectable in both folder entry points", async () => {
  for (const mode of ["load", "update"]) {
    const ui = harness(mode);
    ui.open();
    assert.equal(ui.button("Seizure / Sz / Seiz"), undefined);
    ui.button("Common keywords").props.onClick();
    assert.equal(ui.button("Common keywords").props["aria-expanded"], true);
    ui.type("EEG ONSET, custom");
    ui.button("Seizure / Sz / Seiz").props.onClick();
    assert.equal(ui.button("Seizure / Sz / Seiz").props["aria-pressed"], true);
    assert.equal(ui.input().props.value, "EEG ONSET, custom, sz, seizure, seiz, tonic");
    ui.button("Sleep").props.onClick();
    ui.button("Sleep").props.onClick();
    assert.equal(ui.button("Sleep").props["aria-pressed"], false);
    ui.button("Spikes / sharp waves").props.onClick();
    ui.button("Common keywords").props.onClick();
    assert.equal(ui.button("Seizure / Sz / Seiz"), undefined);
    assert.deepEqual(ui.scans, [], "choosing presets edits the query without starting a scan");
    ui.button(mode === "load" ? "Load matching sessions" : "Apply to folder").props.onClick();
    await tick();
    assert.equal(ui.actions[0].eventKeywordFilter, "EEG ONSET, custom, sz, seizure, seiz, tonic, spike, sharp");
    assert.deepEqual(ui.actions[0].recordings.map(item => item.id), ["seizure", "spike"]);
  }
});

test("Enter applies zero matches and clearing the query restores the full folder", async () => {
  const ui = harness(); ui.open(); ui.type("unmatched");
  ui.input().props.onKeyDown({ key: "Enter", preventDefault() {} }); await tick();
  assert.equal(ui.actions[0].recordings.length, 0);
  const filtered = ui.actions[0];
  ui.props.plan = { ...filtered, recordings: [...filtered.unfilteredRecordings] };
  assert.match(text(ui.render()), /0 of 3 sessions match/);
  ui.type(""); ui.button("Apply to folder").props.onClick(); await tick();
  assert.equal(ui.actions.at(-1).recordings.length, 3);
  assert.equal(ui.actions.at(-1).eventKeywordFilter, undefined);
});

test("removing a filter restores all recordings and closes its editor", async () => {
  const ui = harness(); ui.open(); ui.type("spike");
  ui.button("Apply to folder").props.onClick(); await tick();
  const filtered = ui.actions[0];
  ui.props.plan = { ...filtered, recordings: [...filtered.unfilteredRecordings] };
  ui.button("Remove filters").props.onClick();
  assert.equal(ui.actions.at(-1).recordings.length, 3);
  assert.equal(ui.actions.at(-1).eventKeywordFilter, undefined);
  assert.equal(ui.input(), undefined);
});

test("initial folder loading still previews matches before opening recordings", async () => {
  const ui = harness("load"); ui.open(); ui.type("seizure, spike");
  ui.button("Apply filters").props.onClick(); await tick();
  assert.deepEqual(ui.actions, []);
  ui.button("Load 2 sessions").props.onClick();
  assert.deepEqual(ui.actions[0].recordings.map(item => item.id), ["seizure", "spike"]);
});

test("canceling a label check ignores late results and leaves the folder unchanged", async () => {
  let finish;
  const ui = harness("update", () => new Promise(resolve => { finish = resolve; }));
  ui.open(); ui.type("seizure"); ui.button("Apply to folder").props.onClick();
  assert.equal(ui.input().props.disabled, true);
  ui.button("Cancel check").props.onClick(); finish(); await tick();
  assert.deepEqual(ui.actions, []);
  assert.equal(ui.input().props.disabled, false);
});

test("a failed label check reports its error and allows retry", async () => {
  let fail = true;
  const ui = harness("update", async () => { if (fail) throw new Error("Read failed"); });
  ui.open(); ui.type("seizure"); ui.button("Apply to folder").props.onClick(); await tick();
  assert.match(text(ui.render()), /Read failed/);
  assert.equal(ui.input().props.disabled, false);
  assert.deepEqual(ui.actions, []);
  fail = false; ui.button("Apply to folder").props.onClick(); await tick();
  assert.equal(ui.actions[0].recordings.length, 1);
});
