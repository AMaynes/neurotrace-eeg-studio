import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { recordZoomChange, sameZoomView } from "../app/zoom-history.ts";
import { composeVerticalViewport, projectVerticalFraction } from "../app/waveform-viewport.ts";
import { DEFAULT_CONTROLS, shortcutAction } from "../app/shortcuts.ts";
import { normalizeDisplayGain } from "../app/display-gain.ts";
import { buildChannelRowLayout, channelPlotGeometry, channelRowFromFraction, channelGroupOrder, matlabDisplayGroup, orderGroupedDisplayRows, remapDisplayFocus } from "../app/channel-layout.ts";
import { bipolarMontageKind } from "../app/bipolar-montage.ts";

const initialView = () => ({
  viewStart: 30, timebase: 20, gain: 1, verticalViewport: null,
  expandedChannels: false, channelScrollTop: 0, frequencyRange: { min: 0, max: 100 },
});

test("wheel frames form one zoom entry; pauses, other controls, edits, and panning break the group", () => {
  const undo = [], redo = [], gesture = {};
  const before = initialView();
  const first = { ...before, timebase: 19.9 };
  const second = { ...before, timebase: 19.8 };
  recordZoomChange(undo, redo, before, first, gesture, "wheel", 0);
  recordZoomChange(undo, redo, first, second, gesture, "wheel", 50);
  assert.equal(undo.length, 1);
  assert.deepEqual(undo[0], { kind: "zoom", before, after: second });
  const third = { ...before, timebase: 19.7 };
  recordZoomChange(undo, redo, second, third, gesture, "wheel", 400);
  assert.equal(undo.length, 2, "a new pinch after a pause is separate");
  const fourth = { ...third, gain: 2 };
  recordZoomChange(undo, redo, third, fourth, gesture, undefined, 420);
  recordZoomChange(undo, redo, fourth, { ...fourth, timebase: 19.6 }, gesture, "wheel", 430);
  assert.equal(undo.length, 4, "a toolbar change ends a pinch");
  undo.push({ annotations: [] });
  recordZoomChange(undo, redo, fourth, third, gesture, "wheel", 440);
  assert.equal(undo.length, 6, "annotation edits must remain between zooms");
  recordZoomChange(undo, redo, { ...third, viewStart: 40 }, fourth, gesture, "wheel", 450);
  assert.equal(undo.length, 7, "panning cannot be folded into an earlier pinch");
});

test("no-op controls preserve redo and the shared history stays bounded", () => {
  const undo = [], redo = [{ annotations: ["redo"] }], gesture = {};
  const before = initialView();
  assert.ok(sameZoomView(before, structuredClone(before)));
  assert.equal(recordZoomChange(undo, redo, before, structuredClone(before), gesture), false);
  assert.equal(redo.length, 1);
  for (let index = 0; index < 130; index++) {
    recordZoomChange(undo, redo, { ...before, timebase: index + 1 }, { ...before, timebase: index + 2 }, gesture);
  }
  assert.equal(undo.length, 100);
  assert.equal(redo.length, 0);
  assert.equal(undo[0].before.timebase, 31);
});

// Execute the actual page handlers, with React and browser state only as boundaries.
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name) {
  let result;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(syntax) === name) result = `const ${node.getText(syntax)};`;
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  assert.ok(result, `${name} exists`);
  return result;
}
function compile(source, scope, result) {
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(scope), `${compiled}\nreturn ${result};`)(...Object.values(scope));
}

