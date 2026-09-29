import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

// Execute the actual component with a minimal state hook; no file bytes or browser are needed.
const componentSource = await readFile(new URL("../app/directory-sessions.tsx", import.meta.url), "utf8");
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
  let page = 0;
  const exports = {};
  new Function("require", "exports", compiled)((name) => {
    if (name === "react") return { useState: () => [page, (value) => { page = value; }] };
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
    props, actions,
    render: () => exports.DirectorySessions(props),
    button(tree, label) {
      const found = elements(tree, (node) => node.type === "button" && node.props["aria-label"] === label)[0];
      assert.ok(found, `find button ${label}`);
      return found;
    },
    rows(tree) { return elements(tree, (node) => node.type === "li" && node.props["data-recording-id"]); },
  };
}

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
