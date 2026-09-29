/** Execute the real pointer/annotation/export paths, not a duplicate timing formula. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map();
const variables = new Map();
let snapDefault;
let annotationDragEffect;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
  if (ts.isVariableDeclaration(node)) {
    if (ts.isIdentifier(node.name)) variables.set(node.name.text, node);
    if (ts.isArrayBindingPattern(node.name) && node.name.elements.some((entry) => entry.name?.getText(ast) === "snapMode")) {
      snapDefault = node.initializer.arguments[0];
    }
  }
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect"
    && node.arguments[0]?.getText(ast).includes("const applyPreview = () =>")) annotationDragEffect = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(ast);
const transpile = (code) => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
function evaluate(code, expression, env = {}) {
  return new Function(...Object.keys(env), `${transpile(code)}\nreturn ${expression};`)(...Object.values(env));
}
const variable = (name, env = {}) => evaluate(`const result = ${variables.get(name).initializer.getText(ast)};`, "result", env);
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const LABELS = variable("LABELS");
const LABEL_BY_ID = new Map(LABELS.map((label) => [label.id, label]));
const pureNames = ["snapTime", "sampleSnapOrigin", "sourceRateForDisplayRow", "annotationTimingSampleRate", "primarySampleRate", "annotationGeometry", "normalizeAnnotationGeometry", "annotationOverlapsWindow", "csvCell", "tsvCell", "sourceMeta", "blankSessionSnapshot", "migrateAnnotationList"];
const pure = evaluate(pureNames.map((name) => functions.get(name).getText(ast)).join("\n"),
  `({ ${pureNames.join(",")} })`, { clamp, LABEL_BY_ID, DEFAULT_FILTERS: { enabled: false }, emptyBidsCompanionBundle: () => ({}) });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

function display(overrides = {}) {
  return { timingConvention: "matlab-window", viewStart: .0073,
    sampleRates: [500], sourceSampleRates: [1000], sourceIndices: [[0]],
    primarySourceIndices: [0], labels: ["LA1"], ...overrides };
}
const defaultMeta = { durationSec: 120, sampleRates: [1000], channelLabels: ["LA1"], name: "recording.dat" };
function pointer(overrides = {}) {
  return variable("timeFromPointer", { ...pure, clamp, useCallback: (fn) => fn,
    display: display(), meta: defaultMeta, snapMode: "none", viewStart: .0073, timebase: 1,
    ...overrides });
}
const element = { getBoundingClientRect: () => ({ left: 100, width: 1000 }) };

test("both new-session and first-render defaults preserve MATLAB unsnapped click timing", () => {
  assert.equal(evaluate(`const value = ${snapDefault.getText(ast)};`, "value"), "none");
  assert.equal(pure.blankSessionSnapshot({ meta: defaultMeta }, "test").snapMode, "none");
  near(pointer()({ clientX: 102.937 }, element, 0), .010237);
  near(pure.snapTime(.010237, "none", 1000, false, .0083), .010237);
  near(pure.snapTime(.010237, "100ms", 1000, true, .0083), .010237);
});

test("production pointer sample snapping follows the fractional MATLAB origin and source rate, not retained rate", () => {
  const origin = pure.sampleSnapOrigin(display(), 1000);
  near(origin, .0083);
  near(pointer({ snapMode: "sample" })({ clientX: 102.937 }, element, 0), .0103);
  // The 2x-decimated display retains .0083, .0103, .0123, but annotation sample
  // snapping intentionally still supports source-resolution .0093.
  near(pointer({ snapMode: "sample" })({ clientX: 102.01 }, element, 0), .0093);
  const slow = display({ sampleRates: [100], sourceSampleRates: [200] });
  near(pure.sampleSnapOrigin(slow, 200), .0123);
  near(pointer({ display: slow, meta: { ...defaultMeta, sampleRates: [200] }, snapMode: "sample" })({ clientX: 108.9 }, element, 0), .0173);
  assert.equal(pure.sampleSnapOrigin(display({ timingConvention: undefined }), 1000), 0);
  near(pointer({ display: display({ timingConvention: undefined }), snapMode: "sample" })({ clientX: 102.937 }, element, 0), .010);
});

test("pointer timing stays in visible recording bounds and optional coarse snapping stays explicit", () => {
  near(pointer()({ clientX: -50 }, element, 0), .0073);
  near(pointer()({ clientX: 5000 }, element, 0), 1.0073);
  near(pointer({ viewStart: 119.5, timebase: 20 })({ clientX: 1000 }, element, 0), 120);
  near(pure.snapTime(12.3456, "100ms", 200), 12.3);
  near(pure.snapTime(12.6, "1s", 200), 13);
});

function annotationHarness(overrides = {}) {
  let annotations = [];
  const notices = [];
  const env = {
    ...pure, clamp, LABEL_BY_ID, useCallback: (fn) => fn, hasRecording: true,
    sourceVerificationRef: { current: false }, annotationsRef: { current: annotations },
    display: display(), meta: defaultMeta, snapMode: "none", focusedChannel: 0,
    candidates: [], activeCandidate: 0, activeTool: "cursor", montage: "referential", reviewer: "AR",
    makeId: () => `ann-${annotations.length + 1}`,
    commitMutation: (mutate) => { annotations = mutate(annotations); env.annotationsRef.current = annotations; },
    setToast: (value) => notices.push(value), setSelectedAnnotationId() {}, setSelectedAnnotationIds() {},
    setCursorTime() {}, setCursorLocked() {}, setSelection() {}, notifyTutorialAction() {},
    formatClock: (time) => String(time), ...overrides,
  };
  const add = variable("addAnnotation", env);
  return { add, env, notices, annotations: () => annotations };
}
function jsonl(annotations, overrides = {}) {
  return variable("annotationsJsonl", { annotations, LABEL_BY_ID, meta: defaultMeta,
    uniformSampleRate: true, sampleRate: 1000, rawSourceHash: "source", sourceHash: "interpretation", ...overrides })
    .split("\n").filter(Boolean).map((row) => JSON.parse(row));
}

test("actual click-to-point annotation keeps plotted seconds but exports the physical source sample", () => {
  const h = annotationHarness({ snapMode: "sample" });
  h.add(LABEL_BY_ID.get("spikes"), .010237);
  const annotation = h.annotations()[0];
  near(annotation.start, .0103);
  near(annotation.end, .0103);
  near(annotation.sourceTimeOffsetSec, .0013);
  assert.deepEqual(annotation.channelScope.sourceIndices, [0]);
  const result = jsonl([annotation])[0];
  assert.equal(result.start_sample, 9);
  assert.equal(result.end_sample, 9);
  near(result.start, .0103);
  near(result.source_time_offset_sec, .0013);
  assert.equal(result.sample_rate_basis_hz, 1000);
});

test("unsnapped intervals retain x-click precision; sample offsets do not alter MATLAB CSV axis seconds", () => {
  const h = annotationHarness();
  h.add(LABEL_BY_ID.get("ictal"), .010237, .032731);
  const annotation = { ...h.annotations()[0], status: "committed", candidateId: "candidate" };
  near(annotation.start, .010237);
  near(annotation.end, .032731);
  near(annotation.sourceTimeOffsetSec, .0013);
  const [sampleExport] = jsonl([annotation]);
  assert.equal(sampleExport.start_sample, 9);
  assert.equal(sampleExport.end_sample, 31);
  const candidate = { id: "candidate", status: "reviewed", time: .009, label: "seizure", reviewerInitials: "AR", legacyConfidence: "3" };
  const csv = variable("matlabCompatibilityRows", { annotations: [annotation], candidates: [candidate],
    patientId: "patient", reviewer: "AR", sourceInterpretation: null, meta: defaultMeta, sampleRate: 1000,
    csvCell: pure.csvCell, normalizeChannelList: (text) => text, formatMatlabTimestamp: () => "timestamp" });
  const [header, row] = csv.split("\n").map((line) => line.split(","));
  const exported = Object.fromEntries(header.map((name, index) => [name, row[index]]));
  assert.equal(exported.onset_absolute_sec, "0.010237");
  assert.equal(exported.offset_absolute_sec, "0.032731");
  assert.equal(exported.onset_relative_to_annotation_sec, "0.001237");
  assert.equal(exported.offset_relative_to_annotation_sec, "0.023731");
  assert.equal(exported.seizure_duration_sec, "0.022494");
  assert.equal(exported.accepted, "1");
});

test("source-aware spike exports use the selected channel rate in a mixed-rate recording", () => {
  const meta = { ...defaultMeta, sampleRates: [1000, 256], channelLabels: ["LA1", "LA2"] };
  const h = annotationHarness({ meta, focusedChannel: 1, snapMode: "sample",
    display: display({ sampleRates: [500, 128], sourceSampleRates: [1000, 256],
      sourceIndices: [[0], [1]], primarySourceIndices: [0, 1], labels: ["LA1", "LA2"] }) });
  h.add(LABEL_BY_ID.get("spikes"), .0149);
  const annotation = h.annotations()[0];
  near(annotation.start, .0151125);
  near(annotation.sourceTimeOffsetSec, .0073);
  const exported = jsonl([annotation], { meta, uniformSampleRate: false })[0];
  assert.equal(exported.start_sample, 2);
  assert.equal(exported.sample_rate_basis_hz, 256);
  h.add(LABEL_BY_ID.get("ictal"), .0149, .031);
  const interval = jsonl([h.annotations()[1]], { meta, uniformSampleRate: false })[0];
  assert.equal(interval.start_sample, null, "a global mixed-rate annotation has no universal sample index");
  assert.equal(interval.end_sample, null);
});

test("session labels and source-time legacy annotations never receive a plotted-sample offset", () => {
  const h = annotationHarness();
  h.add(LABEL_BY_ID.get("session-context"), .010237);
  const session = h.annotations()[0];
  assert.equal(session.start, 0);
  assert.equal(session.end, 120);
  assert.equal(session.sourceTimeOffsetSec, 0);
  assert.equal(jsonl([session])[0].end_sample, 120000);
  const old = annotationHarness({ display: display({ timingConvention: undefined }) });
  old.add(LABEL_BY_ID.get("spikes"), .010237);
  assert.equal(old.annotations()[0].sourceTimeOffsetSec, 0);
  assert.equal(jsonl(old.annotations())[0].start_sample, 10);
  const imported = { ...old.annotations()[0] };
  delete imported.sourceTimeOffsetSec;
  assert.equal(jsonl([imported])[0].start_sample, 10);
});

test("valid plotted-to-source offsets survive project annotation migration", () => {
  const h = annotationHarness();
  h.add(LABEL_BY_ID.get("spikes"), .010237);
  const recovered = pure.migrateAnnotationList(JSON.parse(JSON.stringify(h.annotations())), 120, 1);
  assert.equal(recovered.length, 1);
  near(recovered[0].sourceTimeOffsetSec, .0013);
  assert.equal(jsonl(recovered)[0].start_sample, 9);
});

test("malformed imported source offsets cannot corrupt sample exports or legacy field absence", () => {
  const h = annotationHarness();
  h.add(LABEL_BY_ID.get("spikes"), .010237);
  const annotation = h.annotations()[0];
  for (const sourceTimeOffsetSec of [NaN, Infinity, -Infinity, -1, 121, ".0013", null, {}]) {
    const recovered = pure.migrateAnnotationList([{ ...annotation, sourceTimeOffsetSec }], 120, 1);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].sourceTimeOffsetSec, undefined);
    const exported = jsonl(recovered)[0];
    assert.equal(exported.start_sample, 10);
    assert.equal(exported.source_time_offset_sec, 0);
  }
  const legacy = { ...annotation };
  delete legacy.sourceTimeOffsetSec;
  const recovered = pure.migrateAnnotationList([legacy], 120, 1);
  assert.equal(Object.hasOwn(recovered[0], "sourceTimeOffsetSec"), false,
    "migration does not insert a new field into legacy annotation identity/hash inputs");
});

test("loading a source or applying a session snapshot clears the previous recording's clicked baseline", async () => {
  for (const name of ["loadSource", "applySessionSnapshot"]) {
    const callback = variables.get(name).initializer.arguments[0];
    const setters = new Map();
    const env = { sourceMeta: pure.sourceMeta, EMPTY_DISPLAY: {}, activeSessionId: "next-session",
      emptyBidsCompanionBundle: () => ({}), DEFAULT_FILTERS: { enabled: false },
      window: { cancelAnimationFrame() {} }, commitViewStart() {}, storeActiveSession() {}, cancelPendingViewFrames() {} };
    function bindings(node) {
      if (ts.isIdentifier(node) && node.text.endsWith("Ref")) env[node.text] ??= { current: null };
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text.startsWith("set")) {
        const name = node.expression.text;
        env[name] = (...args) => setters.set(name, args);
      }
      ts.forEachChild(node, bindings);
    }
    bindings(callback);
    env.recordingOverviewCacheRef = { current: new Map() };
    env.sessionSnapshotsRef = { current: new Map() };
    env.setSpectrogramAnchor = (anchor) => { env.anchor = anchor; setters.set("setSpectrogramAnchor", [anchor]); };
    env.anchor = 4;
    const meta = { ...defaultMeta, id: "next-recording" };
    if (name === "applySessionSnapshot") {
      const snapshot = pure.blankSessionSnapshot({ meta }, "next-session");
      snapshot.hasRecording = true;
      env.snapshot = snapshot;
      evaluate(`const transition = ${callback.getText(ast)};`, "transition(snapshot)", env);
    } else {
      // Execute every real installation statement before asynchronous file
      // verification begins; there is no file/network work in this harness.
      const firstTry = callback.body.statements.findIndex(ts.isTryStatement);
      assert.ok(firstTry > 0);
      const install = callback.body.statements.slice(0, firstTry).map((node) => node.getText(ast)).join("\n");
      env.source = { meta };
      env.file = { name: "next-recording.dat" };
      env.interpretation = undefined;
      env.importContext = undefined;
      env.keepSeparateSession = false;
      evaluate(install, "undefined", env);
      assert.equal(setters.get("setMeta")[0], meta);
    }
    assert.deepEqual(setters.get("setExactSpectrogramSignal"), [null]);
    assert.deepEqual(setters.get("setSpectrogramAnchor"), [null], `${name} must clear the transient anchor`);
    // The old click (4s) is deliberately still inside the next view. Without
    // the reset it would silently change the next recording's normalization.
    let requestedAnchor;
    const input = variable("spectrogramInputPlan", { useMemo: (fn) => fn(), spectrogramAnchor: env.anchor,
      signalViewStart: 0, timebase: 20, meta, spectrogramSourceIndex: 0, sessionKey: "next-session",
      matlabSpectrogramInputPlan: (_meta, _row, _start, _duration, anchor) => {
        requestedAnchor = anchor;
        return { sourceIndices: [0], sampleCount: 20, baselineTime: anchor };
      } });
    assert.equal(requestedAnchor, 10, "new recording uses its midpoint until explicitly clicked");
    assert.equal(input.plan.baselineTime, 10);
  }
});

test("finishing a waveform refresh does not reread and recompute an unchanged raw spectrogram", () => {
  let previousDependencies;
  let previousPlan;
  let requests = 0;
  const useMemo = (create, dependencies) => {
    if (!previousDependencies || dependencies.some((value, index) => !Object.is(value, previousDependencies[index]))) {
      previousPlan = create();
      previousDependencies = dependencies;
    }
    return previousPlan;
  };
  const base = { useMemo, spectrogramAnchor: 4, signalViewStart: 0, timebase: 20,
    meta: defaultMeta, sessionKey: "recording", spectrogramSourceIndex: 0,
    matlabSpectrogramInputPlan: (_meta, sourceIndex) => {
      requests++;
      return { sourceIndices: [sourceIndex], sampleCount: 20000, baselineTime: 4 };
    } };
  const first = variable("spectrogramInputPlan", base);
  // A newly published display has new row arrays but the same source contact.
  const refreshed = variable("spectrogramInputPlan", { ...base, display: display() });
  assert.equal(requests, 1);
  assert.equal(refreshed, first, "stable memo identity prevents the read effect and worker from restarting");
  const differentContact = variable("spectrogramInputPlan", { ...base, spectrogramSourceIndex: 1 });
  assert.equal(requests, 2);
  assert.notEqual(differentContact, first);
  assert.notEqual(differentContact.requestKey, first.requestKey);
});

test("mixed-rate interval drag, resize, and keyboard moves retain the creation grid after focus changes", () => {
  const meta = { ...defaultMeta, sampleRates: [1000, 256], channelLabels: ["LA1", "LA2"] };
  const mixedDisplay = display({ sampleRates: [500, 128], sourceSampleRates: [1000, 256],
    sourceIndices: [[0], [1]], primarySourceIndices: [0, 1], labels: ["LA1", "LA2"] });
  const h = annotationHarness({ meta, display: mixedDisplay, snapMode: "sample", focusedChannel: 0 });
  h.add(LABEL_BY_ID.get("ictal"), .010237, .200237);
  const original = h.annotations()[0];
  assert.equal(original.channelScope, undefined, "this is a global interval, not a single-channel spike");
  assert.equal(original.timingSampleRateHz, 1000);
  near(original.sourceTimeOffsetSec, .0013);
  assert.equal(pure.annotationTimingSampleRate(original, mixedDisplay, meta, 1), 1000);
  for (const mode of ["move", "start", "end"]) {
    const handlers = new Map();
    let annotations = [original];
    const env = { ...pure, clamp, LABEL_BY_ID, meta, display: mixedDisplay, focusedChannel: 1,
      timebase: 1, snapMode: "sample", document: { elementFromPoint: () => null },
      window: { addEventListener: (name, handler) => handlers.set(name, handler), removeEventListener() {},
        requestAnimationFrame: () => 1, cancelAnimationFrame() {} },
      dragAnnotationRef: { current: { original, originals: [original], mode, id: original.id,
        originX: 0, moved: false, snapshot: [original] } },
      timelineRef: { current: { getBoundingClientRect: () => ({ width: 1000 }) } },
      pendingAnnotationDragRef: { current: null }, dragFrameRef: { current: null },
      undoRef: { current: [] }, redoRef: { current: [] }, candidatesRef: { current: [] },
      activeCandidateIndexRef: { current: 0 }, setAnnotationDragPreview() {}, setToast() {},
      reopenCandidateReviews() {}, setAnnotations: (update) => { annotations = update(annotations); } };
    evaluate(`const attach = ${annotationDragEffect.getText(ast)};`, "attach()", env);
    handlers.get("pointermove")({ clientX: 1.6, clientY: 0 });
    handlers.get("pointerup")();
    const moved = annotations[0];
    near(moved.start, mode === "end" ? original.start : original.start + .002);
    near(moved.end, mode === "start" ? original.end : original.end + .002);
    near(moved.sourceTimeOffsetSec, original.sourceTimeOffsetSec);
    assert.equal(moved.timingSampleRateHz, 1000);
    assert.equal(jsonl([moved], { meta, uniformSampleRate: false })[0].start_sample, null,
      "remembering a snap grid must not invent a universal sample index for a global mixed-rate label");
  }
  const nudge = variable("moveSelectedAnnotations", { ...pure, clamp, meta, display: mixedDisplay,
    focusedChannel: 1, snapMode: "sample", useCallback: (fn) => fn,
    selectedAnnotationIds: new Set([original.id]), selectedAnnotationId: original.id,
    annotationsRef: { current: [original] }, setToast() {}, reopenCandidateReviews() {},
    commitMutation: (update) => { h.env.moved = update([original])[0]; } });
  nudge(1);
  near(h.env.moved.start, original.start + .001);
  near(h.env.moved.sourceTimeOffsetSec, original.sourceTimeOffsetSec);
});

test("timing-grid metadata is validated on migration and preserves legacy absence/fallback", () => {
  const h = annotationHarness();
  h.add(LABEL_BY_ID.get("ictal"), .01, .2);
  const annotation = h.annotations()[0];
  const recovered = pure.migrateAnnotationList(JSON.parse(JSON.stringify([annotation])), 120, 1);
  assert.equal(recovered[0].timingSampleRateHz, 1000);
  for (const timingSampleRateHz of [NaN, Infinity, -Infinity, 0, -1, "1000", null, {}]) {
    const [invalid] = pure.migrateAnnotationList([{ ...annotation, timingSampleRateHz }], 120, 1);
    assert.equal(invalid.timingSampleRateHz, undefined);
    assert.equal(pure.annotationTimingSampleRate(invalid, display(), defaultMeta, 0), 1000);
  }
  const legacy = { ...annotation };
  delete legacy.timingSampleRateHz;
  const [legacyResult] = pure.migrateAnnotationList([legacy], 120, 1);
  assert.equal(Object.hasOwn(legacyResult, "timingSampleRateHz"), false);
  assert.equal(pure.annotationTimingSampleRate(legacyResult, display(), defaultMeta, 0), 1000);
});