function workspace(overrides = {}) {
  const refs = {
    zoomViewRef: { current: initialView() }, viewStartRef: { current: 30 },
    undoRef: { current: [] }, redoRef: { current: [] }, zoomGestureRef: { current: {} },
    annotationsRef: { current: [] }, candidatesRef: { current: [] }, activeCandidateIndexRef: { current: 0 },
    sourceVerificationRef: { current: false }, channelScrollOffsetRef: { current: 0 },
    waveformScrollRef: { current: null }, pendingZoomScrollRef: { current: null },
    zoomWheelFrameRef: { current: null }, wheelFrameRef: { current: null }, cursorFrameRef: { current: null },
    channelScrollFrameRef: { current: null },
    zoomWheelDeltaRef: { current: 0 }, wheelDeltaRef: { current: 0 },
    pointerRef: { current: null }, pendingCursorRef: { current: null },
  };
  const changes = [], canceled = [];
  const scope = {
    ...refs, recordZoomChange, normalizeDisplayGain, orderGroupedDisplayRows, remapDisplayFocus, useCallback: (callback) => callback,
    anatomicalGroups: false, channelGroupingMode: "matlab", preparedDisplay: null, display: null, focusedChannel: 0,
    hasRecording: true, meta: { durationSec: 300 }, minimumRenderableWindow: 0.1,
    timebase: 20, WINDOW_ZOOM_STEP_SECONDS: 0.1,
    clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
    quantizeWindowZoom: (value) => Number((Math.round(value / 0.1) * 0.1).toFixed(10)),
    commitViewStart: (value) => { refs.viewStartRef.current = value; },
    window: { cancelAnimationFrame: (id) => canceled.push(id) },
    notifyTutorialAction: () => {}, ...overrides,
  };
  for (const name of ["setPlaying", "setTimebase", "setWindowDraftValue", "setGain", "setWaveformVerticalViewport",
    "setExpandedChannels", "setAnatomicalGroups", "setFocusedChannel", "setChannelSelectionActive", "setSpectrogramFrequencyRange", "setInspectionRange", "setInspectionDragging",
    "setAnnotations", "setCandidates", "setActiveCandidate", "setSelectedAnnotationId", "setSelectedAnnotationIds", "setToast"]) {
    scope[name] = (value) => changes.push([name, value]);
  }
  const names = ["readZoomView", "cancelPendingViewFrames", "applyZoomView", "changeZoomView", "setTimeWindow", "zoomToTimeRange", "zoomTimeWindow", "commitMutation", "undo", "redo"];
  const api = compile(names.map(declaration).join("\n"), scope, `{${names.join(",")}}`);
  return { ...api, refs, scope, changes, canceled };
}

test("real grouping memo and toggle preserve focus and restore exactly the original prepared display", () => {
  const labels = ["RA10", "LA3", "RA2", "LA1", "ECG1"];
  const preparedDisplay = { labels,
    data: labels.map((_, i) => new Float64Array([i, i + .5])),
    traceBaselines: labels.map((_, i) => i), envelopes: labels.map(() => null),
    sampleRates: labels.map(() => 100), sourceSampleRates: labels.map(() => 200),
    startSecs: labels.map(() => .005), units: labels.map(() => "uV"),
    sourceIndices: labels.map((_, i) => [i]), primarySourceIndices: labels.map((_, i) => i) };
  const render = (anatomicalGroups) => compile(declaration("display"), { useMemo: (fn) => fn(), anatomicalGroups, channelGroupingMode: "matlab", preparedDisplay, orderGroupedDisplayRows }, "display");
  const grouped = render(true);
  assert.deepEqual(grouped.labels, ["LA3", "LA1", "RA10", "RA2"]);
  assert.equal(render(false), preparedDisplay, "off restores the same object and sample buffers");
  for (const [enabled, focusedChannel, expectedFocus] of [[true, 0, 2], [false, 2, 0], [true, 4, 0]]) {
    const ui = workspace({ anatomicalGroups: !enabled, preparedDisplay, display: enabled ? preparedDisplay : grouped, focusedChannel });
    ui.refs.zoomViewRef.current = { ...initialView(), anatomicalGroups: !enabled };
    ui.changeZoomView({ anatomicalGroups: enabled, verticalViewport: null, channelScrollTop: 0 });
    assert.ok(ui.changes.some(([name, value]) => name === "setAnatomicalGroups" && value === enabled));
    assert.ok(ui.changes.some(([name, value]) => name === "setFocusedChannel" && value === expectedFocus));
    assert.equal(ui.changes.some(([name]) => name === "setChannelSelectionActive"), focusedChannel === 4);
  }
  const ui = workspace({ preparedDisplay, display: preparedDisplay });
  ui.refs.zoomViewRef.current = { ...initialView(), anatomicalGroups: false, verticalViewport: { top: .2, bottom: .5 }, channelScrollTop: 240 };
  ui.refs.channelScrollOffsetRef.current = 240;
  ui.changeZoomView({ anatomicalGroups: true, verticalViewport: null, channelScrollTop: 0 });
  assert.equal(ui.refs.undoRef.current.length, 1);
  ui.undo();
  assert.equal(ui.readZoomView().anatomicalGroups, false);
  assert.deepEqual(ui.readZoomView().verticalViewport, { top: .2, bottom: .5 });
  assert.equal(ui.refs.pendingZoomScrollRef.current, 240);
  ui.redo(); assert.equal(ui.readZoomView().anatomicalGroups, true);
});

