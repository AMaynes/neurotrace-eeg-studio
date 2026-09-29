/** Real page effect, with controlled async builder; numerical pipeline tested separately. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { EDFSource, RawDatSource, mergeNearbyFlatlineRegions } from "../app/eeg-core.ts";
import { bipolarMontageKind } from "../app/bipolar-montage.ts";
import { recordingOverviewDisplayPolicy } from "../app/overview-display-policy.ts";
import { RecordingOverviewCache, recordingOverviewPlan } from "../app/recording-overview.ts";
import { resolveStableTraceBaseline } from "../app/waveform-geometry.ts";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
function collect(node) {
  if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
  ts.forEachChild(node, collect);
}
collect(syntax);
let refreshEffect = declarations.get("refreshWindow");
while (refreshEffect && !(ts.isCallExpression(refreshEffect) && refreshEffect.expression.getText(syntax) === "useEffect")) refreshEffect = refreshEffect.parent;
assert.ok(refreshEffect);
const extracted = [
  ...["EMPTY_DISPLAY", "FLATLINE_DISPLAY_MERGE_GAP_SECONDS"].map((name) => `const ${declarations.get(name).getText(syntax)};`),
  ...["clamp", "isAbortFailure", "readMatlabSourceWindow"].map((name) => declarations.get(name).getText(syntax)),
  ...["displaySettingsKey", "overviewPlanForView", "overviewDisplayPolicy", "overviewRefreshRevision"].map((name) => `const ${declarations.get(name).getText(syntax)};`),
  `${refreshEffect.getText(syntax)};`,
].join("\n");
const effectCode = ts.transpileModule(extracted, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function rawEnvelope(source, value = 10) {
  const count = source.meta.channelCount, buckets = 2048;
  return { startSec: 0, durationSec: source.meta.durationSec, bucketDurationSec: source.meta.durationSec / buckets,
    channelIndices: Array.from({ length: count }, (_, i) => i), channelLabels: [...source.meta.channelLabels], channelUnits: [...source.meta.channelUnits],
    channelStartSecs: Array(count).fill(0), sampleRates: Array(count).fill(buckets / source.meta.durationSec),
    data: Array.from({ length: count }, () => new Float32Array(buckets).fill(value)),
    minima: Array.from({ length: count }, () => new Float32Array(buckets).fill(value - 1)),
    maxima: Array.from({ length: count }, () => new Float32Array(buckets).fill(value + 1)),
    gaps: Array.from({ length: count }, () => new Uint8Array(buckets)) };
}

function processedFixture(request, value) {
  const { source, channelIndices: indices, startSec, durationSec } = request;
  const count = 64;
  return { data: indices.map(() => new Float64Array(count).fill(value)),
    envelopes: indices.map(() => ({ minima: new Float64Array(count).fill(value - 0.5), maxima: new Float64Array(count).fill(value + 0.5),
      gaps: new Uint8Array(count), startSec, bucketDurationSec: durationSec / count })),
    labels: indices.map((i) => source.meta.channelLabels[i]), units: indices.map((i) => source.meta.channelUnits[i]),
    sampleRates: indices.map(() => 500), sourceSampleRates: indices.map(() => 1000), factors: indices.map(() => 2),
    retainedSampleCounts: indices.map(() => durationSec * 500), startSecs: indices.map(() => startSec),
    sourceStartSampleIndices: indices.map(() => Math.floor(startSec * 1000)), sourceIndices: indices.map((i) => [i]), primarySourceIndices: [...indices],
    flatlineRegions: [], warnings: [], byteLength: indices.length * count * 25 };
}

async function harness({ duration = 300, coarse = false, verifying = true, rawDetail = false, readerMetrics = true } = {}) {
  const source = await RawDatSource.create(new File([new Int16Array(100)], "synthetic.dat"), { sampleRate: 10, channelCount: 2, channelLabels: ["A1", "A2"] });
  Object.assign(source.meta, { sampleRate: 1000, sampleRates: [1000, 1000], durationSec: 21600, byteLength: 1024 ** 3 });
  source.getWindow = () => { throw new Error("file-backed decoding must not use the UI-thread fallback"); };
  const cache = new RecordingOverviewCache();
  if (coarse) assert.equal(cache.put(source, rawEnvelope(source), { complete: true }), true);
  const calls = [], displays = [], loading = [], toasts = [], fileCalls = [], legacyFileCalls = [], readers = [], diagnostics = [];
  let dependencies, cleanup, focused = 0;
  const operation = (kind) => (metadata) => {
    const entry = { kind, metadata, updates: [], finishes: [], cancelled: false, failed: false };
    diagnostics.push(entry);
    return { update(value) { entry.updates.push(value); }, finish(value) { entry.finishes.push(value); },
      cancel() { entry.cancelled = true; }, fail() { entry.failed = true; } };
  };
  const builder = (request, options) => new Promise((resolve, reject) => {
    const call = { request, options, ignoreAbort: false,
      finish(value = 30) { const result = processedFixture(request, value); resolve(result); return result; },
      fail(error) { reject(error); },
      readBlock() { return options.readWindow(request.startSec, Math.min(30, request.durationSec), request.channelIndices, { signal: options.signal }); } };
    calls.push(call);
    options.signal.addEventListener("abort", () => { if (!call.ignoreAbort) reject(options.signal.reason); }, { once: true });
  });
  const fileWorker = async (request, options) => {
    legacyFileCalls.push({ request, options });
    return { window: { data: request.channelIndices.map(() => new Float32Array(8)) }, metrics: { bytesRead: 32, totalBytes: 32, readMs: 1, decodeMs: 1 } };
  };
  const createReader = (readerSource, readerOptions) => {
    const reader = { source: readerSource, options: readerOptions, disposed: false, disposeCount: 0, reads: [],
      async readWindow(startSec, durationSec, channelIndices, options) {
        assert.equal(reader.disposed, false, "view reader must stay open between its reads");
        const call = { request: { startSec, durationSec, channelIndices }, options, reader };
        reader.reads.push(call); fileCalls.push(call);
        options.onProgress?.({ bytesRead: 16, totalBytes: 32 });
        options.onProgress?.({ bytesRead: 32, totalBytes: 32 });
        if (readerMetrics) options.onComplete?.({ bytesRead: 32, readMs: 7, decodeMs: 11 });
        return { data: channelIndices.map(() => new Float32Array(8)) };
      },
      dispose() { reader.disposed = true; reader.disposeCount++; },
    };
    readers.push(reader);
    return reader;
  };
  const env = {
    useMemo: (callback) => callback(),
    useEffect(callback, nextDependencies) {
      if (dependencies && nextDependencies.length === dependencies.length && nextDependencies.every((v, i) => Object.is(v, dependencies[i]))) return;
      cleanup?.(); dependencies = nextDependencies; cleanup = callback();
    },
    EDFSource, RawDatSource, bipolarMontageKind, mergeNearbyFlatlineRegions,
    recordingOverviewDisplayPolicy, recordingOverviewPlan, resolveStableTraceBaseline,
    buildMatlabDisplayWindow: builder, createMatlabFileReader: createReader,
    buildEDFFileWindowOffThread: fileWorker, buildRawDatFileWindowOffThread: fileWorker,
    performanceDiagnostics: { beginSourceRead: operation("read"), beginDecode: operation("decode"), recordDecode() {} }, primarySampleRate: (meta) => meta.sampleRate,
    sourceRef: { current: source }, sourceVerificationRef: { current: verifying }, displayAbortRef: { current: null }, displayRequestIdRef: { current: 0 },
    displayAppliedRequestIdRef: { current: 0 }, displayPreviewReadyRef: { current: false }, displayRefreshPendingRef: { current: null }, displayRefreshActiveRef: { current: false },
    traceBaselineCacheRef: { current: new Map() }, recordingOverviewCacheRef: { current: cache },
    envelopeWindowCacheRef: { current: rawDetail ? [{ source, channelKey: "0,1", startSec: 0, endSec: duration, levels: [rawEnvelope(source, 40)], byteLength: 2048 * 2 * 17 }] : [] },
    matlabWindowCacheRef: { current: [] }, setDisplay: (display) => displays.push(display), setLoadingSignal: (value) => loading.push(value),
    setFocusedChannel: (update) => { focused = update(focused); }, setToast: (message) => toasts.push(message),
    filters: { enabled: false }, montage: "referential", selectedChannels: new Set([0, 1]), hasRecording: true, matlabAnatomicalLayout: false, meta: source.meta,
    signalViewStart: 0, timebase: duration, waveformWidth: 1600, verifyingSource: verifying, recordingOverviewRevision: 0,
  };
  const execute = new Function(...Object.keys(env), effectCode);
  return { env, source, cache, calls, displays, loading, toasts, fileCalls, legacyFileCalls, readers, diagnostics,
    render(changes = {}) { Object.assign(env, changes); execute(...Object.values(env)); }, dispose() { cleanup?.(); } };
}

test("5/15-minute default views start exact MATLAB processing without awaiting file validation", async () => {
  for (const duration of [300, 900]) {
    const h = await harness({ duration }); h.render();
    assert.equal(h.calls.length, 1); assert.equal(h.env.sourceVerificationRef.current, true);
    assert.equal(h.calls[0].request.durationSec, duration); assert.equal(h.calls[0].request.pixelWidth, 1600);
    assert.equal(h.calls[0].options.fallbackToMainThread, false); assert.equal(h.loading.at(-1), true);
    assert.equal(h.displays.length, 0, "unfinished/raw data cannot masquerade as MATLAB filtering");
    h.calls[0].finish(); await tick();
    const display = h.displays.at(-1);
    assert.equal(display.data[0][0], 30); assert.equal(display.timingConvention, "matlab-window"); assert.equal(display.viewStart, 0);
    assert.deepEqual(JSON.parse(display.settingsKey), [h.source.meta.id, "referential", { enabled: false }, [0, 1]]);
    assert.equal(h.loading.at(-1), false); assert.deepEqual(h.toasts, []); h.dispose();
  }
});

test("cached raw overview/detail are never substituted for MATLAB-filtered waveform output", async () => {
  const h = await harness({ coarse: true, rawDetail: true }); h.render();
  assert.equal(h.calls.length, 1); assert.equal(h.displays.length, 0, "raw index remains session-map data, not an FIR preview");
  assert.equal(h.calls[0].options.onOverview, undefined);
  h.calls[0].finish(35); await tick(); assert.equal(h.displays.at(-1).data[0][0], 35); assert.equal(h.loading.at(-1), false); h.dispose();
});

test("requested origin and current source labels survive exact-view publication", async () => {
  const h = await harness(); h.source.meta.channelLabels = ["Renamed A1", "Renamed A2"]; h.render({ signalViewStart: 600.005 });
  assert.equal(h.calls[0].request.startSec, 600.005); assert.deepEqual(h.calls[0].request.allChannelLabels, ["Renamed A1", "Renamed A2"]);
  h.calls[0].finish(); await tick(); assert.equal(h.displays.at(-1).viewStart, 600.005);
  assert.deepEqual(h.displays.at(-1).labels, ["Renamed A1", "Renamed A2"]); assert.equal(h.displays.at(-1).unreadAfterSec, undefined); h.dispose();
});

test("background raw-index revisions cannot cancel/restart exact MATLAB window processing", async () => {
  const h = await harness({ coarse: true }); h.render(); const request = h.calls[0];
  for (let revision = 1; revision <= 10; revision++) h.render({ recordingOverviewRevision: revision });
  assert.equal(request.options.signal.aborted, false); assert.equal(h.calls.length, 1);
  request.finish(); await tick(); assert.equal(h.displays.at(-1).data[0][0], 30); h.dispose();
});

test("superseded exact requests are cancelled and cannot publish over the newer window", async () => {
  const h = await harness(); h.render(); const old = h.calls[0]; h.render({ signalViewStart: 600 }); await tick();
  assert.equal(old.options.signal.aborted, true); assert.equal(h.calls.length, 2);
  assert.equal(h.readers[0].disposeCount, 1, "cancelled view closes its reader in finally");
  h.calls[1].finish(60); await tick(); const fresh = h.displays.at(-1), count = h.displays.length;
  old.finish(99); await tick(); assert.equal(h.displays.length, count); assert.equal(h.displays.at(-1), fresh);
  assert.equal(fresh.data[0][0], 60); assert.equal(fresh.viewStart, 600); assert.deepEqual(h.toasts, []); h.dispose();
});

test("completed exact-view cache survives verification changes; changed width/window require new FIR request", async () => {
  const h = await harness({ coarse: true }); h.render(); h.calls[0].finish(40); await tick();
  h.render({ verifyingSource: false }); await tick(); assert.equal(h.calls.length, 1); assert.equal(h.displays.at(-1).data[0][0], 40);
  assert.equal(h.readers.length, 1, "cached view creates no new reader");
  h.render({ waveformWidth: 1900 }); await tick(); assert.equal(h.calls.length, 2, "width can change MATLAB decimation");
  h.calls[1].finish(50); await tick(); h.render({ signalViewStart: 1 }); await tick();
  assert.equal(h.calls.length, 3, "changed start changes zero-state FIR boundary"); h.calls[2].finish(60); await tick(); h.dispose();
});

test("six-hour requests retain their full extent and never reuse unfiltered session-map envelopes", async () => {
  for (const coarse of [false, true]) {
    const h = await harness({ duration: 21600, coarse }); h.render();
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].request.durationSec, 21600); assert.equal(h.calls[0].request.startSec, 0);
    assert.equal(h.calls[0].options.maxChunkDurationSec, 30); assert.equal(h.displays.length, 0);
    h.calls[0].finish(45); await tick(); assert.equal(h.displays.at(-1).envelopes[0].bucketDurationSec * 64, 21600);
    assert.equal(h.displays.at(-1).data[0][0], 45); h.dispose();
  }
});

test("source adapter reuses one reader for bounded reads, forwards metrics/cancellation, and disposes it", async () => {
  const h = await harness(); h.render(); await h.calls[0].readBlock(); await h.calls[0].readBlock();
  assert.equal(h.readers.length, 1); assert.equal(h.readers[0].reads.length, 2);
  assert.equal(h.readers[0].source, h.source); assert.equal(h.readers[0].options.signal, h.calls[0].options.signal);
  assert.equal(h.fileCalls.length, 2); assert.equal(h.fileCalls[0].options.fallbackToMainThread, false);
  assert.equal(h.fileCalls[0].options.signal, h.calls[0].options.signal); assert.equal(h.fileCalls[0].request.durationSec, 30);
  assert.deepEqual(h.fileCalls[0].request.channelIndices, [0, 1]); assert.equal(h.legacyFileCalls.length, 0, "no per-block one-shot worker path");
  const reads = h.diagnostics.filter((entry) => entry.kind === "read");
  const decodes = h.diagnostics.filter((entry) => entry.metadata.label === "MATLAB source decoding");
  assert.equal(reads.length, 2); assert.equal(decodes.length, 2);
  for (const entry of reads) {
    assert.deepEqual(entry.updates.map((value) => value.completedBytes), [16, 32]);
    assert.deepEqual(entry.finishes, [{ completedBytes: 32, durationMs: 7 }]);
  }
  for (const entry of decodes) assert.deepEqual(entry.finishes, [{ completedBytes: 32, durationMs: 11 }]);
  assert.equal(h.readers[0].disposed, false); h.calls[0].finish(); await tick();
  assert.equal(h.readers[0].disposeCount, 1); h.dispose();
});

test("worker failure clears loading without labeling raw data as MATLAB output", async () => {
  const h = await harness({ coarse: true }); h.render(); h.calls[0].fail(new Error("MATLAB display worker unavailable")); await tick();
  assert.equal(h.loading.at(-1), false); assert.deepEqual(h.displays.at(-1).data, []);
  assert.equal(h.readers[0].disposeCount, 1, "failed processing releases the persistent source reader");
  assert.deepEqual(h.toasts, ["MATLAB display worker unavailable"]); h.dispose();
});

test("reader without worker metrics reports decoded allocation once without inventing source bytes", async () => {
  const h = await harness({ readerMetrics: false }); h.render(); await h.calls[0].readBlock();
  assert.deepEqual(h.diagnostics.find((entry) => entry.kind === "read").finishes, [{ completedBytes: 0 }]);
  assert.deepEqual(h.diagnostics.find((entry) => entry.metadata.label === "MATLAB source decoding").finishes, [{ completedBytes: 64 }]);
  h.calls[0].finish(); await tick(); h.dispose();
});

test("late completion after cancellation neither populates exact cache nor publishes a stale view", async () => {
  const h = await harness(); h.render(); const old = h.calls[0]; old.ignoreAbort = true;
  h.render({ signalViewStart: 600 }); old.finish(99); await tick();
  assert.equal(h.env.matlabWindowCacheRef.current.length, 0);
  assert.equal(h.displays.length, 0); assert.equal(h.readers[0].disposeCount, 1);
  assert.equal(h.calls.length, 2); h.calls[1].finish(70); await tick();
  assert.equal(h.displays.at(-1).data[0][0], 70); assert.equal(h.env.matlabWindowCacheRef.current.length, 1);
  h.dispose();
});
