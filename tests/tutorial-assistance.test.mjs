import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// Execute the actual page-owned command handler without file, annotation, or save APIs.
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
function find(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(syntax) === "assistTutorial") handler = node.initializer.getText(syntax);
  ts.forEachChild(node, find);
}
find(syntax);
assert.ok(handler);
const compiled = ts.transpileModule(`const assistTutorial = ${handler};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture(overrides = {}) {
  const changes = [];
  const click = [];
  const buttons = new Map();
  const values = { gain: 1, labelsVisible: true };
  const state = {
    showEphysLabelPicker: false, showSettings: false, showChannels: false, showImport: false,
    showProjectSave: false, showSessionMap: false, showPatientInfo: false, showAnnotationEditor: false,
    queueDetailEntry: null, confirmCommit: [], hasRecording: true, activeSessionContentView: "recording",
    meta: { durationSec: 90 }, viewStartRef: { current: 0 }, viewStart: 0, timebase: 20,
    minimumRenderableWindow: 0.01, boxZoomActive: false, reviewReady: true, display: { data: [new Float32Array(10)] },
    document: { querySelector: (selector) => buttons.get(selector) ?? null },
    ...overrides,
  };
  for (const name of ["setShowImport", "setProjectSaveError", "setShowProjectSave", "setPlaying", "setViewStartSafe",
    "setLeftPanelOpen", "selectRightPanelTool", "setBottomTracksOpen", "setTimeWindow", "setWindowDraftValue",
    "setShowChannels", "setGain", "setShowFilters", "setSpectrogramOpen", "setChannelSelectionActive",
    "setBoxZoomActive", "setActiveTool", "setMarkOnset", "setSelection", "setCursorTime", "setCursorLocked",
    "setShowEphysLabelPicker", "setShowSessionContextPicker", "setLabelsVisible"]) {
    state[name] = (value) => changes.push([name, typeof value === "function" ? value(values[name === "setGain" ? "gain" : "labelsVisible"]) : value]);
  }
  const assist = new Function(...Object.keys(state), `${compiled}\nreturn assistTutorial;`)(...Object.values(state));
  return {
    assist, changes, click, values,
    button(anchor, disabled = false) { buttons.set(`button[data-tutorial="${anchor}"]`, { disabled, getClientRects: () => [{}], click: () => click.push(anchor) }); },
  };
}

test("assistance opens dialogs without any loading/saving side effects or hidden choices", () => {
  const ui = fixture({ hasRecording: false });
  assert.equal(ui.assist("open-import"), true);
  assert.deepEqual(ui.changes, [["setShowImport", true]]);
  ui.changes.length = 0;
  assert.equal(ui.assist("open-save"), true);
  assert.deepEqual(ui.changes, [["setProjectSaveError", ""], ["setShowProjectSave", true]]);
});

test("assistance cannot operate behind another dialog, in file-structure view, or without a recording", () => {
  for (const override of [{ showSettings: true }, { hasRecording: false }, { activeSessionContentView: "structure" }]) {
    const ui = fixture(override);
    assert.equal(ui.assist("select-time-window"), false);
    assert.equal(ui.assist("increase-gain"), false);
    assert.deepEqual(ui.changes, []);
  }
  const alreadyOpen = fixture({ showImport: true });
  assert.equal(alreadyOpen.assist("open-import"), true);
  assert.equal(alreadyOpen.assist("open-save"), false);
  assert.deepEqual(alreadyOpen.changes, []);
});

test("navigation assistance respects recording boundaries and does not start playback", () => {
  const ui = fixture();
  assert.equal(ui.assist("pan-waveform"), true);
  assert.deepEqual(ui.changes, [["setPlaying", false], ["setViewStartSafe", 1]]);
  const end = fixture({ viewStartRef: { current: 70 } });
  assert.equal(end.assist("page-forward"), true);
  assert.deepEqual(end.changes, [["setPlaying", false], ["setViewStartSafe", 50]]);
  const wholeFile = fixture({ timebase: 90 });
  assert.equal(wholeFile.assist("page-forward"), false);
  assert.deepEqual(wholeFile.changes, []);
});

test("example selections are bounded, validation-gated, and create no annotation", () => {
  const blocked = fixture({ reviewReady: false });
  assert.equal(blocked.assist("select-time-window"), false);
  assert.deepEqual(blocked.changes, []);
  const ui = fixture();
  assert.equal(ui.assist("select-time-window"), true);
  assert.deepEqual(ui.changes.find(([key]) => key === "setSelection"), ["setSelection", { start: 5, end: 15 }]);
  assert.ok(ui.changes.some(([key, value]) => key === "setBoxZoomActive" && value === false));
  assert.equal(ui.assist("open-session-label-picker"), true);
  assert.deepEqual(ui.changes.at(-1), ["setShowSessionContextPicker", true]);
});

test("safe button assistance uses existing handlers, rejects missing/disabled controls, and is idempotent for modes", () => {
  const ui = fixture();
  assert.equal(ui.assist("spectrogram-browse"), false);
  ui.button("spectrogram-browse", true);
  assert.equal(ui.assist("spectrogram-browse"), false);
  ui.button("spectrogram-browse");
  assert.equal(ui.assist("spectrogram-browse"), true);
  assert.deepEqual(ui.click, ["spectrogram-browse"]);
  const zoomed = fixture({ boxZoomActive: true });
  assert.equal(zoomed.assist("enable-waveform-zoom"), true);
  assert.deepEqual(zoomed.click, []);
});

test("zoom assistance preserves the center and refuses to falsely complete at minimum zoom", () => {
  const ui = fixture();
  assert.equal(ui.assist("zoom-waveform"), true);
  assert.deepEqual(ui.changes, [["setPlaying", false], ["setTimeWindow", 10], ["setWindowDraftValue", null]]);
  const minimum = fixture({ timebase: 0.01 });
  assert.equal(minimum.assist("zoom-waveform"), false);
  assert.deepEqual(minimum.changes, []);
});