test("EDF and EDF+ enable name grouping for scalp, prefixed, auxiliary and unknown channel names", () => {
  for (const format of ["edf", "edf+"]) for (const channelLabels of [["Fp1", "C3", "Fz"], ["EEG LA1-REF", "SEEG LA2-LE"], ["ECG1", "Respiration"], ["Unusual name"]]) {
    const result = compile([declaration("channelGroupingMode"), declaration("anatomicalGroupsAvailable")].join("\n"), {
      meta: { format, channelLabels }, matlabAnatomicalLayout: false, bipolarMontageKind, matlabDisplayGroup,
    }, "({ mode: channelGroupingMode, available: anatomicalGroupsAvailable })");
    assert.deepEqual(result, { mode: "name", available: true });
  }
});

test("EDF name grouping restores the same source buffers and keeps auxiliary focus through toggles and undo", () => {
  const labels = ["EEG LA1-REF", "ECG1", "EEG LA2-REF", "ECG2"];
  const preparedDisplay = { labels, data: labels.map((_, i) => new Float64Array([i])),
    traceBaselines: labels.map(() => 0), envelopes: labels.map(() => null), units: labels.map(() => "µV"),
    sampleRates: labels.map(() => 100), sourceSampleRates: labels.map(() => 100), startSecs: labels.map(() => 0),
    sourceIndices: labels.map((_, i) => [i]), primarySourceIndices: labels.map((_, i) => i) };
  const render = (anatomicalGroups) => compile(declaration("display"), {
    useMemo: (fn) => fn(), anatomicalGroups, preparedDisplay, channelGroupingMode: "name", orderGroupedDisplayRows,
  }, "display");
  assert.deepEqual(render(true).labels, [labels[0], labels[2], labels[1], labels[3]]);
  assert.equal(render(false), preparedDisplay);
  const ui = workspace({ channelGroupingMode: "name", preparedDisplay, display: preparedDisplay, focusedChannel: 1 });
  ui.changeZoomView({ anatomicalGroups: true });
  assert.ok(ui.changes.some(([name, value]) => name === "setFocusedChannel" && value === 2));
  assert.ok(!ui.changes.some(([name]) => name === "setChannelSelectionActive"));
  ui.undo(); assert.equal(ui.readZoomView().anatomicalGroups, undefined);
  ui.redo(); assert.equal(ui.readZoomView().anatomicalGroups, true);
});

