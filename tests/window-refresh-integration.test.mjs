/** Runs the page's actual effect and refresh function without a browser. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import {
  EDFSource, RawDatSource, buildEnvelopePyramid, detectEnvelopeSynchronizedFlatlines,
  mergeNearbyFlatlineRegions, projectEnvelopeChannels, selectEnvelopePyramidLevel,
  sliceEnvelopeWindow,
} from "../app/eeg-core.ts";
import { mergeAdjacentEnvelopeWindows, planAlignedEnvelopeRequest, planEnvelopeExtension } from "../app/envelope-cache.ts";
import { recordingOverviewDisplayPolicy } from "../app/overview-display-policy.ts";
import { RecordingOverviewCache, recordingOverviewDisplayWindow, recordingOverviewPlan } from "../app/recording-overview.ts";
import { resolveStableTraceBaseline, waveformOverviewColumnBudget } from "../app/waveform-geometry.ts";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
function collect(node) {
  if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
    declarations.set(node.name.text, node);
  }
  ts.forEachChild(node, collect);
}
collect(syntax);
let refreshEffect = declarations.get("refreshWindow");
while (refreshEffect && !(ts.isCallExpression(refreshEffect) && refreshEffect.expression.getText(syntax) === "useEffect")) {
  refreshEffect = refreshEffect.parent;
}
assert.ok(refreshEffect, "find the real signal refresh effect");

const constants = [
  "EMPTY_DISPLAY", "RAW_WINDOW_CACHE_BUDGET_BYTES", "ENVELOPE_CACHE_BUDGET_BYTES",
  "ENVELOPE_ENTRY_BUDGET_BYTES", "SOURCE_READ_AHEAD_BUDGET_BYTES", "INITIAL_PREVIEW_READ_BUDGET_BYTES",
  "MIN_WAVEFORM_WIDTH_FOR_ENVELOPE", "MAX_REUSABLE_ENVELOPE_BUCKETS", "FULL_SESSION_ENVELOPE_REFINEMENT",
  "LOCAL_ENVELOPE_REFINEMENT", "INCREMENTAL_ENVELOPE_REFINEMENT", "WINDOW_ZOOM_STEP_SECONDS",
  "MIN_TIME_WINDOW_SECONDS", "FLATLINE_DISPLAY_MERGE_GAP_SECONDS",
];
const helpers = ["clamp", "isAbortFailure", "reusableEnvelopeBucketCount", "envelopeWindowByteLength", "makeEnvelopeCacheEntry"];
const policy = ["overviewPlanForView", "overviewDisplayPolicy", "overviewRefreshRevision"];
const extracted = [
  ...constants.map((name) => `const ${declarations.get(name).getText(syntax)};`),
  ...helpers.map((name) => declarations.get(name).getText(syntax)),
  ...policy.map((name) => `const ${declarations.get(name).getText(syntax)};`),
  `${refreshEffect.getText(syntax)};`,
].join("\n");
const effectCode = ts.transpileModule(extracted, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

const tick = () => new Promise((resolve) => setImmediate(resolve));

function envelope(source, { startSec = 0, durationSec = 3600, bucketCount = 2048, value = 10 } = {}) {
  const count = source.meta.channelCount;
  const bucketDurationSec = durationSec / bucketCount;
  return {
    startSec, durationSec, bucketDurationSec,
    channelIndices: Array.from({ length: count }, (_, index) => index),
    channelLabels: [...source.meta.channelLabels], channelUnits: [...source.meta.channelUnits],
    channelStartSecs: Array(count).fill(startSec), sampleRates: Array(count).fill(1 / bucketDurationSec),
    data: Array.from({ length: count }, () => new Float32Array(bucketCount).fill(value)),
    minima: Array.from({ length: count }, () => new Float32Array(bucketCount).fill(value - 1)),
    maxima: Array.from({ length: count }, () => new Float32Array(bucketCount).fill(value + 1)),
    gaps: Array.from({ length: count }, () => new Uint8Array(bucketCount)),
    variation: Array.from({ length: count }, () => new Float32Array(bucketCount).fill(2)),
  };
}

async function harness({ duration = 300, coarse = false, verifying = true, cachedDetail = false } = {}) {
  // Actual source identity/metadata, tiny synthetic file, and a large byte-rate
  // simulate the former 16 MiB verification hold without allocating private data.
  const source = await RawDatSource.create(new File([new Int16Array(3600 * 10 * 2)], "synthetic.dat"), {
    sampleRate: 10, channelCount: 2, channelLabels: ["A1", "A2"],
  });
  source.meta.sampleRate = 1000;
  source.meta.sampleRates = [1000, 1000];
  source.meta.byteLength = 1024 * 1024 * 1024;
  const cache = new RecordingOverviewCache();
  if (coarse) assert.equal(cache.put(source, envelope(source), { complete: true }), true);
  const calls = [];
  const displays = [];
  const loading = [];
  const toasts = [];
  let dependencies;
  let cleanup;
  let focused = 0;
  const operation = () => ({ update() {}, finish() {}, cancel() {}, fail() {} });
  const worker = (request, options) => new Promise((resolve, reject) => {
    const call = {
      request, options,
      prefix(fraction = 0.5, value = 20) {
        const count = Math.max(1, Math.floor(request.bucketCount * fraction));
        const prefix = envelope(source, {
          startSec: request.startSec,
          durationSec: request.durationSec * count / request.bucketCount,
          bucketCount: count, value,
        });
        options.onOverview(prefix);
        return prefix;
      },
      finish(value = 30) {
        const window = envelope(source, { ...request, value });
        resolve({ window, metrics: { bytesRead: 100, totalBytes: 100, readMs: 1, decodeMs: 1, integrityMs: 0 } });
        return window;
      },
    };
    calls.push(call);
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  });
  const env = {
    useMemo: (callback) => callback(),
    useEffect(callback, nextDependencies) {
      if (dependencies && nextDependencies.length === dependencies.length
        && nextDependencies.every((value, index) => Object.is(value, dependencies[index]))) return;
      cleanup?.();
      dependencies = nextDependencies;
      cleanup = callback();
    },
    EDFSource, RawDatSource, buildEnvelopePyramid, detectEnvelopeSynchronizedFlatlines,
    mergeNearbyFlatlineRegions, projectEnvelopeChannels, selectEnvelopePyramidLevel, sliceEnvelopeWindow,
    mergeAdjacentEnvelopeWindows, planAlignedEnvelopeRequest, planEnvelopeExtension,
    recordingOverviewDisplayPolicy, recordingOverviewDisplayWindow, recordingOverviewPlan,
    resolveStableTraceBaseline, waveformOverviewColumnBudget,
    buildRawDatEnvelopeWindowOffThread: worker,
    performanceDiagnostics: { beginSourceRead: operation, beginDecode: operation, recordDecode() {} },
    primarySampleRate: (meta) => meta.sampleRate,
    sourceRef: { current: source }, sourceVerificationRef: { current: verifying },
    displayAbortRef: { current: null }, displayRequestIdRef: { current: 0 },
    displayAppliedRequestIdRef: { current: 0 }, displayPreviewReadyRef: { current: false },
    displayRefreshPendingRef: { current: null }, displayRefreshActiveRef: { current: false },
    traceBaselineCacheRef: { current: new Map() }, recordingOverviewCacheRef: { current: cache },
    envelopeWindowCacheRef: { current: [] },
    setDisplay: (display) => displays.push(display), setLoadingSignal: (value) => loading.push(value),
    setFocusedChannel: (update) => { focused = update(focused); }, setToast: (message) => toasts.push(message),
    filters: { enabled: false }, montage: "referential", selectedChannels: new Set([0, 1]),
    hasRecording: true, matlabAnatomicalLayout: false, meta: source.meta,
    signalViewStart: 0, timebase: duration, waveformWidth: 1600,
    verifyingSource: verifying, recordingOverviewRevision: 0,
  };
  if (cachedDetail) {
    const window = envelope(source, { durationSec: duration, bucketCount: 4096, value: 40 });
    env.envelopeWindowCacheRef.current.push({
      source, channelKey: "0,1", startSec: 0, endSec: duration,
      levels: [window], byteLength: 4096 * 2 * 17,
    });
  }
  const execute = new Function(...Object.keys(env), effectCode);
  return {
    env, source, cache, calls, displays, loading, toasts,
    render(changes = {}) {
      Object.assign(env, changes);
      execute(...Object.values(env));
    },
    dispose() { cleanup?.(); },
  };
}

test("5/15-minute views begin their own detail worker during full-file verification", async () => {
  for (const duration of [300, 900]) {
    const h = await harness({ duration });
    h.render();
    assert.equal(h.calls.length, 1, "must not wait for whole-file verification");
    assert.equal(h.env.sourceVerificationRef.current, true);
    assert.ok(h.calls[0].request.durationSec < 3600, "read only the selected region");
    const prefix = h.calls[0].prefix();
    assert.equal(h.loading.at(-1), false, "the first exact prefix removes the blocking loader");
    assert.equal(h.displays.at(-1).refiningOverview, true);
    assert.equal(h.displays.at(-1).unreadAfterSec, prefix.startSec + prefix.durationSec);
    h.calls[0].finish();
    await tick();
    assert.equal(h.displays.at(-1).refiningOverview, undefined);
    assert.equal(h.displays.at(-1).unreadAfterSec, undefined);
    assert.equal(h.displays.at(-1).data[0][0], 30);
    assert.deepEqual(h.toasts, []);
    h.dispose();
  }
});

test("a retained coarse view appears before the deferred detail read completes", async () => {
  const h = await harness({ coarse: true });
  h.render();
  assert.equal(h.calls.length, 1);
  assert.equal(h.loading.at(-1), false);
  assert.equal(h.displays.at(-1).refiningOverview, true);
  assert.equal(h.displays.at(-1).data[0][0], 10);
  const previewCount = h.displays.length;
  h.calls[0].prefix();
  assert.equal(h.displays.length, previewCount, "a short finer prefix must not hide already covered data");
  h.calls[0].finish();
  await tick();
  assert.equal(h.displays.at(-1).data[0][0], 30);
  assert.equal(h.displays.at(-1).refiningOverview, undefined);
  assert.equal(h.loading.at(-1), false);
  h.dispose();
});

test("a foreground prefix uses absolute unread bounds and current channel names", async () => {
  const h = await harness();
  h.source.meta.channelLabels = ["Renamed A1", "Renamed A2"];
  h.render({ signalViewStart: 600 });
  assert.equal(h.calls.length, 1);
  const { request, options } = h.calls[0];
  const count = Math.floor(request.bucketCount / 2);
  const prefix = envelope(h.source, {
    startSec: request.startSec,
    durationSec: request.durationSec * count / request.bucketCount,
    bucketCount: count,
    value: 25,
  });
  prefix.channelLabels = ["Original EDF label 1", "Original EDF label 2"];
  options.onOverview(prefix);
  const display = h.displays.at(-1);
  assert.equal(display.viewStart, 600);
  assert.equal(display.data[0][0], 25);
  assert.equal(display.refiningOverview, true);
  assert.equal(display.unreadAfterSec, prefix.startSec + prefix.durationSec);
  assert.ok(display.unreadAfterSec > 600 && display.unreadAfterSec < 900);
  assert.deepEqual(display.labels, ["Renamed A1", "Renamed A2"], "sidecar names outrank stale worker headers");
  assert.equal(h.loading.at(-1), false);
  h.calls[0].finish();
  await tick();
  assert.equal(h.displays.at(-1).refiningOverview, undefined);
  assert.equal(h.displays.at(-1).unreadAfterSec, undefined);
  assert.deepEqual(h.toasts, []);
  h.dispose();
});

test("background index revisions do not cancel or restart a finer window read", async () => {
  const h = await harness({ coarse: true });
  h.render();
  const request = h.calls[0];
  for (let revision = 1; revision <= 10; revision += 1) h.render({ recordingOverviewRevision: revision });
  assert.equal(request.options.signal.aborted, false);
  assert.equal(h.calls.length, 1);
  request.finish();
  await tick();
  assert.equal(h.displays.at(-1).data[0][0], 30);
  h.dispose();
});

test("superseded view prefixes and results cannot replace the newer view", async () => {
  const h = await harness();
  h.render();
  const old = h.calls[0];
  old.prefix();
  h.render({ signalViewStart: 600 });
  await tick();
  assert.equal(old.options.signal.aborted, true);
  assert.equal(h.calls.length, 2);
  h.calls[1].prefix(0.5, 50);
  const fresh = h.displays.at(-1);
  const count = h.displays.length;
  assert.equal(fresh.viewStart, 600);
  old.prefix(0.9, 99);
  old.finish(99);
  await tick();
  assert.equal(h.displays.length, count);
  assert.equal(h.displays.at(-1), fresh);
  h.calls[1].finish(60);
  await tick();
  assert.equal(h.displays.at(-1).data[0][0], 60);
  assert.equal(h.displays.at(-1).viewStart, 600);
  assert.deepEqual(h.toasts, []);
  h.dispose();
});

test("a completed detail cache remains reusable while verification is active", async () => {
  const h = await harness({ coarse: true, cachedDetail: true });
  h.render();
  await tick();
  assert.equal(h.calls.length, 0, "do not reread a region already cached at sufficient resolution");
  assert.equal(h.displays.at(-1).data[0][0], 40);
  assert.equal(h.displays.at(-1).refiningOverview, undefined);
  assert.equal(h.loading.at(-1), false);
  h.dispose();
});

test("full-file views reuse or await the existing background scan rather than duplicate it", async () => {
  for (const coarse of [false, true]) {
    const h = await harness({ duration: 3600, coarse });
    h.render();
    await tick();
    assert.equal(h.calls.length, 0);
    if (coarse) {
      assert.equal(h.displays.at(-1).data[0][0], 10);
      assert.equal(h.displays.at(-1).refiningOverview, false);
      assert.equal(h.loading.at(-1), false);
    }
    h.dispose();
  }
});
