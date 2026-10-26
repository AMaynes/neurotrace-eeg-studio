import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { formatClock } from "../app/eeg-core.ts";
import { parseRecordingTimestamp } from "../app/recording-timestamp.ts";

test("timestamps accept elapsed seconds and clocks, including fractions and long recordings", () => {
  for (const [text, seconds] of [
    ["0", 0], ["90.5", 90.5], [".5", 0.5], ["01:30.5", 90.5],
    ["00:01:30.5", 90.5], [" 02:03:04.125 ", 7384.125],
    ["90:00", 5400], ["100:00:00", 360000], ["0:00:00.001", 0.001],
  ]) assert.equal(parseRecordingTimestamp(text), seconds, text);
});

test("malformed, negative, overflowing, and ambiguous timestamps are rejected", () => {
  for (const text of ["", " ", "-1", "-00:01", "1e3", "0x10", "NaN", "Infinity",
    "1:60", "1:00:60.1", "1:60:00", "1.5:00", "1::2", ":30", "30:",
    "1:2:3:4", "12 seconds", "00: 10", "9".repeat(400)]) {
    assert.equal(parseRecordingTimestamp(text), null, text);
  }
});

// Exercise the actual toolbar form and navigation callback, following the page's
// existing focused interaction tests without mounting unrelated recording tools.
const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let form, jump;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(syntax) === "jumpTo") jump = node.initializer;
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(syntax) === "form"
    && node.openingElement.attributes.properties.some((prop) => ts.isJsxAttribute(prop)
      && prop.name.getText(syntax) === "className" && prop.initializer?.getText(syntax) === '"timestamp-jump"')) form = node;
  ts.forEachChild(node, visit);
}
visit(syntax);
assert.ok(form);
assert.ok(jump);
const require = createRequire(import.meta.url);
function evaluate(node, scope) {
  const compiled = ts.transpileModule(`const result = (${node.getText(syntax)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  return new Function(...Object.keys(scope), "require", "exports", `${compiled}\nreturn result;`)(...Object.values(scope), require, {});
}

function toolbar({ hasRecording = true, durationSec = 600, timebase = 20 } = {}) {
  const state = { viewStart: 0, cursor: 0, playing: true, locked: false, toast: "", actions: [] };
  const scope = {
    activeSessionId: "session", sessionKey: "recording", hasRecording,
    meta: { durationSec }, timebase, parseRecordingTimestamp, formatClock,
    useCallback: (callback) => callback, clamp: (n, min, max) => Math.min(max, Math.max(min, n)),
    commitViewStart: (value) => { state.viewStart = value; },
    setCursorTime: (value) => { state.cursor = value; },
    setPlaying: (value) => { state.playing = value; },
    setCursorLocked: (value) => { state.locked = value; },
    setToast: (value) => { state.toast = value; },
    notifyTutorialAction: (value) => state.actions.push(value),
  };
  scope.jumpTo = evaluate(jump, scope);
  const tree = evaluate(form, scope);
  const inputProps = tree.props.children[0].props.children[1].props;
  const buttonProps = tree.props.children[1].props;
  return { state, inputProps, buttonProps, submit(value) {
    const input = { value, error: "", reported: false,
      setCustomValidity(message) { this.error = message; }, reportValidity() { this.reported = true; } };
    tree.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => input } } });
    return input;
  } };
}

test("submitting a timestamp pauses, pins the cursor, and centers without changing the window length", () => {
  const ui = toolbar();
  assert.equal(ui.buttonProps.type, "submit", "Enter and Go both use the form submission");
  assert.equal(ui.inputProps.required, true);
  assert.equal(ui.submit("01:30.5").error, "");
  assert.deepEqual(ui.state, { viewStart: 80.5, cursor: 90.5, playing: false, locked: true,
    toast: "Jumped to 00:01:30.500 from recording start", actions: ["transport-used"] });
});

test("jumps at recording boundaries keep the view inside the recording", () => {
  for (const [text, cursor, viewStart] of [["0", 0, 0], ["00:10:00", 600, 580], ["599.9", 599.9, 580]]) {
    const ui = toolbar();
    assert.equal(ui.submit(text).error, "");
    assert.equal(ui.state.cursor, cursor);
    assert.equal(ui.state.viewStart, viewStart);
  }
  const short = toolbar({ durationSec: 5 });
  short.submit("4.5");
  assert.equal(short.state.viewStart, 0);
  assert.equal(short.state.cursor, 4.5);
});

test("invalid and out-of-recording timestamps report an error without moving or pausing", () => {
  for (const text of ["", "-1", "1:60", "00:10:00.001"]) {
    const ui = toolbar();
    const before = { ...ui.state, actions: [] };
    const input = ui.submit(text);
    assert.ok(input.error);
    assert.equal(input.reported, true);
    assert.deepEqual(ui.state, before);
    ui.inputProps.onChange({ currentTarget: input });
    assert.equal(input.error, "", "editing permits a corrected submission");
  }
});

test("timestamp navigation stays disabled until a recording is loaded", () => {
  const ui = toolbar({ hasRecording: false });
  assert.equal(ui.inputProps.disabled, true);
  assert.equal(ui.buttonProps.disabled, true);
  ui.submit("1");
  assert.equal(ui.state.playing, true);
  assert.equal(ui.state.cursor, 0);
});