test("shared group labels align with row baselines in compact, expanded, and vertically zoomed views", () => {
  const channelRowLayout = buildChannelRowLayout(["LA3", "LA1", "RA10", "RA2"], true);
  const base = { channelRowLayout, channelViewportHeight: 828, CHANNEL_RAIL_HEADER_HEIGHT: 28,
    expandedChannels: false, waveformVerticalViewport: null, projectVerticalFraction, channelPlotGeometry };
  const style = (overrides = {}) => compile(declaration("channelGroupLabelStyle"), { ...base, ...overrides }, "channelGroupLabelStyle");
  assert.ok(Math.abs(style()(0, 1).top - (28 + (800 - 72) / 3 + 18)) < 1e-9);
  assert.ok(Math.abs(style({ expandedChannels: true })(2, 3).top - (28 + 2 * (800 - 96) / 3 + 72)) < 1e-9);
  assert.ok(Math.abs(style({ waveformVerticalViewport: { top: 0, bottom: .5 } })(0, 1).top - (28 + 800 * 1.5 / 2.75)) < 1e-9);
  assert.equal(style({ waveformVerticalViewport: { top: 0, bottom: .5 } })(2, 3), null);
  assert.ok(Math.abs(style({ waveformVerticalViewport: { top: .5, bottom: 1 } })(2, 3).top - (28 + 800 * 1.25 / 2.75)) < 1e-9);
});

test("channel changes clamp focus to visible grouped rows while empty loading views retain session focus", () => {
  let focused = 4, published;
  const zoomViewRef = { current: { anatomicalGroups: true } };
  const publish = compile(declaration("publishDisplay"), {
    zoomViewRef, channelGroupOrder, source: { meta: { format: "raw-int16-le" } }, centerDisplayWindow: (view) => view,
    clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    setFocusedChannel: (update) => { focused = update(focused); }, setDisplay: (view) => { published = view; },
  }, "publishDisplay");
  const next = { labels: ["LA1", "LA2", "ECG1", "ECG2", "ECG3"] };
  publish(next);
  assert.equal(focused, 1, "hidden auxiliary rows cannot leave focus outside the visible channel list");
  assert.equal(published, next, "grouping never discards prepared samples");
  focused = 7; publish({ labels: [] });
  assert.equal(focused, 7, "clearing old buffers while switching sessions must not reset saved focus");
  focused = 4; zoomViewRef.current.anatomicalGroups = false; publish(next);
  assert.equal(focused, 4, "publication follows the latest grouping choice during an in-flight read");

});

test("compact group rows, hit tests, scroll, and box zoom share the actual displayed positions", () => {
  const layout = buildChannelRowLayout(["LA1", "LA2", "LA3", "RA1", "RA2"], true);
  const build = (height, expandedChannels, waveformVerticalViewport = null, scrollTop = 0) => {
    const scope = { channelRowLayout: layout, channelViewportHeight: height, expandedChannels, waveformVerticalViewport,
      CHANNEL_RAIL_HEADER_HEIGHT: 28, channelPlotGeometry, channelRowFromFraction,
      waveformScrollRef: { current: { scrollTop } }, channelScrollOffsetRef: { current: scrollTop },
      clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)), useCallback: (fn) => fn };
    const names = ["channelRowFromClientY", "channelRailRowStyle", "waveformZoomForInspectionBox"];
    return compile(names.map(declaration).join("\n"), scope, `{${names.join(",")}}`);
  };
  for (const height of [100, 400, 900]) for (const expanded of [false, true]) {
    const scrollTop = expanded && height === 100 ? 60 : 0;
    const ui = build(height, expanded, null, scrollTop);
    const rect = { top: 20, height };
    for (let row = 0; row < layout.rowStartUnits.length; row++) {
      const style = ui.channelRailRowStyle(row);
      if (!style) continue;
      const y = style.top + style.height / 2 - scrollTop;
      if (y < 28 || y >= height) continue;
      assert.equal(ui.channelRowFromClientY(rect.top + y, rect), row, "clicking a visible label's baseline hits its own waveform");
    }
    if (!expanded && height >= 400) assert.equal(ui.channelRowFromClientY(rect.top + 29, rect), null, "outer whitespace cannot select a channel");
  }
  const ui = build(900, false);
  const first = ui.channelRailRowStyle(0), last = ui.channelRailRowStyle(2);
  assert.equal(first.height, 18);
  const patch = ui.waveformZoomForInspectionBox({ top: first.top / 900, bottom: (last.top + last.height) / 900 }, { height: 900 });
  const zoomed = build(900, false, patch.verticalViewport);
  assert.ok(Math.abs(zoomed.channelRailRowStyle(0).top - 28) < 1e-9);
  const zoomedLast = zoomed.channelRailRowStyle(2);
  assert.ok(Math.abs(zoomedLast.top + zoomedLast.height - 900) < 1e-9, "box zoom fills exactly the selected rows despite outer padding");
  const nested = zoomed.waveformZoomForInspectionBox({ top: 28 / 900, bottom: (28 + 436) / 900 }, { height: 900 });
  assert.equal(nested.verticalViewport.top, patch.verticalViewport.top);
  assert.ok(Math.abs(nested.verticalViewport.bottom - (patch.verticalViewport.top + patch.verticalViewport.bottom) / 2) < 1e-9);
});

