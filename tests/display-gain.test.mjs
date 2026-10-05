import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { MAX_DISPLAY_GAIN, MIN_DISPLAY_GAIN, normalizeDisplayGain, stepDisplayGain } from "../app/display-gain.ts";
import { DEFAULT_CONTROLS, matchesShortcut, shortcutHint } from "../app/shortcuts.ts";

test("display gain accepts exact values across 0.01–4 and bounds old saved gains", () => {
  for (const value of [0.01, 0.015, 0.1, 0.73, 1, 3.99, 4]) assert.equal(normalizeDisplayGain(value), value);
  for (const value of [-1, 0, 0.001]) assert.equal(normalizeDisplayGain(value), 0.01);
  for (const value of [4.1, 8, 100]) assert.equal(normalizeDisplayGain(value), 4);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(normalizeDisplayGain(value, 0.73), 0.73);
    assert.equal(normalizeDisplayGain(value), 1);
  }
});

test("gain buttons reach both bounds without getting stuck or floating-point noise", () => {
  assert.equal(stepDisplayGain(1, 1), 1.25);
  assert.equal(stepDisplayGain(1, -1), 0.8);
  assert.equal(stepDisplayGain(0.01, 1), 0.02);
  for (const [start, direction, end] of [[0.01, 1, 4], [4, -1, 0.01]]) {
    let value = start;
    for (let iteration = 0; iteration < 100; iteration++) {
      const next = stepDisplayGain(value, direction);
      assert.ok(next >= MIN_DISPLAY_GAIN && next <= MAX_DISPLAY_GAIN);
      assert.ok(value === end || (next - value) * direction > 0);
      assert.equal(next, Number(next.toFixed(2)));
      value = next;
    }
    assert.equal(value, end);
  }
});

// Run the real toolbar JSX and handlers without opening a browser or loading patient data.
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let commit, toolbar;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(syntax) === "commitGainInput") commit = node.getText(syntax);
  if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some((attribute) => attribute.getText(syntax) === 'className="gain-control"')) toolbar = node.getText(syntax);
  ts.forEachChild(node, visit);
}
visit(syntax);
assert.ok(commit && toolbar);
const code = ts.transpileModule(`const ${commit}; const toolbar = ${toolbar};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
}).outputText;
function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return tree?.props ? [tree, ...elements(tree.props.children)] : [];
}
function control(gain = 1, overrides = {}) {
  const changes = [];
  const scope = {
    exports: {}, require: createRequire(import.meta.url), gain, hasRecording: true, activeSessionId: "a", sessionKey: "recording-a",
    MIN_DISPLAY_GAIN, MAX_DISPLAY_GAIN, normalizeDisplayGain, stepDisplayGain, matchesShortcut, shortcutHint,
    controlBindings: DEFAULT_CONTROLS, readZoomView: () => ({ gain }),
    changeZoomView: (patch) => changes.push(patch), ...overrides,
  };
  const tree = new Function(...Object.keys(scope), `${code}; return toolbar;`)(...Object.values(scope));
  const nodes = elements(tree);
  const props = nodes.find((node) => node.type === "input").props;
  const input = { value: String(props.defaultValue), blur() { props.onBlur({ currentTarget: input }); } };
  return {
    changes, props, input, tree,
    button(label) { return nodes.find((node) => node.props["aria-label"] === label).props; },
    press(key, modifiers = {}) {
      const event = { key, currentTarget: input, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...modifiers };
      props.onKeyDown(event);
      return event;
    },
  };
}

test("typed gain commits on Enter or blur, including exact limits and intermediate values", () => {
  for (const [entry, expected] of [[".01", 0.01], ["0.015", 0.015], [".73", 0.73], ["4", 4], ["8", 4], ["0", 0.01]]) {
    const ui = control();
    ui.input.value = entry;
    assert.deepEqual(ui.changes, [], "typing alone does not change waveform or history");
    const event = ui.press("Enter");
    assert.equal(event.stopped, true);
    assert.deepEqual(ui.changes, [{ gain: expected }]);
    assert.equal(ui.input.value, String(expected));
  }
  const ui = control();
  ui.input.value = "0.27"; ui.input.blur();
  assert.deepEqual(ui.changes, [{ gain: 0.27 }]);
});

test("blank/invalid drafts retain gain; cancel stops propagation and discards the draft", () => {
  for (const entry of ["", " ", "no", "Infinity"]) {
    const ui = control(0.73);
    ui.input.value = entry; ui.input.blur();
    assert.deepEqual(ui.changes, [{ gain: 0.73 }]);
    assert.equal(ui.input.value, "0.73");
  }
  const ui = control(0.73);
  ui.input.value = "4";
  const event = ui.press("Escape");
  assert.equal(event.stopped, true, "cancel must not also clear viewer selections");
  assert.equal(event.prevented, true);
  assert.deepEqual(ui.changes, [{ gain: 0.73 }]);
});

test("gain apply/cancel follow remaps and native text undo is untouched", () => {
  const ui = control(1, { controlBindings: { ...DEFAULT_CONTROLS, gainApply: ["Alt+Enter"], clear: ["Alt+x"] } });
  ui.input.value = "0.01";
  assert.equal(ui.press("Enter").prevented, undefined);
  assert.equal(ui.press("z", { metaKey: true }).prevented, undefined);
  assert.deepEqual(ui.changes, []);
  ui.press("Enter", { altKey: true });
  assert.deepEqual(ui.changes, [{ gain: 0.01 }]);
  ui.input.value = "4";
  assert.equal(ui.press("x", { altKey: true }).stopped, true);
  assert.equal(ui.input.value, "1");
});

test("gain controls disable at endpoints and reset their draft on gain/session changes", () => {
  const low = control(0.01), high = control(4), empty = control(1, { hasRecording: false });
  assert.equal(low.props.defaultValue, 0.01, "minimum is not rounded to 0.0");
  assert.equal(low.button("Decrease gain").disabled, true);
  assert.equal(low.button("Increase gain").disabled, false);
  assert.equal(high.button("Increase gain").disabled, true);
  assert.equal(high.button("Decrease gain").disabled, false);
  assert.ok(empty.props.disabled && empty.button("Increase gain").disabled && empty.button("Decrease gain").disabled);
  const inputKey = (ui) => elements(ui.tree).find((node) => node.type === "input").key;
  assert.notEqual(inputKey(low), inputKey(high), "undo/redo replaces stale input drafts");
  assert.notEqual(inputKey(low), inputKey(control(0.01, { activeSessionId: "b" })));
  assert.notEqual(inputKey(low), inputKey(control(0.01, { sessionKey: "recording-b" })));
});

test("restored sessions and imported workspaces use the same gain bounds", () => {
  assert.match(page, /setGain\(normalizeDisplayGain\(snapshot\.gain\)\)/);
  assert.match(page, /setGain\(normalizeDisplayGain\(workspace\.gain\)\)/);
});
