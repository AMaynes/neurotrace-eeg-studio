import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { recordZoomChange, sameZoomView } from "../app/zoom-history.ts";
import { composeVerticalViewport } from "../app/waveform-viewport.ts";

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
    ...refs, recordZoomChange, useCallback: (callback) => callback,
    hasRecording: true, meta: { durationSec: 300 }, minimumRenderableWindow: 0.1,
    timebase: 20, WINDOW_ZOOM_STEP_SECONDS: 0.1,
    clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
    quantizeWindowZoom: (value) => Number((Math.round(value / 0.1) * 0.1).toFixed(10)),
    commitViewStart: (value) => { refs.viewStartRef.current = value; },
    window: { cancelAnimationFrame: (id) => canceled.push(id) },
    notifyTutorialAction: () => {}, ...overrides,
  };
  for (const name of ["setPlaying", "setTimebase", "setWindowDraftValue", "setGain", "setWaveformVerticalViewport",
    "setExpandedChannels", "setSpectrogramFrequencyRange", "setInspectionRange", "setInspectionDragging",
    "setAnnotations", "setCandidates", "setActiveCandidate", "setSelectedAnnotationId", "setSelectedAnnotationIds", "setToast"]) {
    scope[name] = (value) => changes.push([name, value]);
  }
  const names = ["readZoomView", "cancelPendingViewFrames", "applyZoomView", "changeZoomView", "setTimeWindow", "zoomToTimeRange", "zoomTimeWindow", "commitMutation", "undo", "redo"];
  const api = compile(names.map(declaration).join("\n"), scope, `{${names.join(",")}}`);
  return { ...api, refs, scope, changes, canceled };
}

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
    useCallback: (callback) => callback, composeVerticalViewport,
    clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
    expandedChannels: true, waveformVerticalViewport: null, CHANNEL_RAIL_HEADER_HEIGHT: 30,
    waveformScrollRef: { current: { scrollTop: 120 } }, channelScrollOffsetRef: { current: 120 },
    channelRowLayout: { totalUnits: 10 },
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
        showEphysLabelPicker: false, showHelp: false, showSettings: false, showChannels: false, showImport: false,
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
  for (const field of ["waveformVerticalViewport", "spectrogramFrequencyRange", "channelScrollTop"]) {
    assert.ok(store.includes(field), `${field} stored per session`);
    assert.ok(restore.includes(`snapshot.${field}`), `${field} restored per session`);
  }
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
      effectiveDisplayMinHz: 0, displayFrequencySpanHz: 100, maximumDisplayHz: 100,
      viewStart: 30, viewDuration: 20, sessionDuration: 300,
      setZoomBox() {}, notifyTutorialAction() {}, onZoom: (...args) => zooms.push(args),
    };
    const complete = compile(["plotRatio", "frequencyFromPointer", "zoomBoxFromInteraction", "boundedStart", "completeInteraction"].map(declaration).join("\n"), scope, "completeInteraction");
    complete({ pointerId: 1, clientX: end[0], clientY: end[1], currentTarget: canvas });
    if (end[0] === 21) assert.equal(zooms.length, 0, "a click is not a zoom");
    else {
      assert.equal(zooms.length, 1);
      assert.deepEqual(zooms[0][0], end[0] === 20 ? null : { start: 34, end: 46 });
      assert.deepEqual(zooms[0][1], end[1] === 34 ? undefined : { min: 24, max: 100 });
    }
  }
});