test("first recording mount and panel resizes measure the actual waveform height for channel labels", () => {
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(syntax) === "useLayoutEffect"
      && node.arguments[0]?.getText(syntax).includes("setChannelViewportHeight")
      && node.arguments[0]?.getText(syntax).includes("ResizeObserver")) effect = node.getText(syntax);
    ts.forEachChild(node, visit);
  }
  visit(syntax); assert.ok(effect);
  let dependencies, cleanup, observerCallback, observed, measuredHeight = 245, canvasHeight = 490.5;
  const container = { clientHeight: 491, scrollTop: 0 };
  const scope = { activeSessionContentView: "recording", expandedChannels: false, hasRecording: false,
    waveformScrollRef: { current: null }, channelScrollOffsetRef: { current: 0 },
    canvasRef: { current: { getBoundingClientRect: () => ({ height: canvasHeight }) } },
    waveDrawRef: { current() {} }, setChannelViewportHeight: (update) => { measuredHeight = update(measuredHeight); },
    ResizeObserver: class { constructor(fn) { observerCallback = fn; } observe(el) { observed = el; } disconnect() {} },
    useLayoutEffect(fn, deps) {
      if (dependencies && deps.every((value, index) => value === dependencies[index])) return;
      cleanup?.(); dependencies = deps; cleanup = fn();
    } };
  const render = () => compile(`${effect};`, scope, "undefined");
  render(); assert.equal(observed, undefined);
  scope.waveformScrollRef.current = container; scope.hasRecording = true; render();
  assert.equal(observed, container, "loading the first recording attaches the observer");
  assert.equal(measuredHeight, 490.5, "labels use waveform height rather than the initial 245px placeholder");
  canvasHeight = 321.25; observerCallback(); assert.equal(measuredHeight, 321.25);
  scope.expandedChannels = true; render(); assert.equal(measuredHeight, 491, "expanded canvas fits its scrolling viewport");
  cleanup();
});

test("real undo/redo follows label → zoom → label chronologically without cross-restoring state", () => {
  const ui = workspace();
  const original = ui.readZoomView();
  ui.commitMutation(() => ["label A"]);
  ui.setTimeWindow(10);
  const zoomed = ui.readZoomView();
  assert.equal(zoomed.viewStart, 35);
  ui.commitMutation((labels) => [...labels, "label B"]);
  ui.undo();
  assert.deepEqual(ui.refs.annotationsRef.current, ["label A"]);
  assert.deepEqual(ui.readZoomView(), zoomed);
  ui.changes.length = 0;
  ui.undo();
  assert.deepEqual(ui.readZoomView(), original);
  assert.deepEqual(ui.refs.annotationsRef.current, ["label A"]);
  assert.ok(!ui.changes.some(([name]) => ["setAnnotations", "setCandidates", "setSelectedAnnotationId"].includes(name)));
  ui.undo();
  assert.deepEqual(ui.refs.annotationsRef.current, []);
  ui.redo(); ui.redo(); ui.redo();
  assert.deepEqual(ui.readZoomView(), zoomed);
  assert.deepEqual(ui.refs.annotationsRef.current, ["label A", "label B"]);
});

test("a two-axis box is one undo step, and zoom reset/gain/frequency changes join that chain", () => {
  const ui = workspace();
  const original = ui.readZoomView();
  ui.zoomToTimeRange(32, 38, { verticalViewport: { top: 0.2, bottom: 0.4 } });
  assert.equal(ui.refs.undoRef.current.length, 1);
  assert.equal(ui.readZoomView().timebase, 6);
  assert.deepEqual(ui.readZoomView().verticalViewport, { top: 0.2, bottom: 0.4 });
  ui.undo(); assert.deepEqual(ui.readZoomView(), original);
  ui.redo();
  ui.changeZoomView({ verticalViewport: null });
  ui.changeZoomView({ frequencyRange: { min: 10, max: 30 } });
  ui.changeZoomView({ gain: 2 });
  ui.undo(); assert.equal(ui.readZoomView().gain, 1);
  ui.undo(); assert.deepEqual(ui.readZoomView().frequencyRange, original.frequencyRange);
  ui.undo(); assert.deepEqual(ui.readZoomView().verticalViewport, { top: 0.2, bottom: 0.4 });
  ui.undo(); assert.deepEqual(ui.readZoomView(), original);
  ui.zoomToTimeRange(32, 38, { frequencyRange: { min: 10, max: 30 } });
  assert.equal(ui.refs.undoRef.current.length, 1);
  ui.undo(); assert.deepEqual(ui.readZoomView(), original, "spectrogram time and frequency undo together");
});

test("gain endpoints and exact entries share history; invalid values and bounded no-ops preserve redo", () => {
  const ui = workspace();
  for (const gain of [0.01, 0.73, 4]) ui.changeZoomView({ gain });
  assert.equal(ui.refs.undoRef.current.length, 3);
  ui.changeZoomView({ gain: 8 });
  assert.equal(ui.refs.undoRef.current.length, 3, "upper-bound button is a no-op");
  ui.undo(); assert.equal(ui.readZoomView().gain, 0.73);
  ui.changeZoomView({ gain: NaN });
  assert.equal(ui.refs.redoRef.current.length, 1);
  ui.redo(); assert.equal(ui.readZoomView().gain, 4);
  ui.undo(); ui.undo(); assert.equal(ui.readZoomView().gain, 0.01);
  ui.undo(); assert.equal(ui.readZoomView().gain, 1);
  ui.redo(); assert.equal(ui.readZoomView().gain, 0.01);
  ui.changeZoomView({ gain: 0 });
  assert.equal(ui.refs.redoRef.current.length, 2, "lower-bound no-op preserves redo");
  ui.applyZoomView({ ...initialView(), gain: 8 });
  assert.equal(ui.readZoomView().gain, 4, "old history cannot restore unsupported gain");
  assert.deepEqual(ui.changes.filter(([name]) => name === "setGain").at(-1), ["setGain", 4]);
});

test("viewport boundaries create no-op history; new zooms clear redo and can run during verification", () => {
  const ui = workspace();
  ui.setTimeWindow(1000);
  assert.equal(ui.readZoomView().timebase, 300);
  ui.setTimeWindow(1000);
  assert.equal(ui.refs.undoRef.current.length, 1);
  ui.undo();
  ui.setTimeWindow(20);
  assert.equal(ui.refs.redoRef.current.length, 1, "unchanged window preserves redo");
  ui.refs.sourceVerificationRef.current = true;
  ui.changeZoomView({ gain: 2 });
  assert.equal(ui.refs.redoRef.current.length, 0);
  assert.equal(ui.readZoomView().gain, 2);
  ui.commitMutation(() => ["not allowed"]);
  assert.deepEqual(ui.refs.annotationsRef.current, []);
  ui.undo(); assert.equal(ui.readZoomView().gain, 1);
});

test("undo and redo cancel queued navigation and stop a delayed zoom from reappearing", () => {
  const ui = workspace();
  ui.setTimeWindow(10);
  ui.refs.zoomWheelFrameRef.current = 11;
  ui.refs.wheelFrameRef.current = 12;
  ui.refs.cursorFrameRef.current = 13;
  ui.refs.zoomWheelDeltaRef.current = -50;
  ui.undo();
  assert.deepEqual(ui.canceled, [11, 12, 13]);
  assert.equal(ui.refs.zoomWheelDeltaRef.current, 0);
  assert.equal(ui.readZoomView().timebase, 20);
  assert.deepEqual(ui.refs.zoomGestureRef.current, {});
  ui.redo(); assert.equal(ui.readZoomView().timebase, 10);
});

test("gain and frequency changes preserve staged window amounts and normal playback", () => {
  const ui = workspace();
  ui.changeZoomView({ gain: 2 });
  ui.changeZoomView({ frequencyRange: { min: 0, max: 80 } });
  assert.ok(!ui.changes.some(([name]) => name === "setWindowDraftValue" || name === "setPlaying"));
  ui.undo();
  assert.ok(ui.changes.some(([name, value]) => name === "setPlaying" && value === false), "undo pauses so the restored view stays put");
});

test("expanded waveform boxes retain the pre-zoom layout and scroll position for undo", () => {
  const scope = {
    useCallback: (callback) => callback, composeVerticalViewport, channelPlotGeometry,
    clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
    expandedChannels: true, waveformVerticalViewport: null, CHANNEL_RAIL_HEADER_HEIGHT: 30,
    waveformScrollRef: { current: { scrollTop: 120 } }, channelScrollOffsetRef: { current: 120 },
    channelRowLayout: { totalUnits: 10, groups: [] },
  };
  const fit = compile(declaration("waveformZoomForInspectionBox"), scope, "waveformZoomForInspectionBox");
  const patch = fit({ top: 0.2, bottom: 0.6 }, { height: 300 });
  assert.deepEqual(patch, { verticalViewport: { top: 0.25, bottom: 0.45 }, expandedChannels: false, channelScrollTop: 0 });
  const ui = workspace();
  ui.refs.zoomViewRef.current.expandedChannels = true;
  ui.refs.channelScrollOffsetRef.current = 120;
  ui.changeZoomView(patch);
  ui.refs.channelScrollOffsetRef.current = 0; // Browser applies the compact layout.
  ui.undo();
  assert.equal(ui.readZoomView().expandedChannels, true);
  assert.equal(ui.refs.pendingZoomScrollRef.current, 120);
  assert.equal(ui.readZoomView().verticalViewport, null);
});

test("Ctrl/Cmd+Z and Shift+Z reach shared history from waveform, spectrogram, buttons, and coach", () => {
  for (const area of ["waveform", "spectrogram", "button", "coach", "input", "textarea", "select", "editable"]) {
    for (const modifier of ["ctrlKey", "metaKey"]) {
      const ui = workspace(); ui.setTimeWindow(10);
      const onKey = compile(declaration("onKey"), {
        ...ui.scope, undo: ui.undo, redo: ui.redo,
        controlBindings: DEFAULT_CONTROLS, shortcutAction, canvasRef: { current: null }, markOnset: null,
        olderReviews: null, showDirectorySessions: false, setShowDirectorySessions() {}, showEphysLabelPicker: false, showLabelVisibilityFilter: false, showHelp: false, showSettings: false, showChannels: false, showImport: false,
        showProjectSave: false, showSessionMap: false, showPatientInfo: false, showAnnotationEditor: false,
        queueDetailEntry: null, confirmCommit: [],
      }, "onKey");
      const native = ["input", "textarea", "select", "editable"].includes(area);
      const target = { closest(selector) {
        if (selector === ".spectrogram-panel") return area === "spectrogram" ? this : null;
        if (selector === ".tutorial-coach") return area === "coach" ? this : null;
        if (area === "editable") return selector.includes("contenteditable") ? this : null;
        return selector.split(", ").includes(area) ? this : null;
      } };
      let prevented = false;
      const event = { key: "z", code: "KeyZ", target, [modifier]: true, shiftKey: false, preventDefault() { prevented = true; }, stopPropagation() {} };
      onKey(event);
      assert.equal(ui.readZoomView().timebase, native ? 10 : 20, `${area} ${modifier}`);
      assert.equal(prevented, !native);
      if (!native) {
        onKey({ ...event, key: "Z", shiftKey: true });
        assert.equal(ui.readZoomView().timebase, 10);
      }
    }
  }
});

test("session snapshots preserve zoom axes with their own histories; new recordings reset both", () => {
  const store = declaration("storeActiveSession");
  const restore = declaration("applySessionSnapshot");
  for (const field of ["waveformVerticalViewport", "spectrogramFrequencyRange", "channelScrollTop", "anatomicalGroups"]) {
    assert.ok(store.includes(field), `${field} stored per session`);
    assert.ok(restore.includes(`snapshot.${field}`), `${field} restored per session`);
  }
  assert.ok(!store.includes("traceCenters"), "manual trace centers are no longer persisted");
  assert.ok(!restore.includes("snapshot.traceCenters"), "legacy manual centers cannot override automatic centering");
  assert.match(restore, /undoRef.current = snapshot.undo/);
  assert.match(restore, /redoRef.current = snapshot.redo/);
  assert.match(page, /undoRef.current = \[\];\s*redoRef.current = \[\];\s*zoomGestureRef.current = \{\}/);
});

test("restoring an expanded session waits for rows before restoring its scroll offset", () => {
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(syntax) === "useLayoutEffect"
      && node.arguments[0]?.getText(syntax).includes("const scrollTop = pendingZoomScrollRef.current")) effect = node.arguments[0].getText(syntax);
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  assert.ok(effect);
  const scope = {
    pendingZoomScrollRef: { current: 240 }, expandedChannels: true, display: { data: [] },
    waveformScrollRef: { current: { scrollTop: 0 } }, channelScrollOffsetRef: { current: 0 },
  };
  const restore = compile(`const restore = ${effect};`, scope, "restore");
  restore();
  assert.equal(scope.pendingZoomScrollRef.current, 240, "keep the requested offset while the session loads");
  assert.equal(scope.waveformScrollRef.current.scrollTop, 0);
  scope.display.data = [new Float32Array(10)];
  restore();
  assert.equal(scope.waveformScrollRef.current.scrollTop, 240);
  assert.equal(scope.channelScrollOffsetRef.current, 240);
  assert.equal(scope.pendingZoomScrollRef.current, null);
});

test("spectrogram box completion commits time and frequency together, including single-axis boxes", () => {
  for (const end of [[80, 160], [80, 34], [20, 160], [21, 35]]) {
    const zooms = [];
    const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 222 }), hasPointerCapture: () => false };
    const scope = {
      clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
      interactionRef: { current: { pointerId: 1, startX: 20, startY: 34, currentX: 20, currentY: 34, tool: "box-zoom" } },
      SPECTROGRAM_PLOT_LEFT: 0, SPECTROGRAM_PLOT_RIGHT: 0, SPECTROGRAM_PLOT_TOP: 34, SPECTROGRAM_PLOT_BOTTOM: 22, SPECTROGRAM_MINIMUM_DRAG_PX: 4,
      effectiveDisplayMinHz: 0, displayFrequencySpanHz: 100, maximumDisplayHz: 100, minimumDisplayHz: 1,
      viewStart: 30, viewDuration: 20, sessionDuration: 300,
      setZoomBox() {}, notifyTutorialAction() {}, onZoom: (...args) => zooms.push(args),
    };
    const complete = compile(["plotRatio", "frequencyFromPointer", "zoomBoxFromInteraction", "boundedStart", "completeInteraction"].map(declaration).join("\n"), scope, "completeInteraction");
    complete({ pointerId: 1, clientX: end[0], clientY: end[1], currentTarget: canvas });
    if (end[0] === 21) assert.equal(zooms.length, 0, "a click is not a zoom");
    else {
      assert.equal(zooms.length, 1);
      assert.deepEqual(zooms[0][0], end[0] === 20 ? null : { start: 34, end: 46 });
      assert.deepEqual(zooms[0][1], end[1] === 34 ? undefined : { min: (1 - 126 / 166) * 100, max: 100 });
    }
  }
});
