import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { computeMatlabSpectrogram } from "../app/matlab-spectrogram.ts";
import { matlabSpectrogramInputPlan } from "../app/matlab-spectrogram-input.ts";
import { computeFullWindowSpectrogram, spectrogramTileSize, SPECTROGRAM_MAX_COLUMNS, SPECTROGRAM_MAX_TILE_SAMPLES } from "../app/full-window-spectrogram.ts";
import { computeFullWindowSpectrogramOffThread } from "../app/full-window-spectrogram-client.ts";

function plan(count, rate = 200, start = 0, click = start + count / rate / 2) {
  return matlabSpectrogramInputPlan({ channelLabels: ["eeg Fp1"], sampleRates: [rate], durationSec: start + count / rate + 1 }, 0, start, count / rate, click);
}
function samples(length) {
  let state = 17;
  return Float64Array.from({ length }, (_, i) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 2 ** 32 - .5) * (1 + i / length) + Math.sin(i * .4);
  });
}
const withoutMetrics = (result) => Object.fromEntries(Object.entries(result).filter(([key]) => key !== "metrics"));

test("full 120-second view is exact, not a centered 30-second crop", async () => {
  const input = samples(24000), p = plan(input.length, 200, 123.006, 200);
  const reads = [];
  const output = await computeFullWindowSpectrogram(p, async (offset, count) => {
    reads.push([offset, count]); return [input.slice(offset, offset + count)];
  });
  const exact = computeMatlabSpectrogram({ data: [input], sampleRate: p.sampleRate, dataStart: p.dataStart, baselineTime: p.baselineTime });
  assert.deepEqual(withoutMetrics(output), withoutMetrics(exact));
  assert.deepEqual(reads, [[0, 24000]]);
  assert.equal(output.dataStart, 123.011);
  assert.equal(output.times.at(-1), 119.995);
});

test("overlapped tiles approximate full-window Gabor output within measured tolerances, with one baseline", async () => {
  const input = samples(66000), p = plan(input.length, 64, 0, 400);
  const reads = [], progress = [];
  const output = await computeFullWindowSpectrogram(p, async (offset, count) => {
    assert.ok(offset >= 0 && offset + count <= input.length);
    reads.push(count); return [input.slice(offset, offset + count)];
  }, (completed) => progress.push(completed));
  const exact = computeMatlabSpectrogram({ data: [input], sampleRate: 64, dataStart: p.dataStart, baselineTime: p.baselineTime });
  assert.equal(output.tiled, true);
  assert.equal(output.width, SPECTROGRAM_MAX_COLUMNS);
  assert.ok(Math.max(...reads) <= SPECTROGRAM_MAX_TILE_SAMPLES);
  assert.equal(progress.at(-1), input.length);
  assert.equal(output.baselineFrameCount, exact.baselineFrameCount);
  // Compare display-cell averages to the whole-window, independent-length FFT,
  // including cells crossing tile seams and the circular first/last boundary.
  for (let bin = 0; bin < output.height; bin++) {
    // The finite DFT's positive-Nyquist convention has a non-Gaussian endpoint
    // tail near Nyquist. Tiling is explicitly an overview, not bitwise parity.
    const nearNyquist = output.frequencies[bin] > 16;
    assert.ok(Math.abs(output.baselineMean[bin] - exact.baselineMean[bin]) < (nearNyquist ? .001 : 1e-8));
    assert.ok(Math.abs(output.baselineStd[bin] - exact.baselineStd[bin]) < (nearNyquist ? .001 : 1e-8));
    for (let column = 0; column < output.width; column++) {
      const from = Math.ceil(column * input.length / output.width), to = Math.ceil((column + 1) * input.length / output.width);
      let power = 0, z = 0;
      for (let i = from; i < to; i++) { power += exact.power[bin * input.length + i]; z += exact.zScores[bin * input.length + i]; }
      power /= to - from; z /= to - from;
      assert.ok(Math.abs(output.power[bin * output.width + column] - power) < (nearNyquist ? .001 : 1e-9), `power bin ${bin} column ${column}`);
      assert.ok(Math.abs(output.zScores[bin * output.width + column] - z) < (nearNyquist ? .02 : 1e-8), `Z bin ${bin} column ${column}`);
    }
  }
});

test("six-hour coverage is continuous with bounded reads/output and flat input stays neutral", async () => {
  const p = plan(6 * 3600 * 4, 4, 0, 2 * 3600);
  let peakRead = 0, readCount = 0;
  const result = await computeFullWindowSpectrogram(p, async (_offset, count) => {
    peakRead = Math.max(peakRead, count); readCount++; return [new Float64Array(count)];
  });
  assert.ok(readCount > 1 && peakRead <= 65536);
  assert.equal(result.width, 2048);
  assert.equal(result.dataStart + result.times[0] - (result.times[1] - result.times[0]) / 2, 0);
  assert.equal(result.dataStart + result.times.at(-1) + (result.times[1] - result.times[0]) / 2, 21600);
  assert.ok(result.zScores.every((x) => x === 0));
  assert.equal(result.colorLimit, 1);
  assert.ok(result.metrics.outputBytes < 2 * 1024 * 1024);
  assert.ok(spectrogramTileSize(500) * 500 * 8 <= 32 * 1024 * 1024);
});

test("missing samples stay blank and cannot be painted as a finite spectrum", async () => {
  const p = plan(140000, 64, 0, 2000);
  const result = await computeFullWindowSpectrogram(p, async (offset, count) => {
    const data = samples(count);
    if (offset <= 70000 && offset + count > 70000) data[70000 - offset] = NaN;
    return [data];
  });
  assert.ok(result.zScores.some(Number.isNaN));
  assert.ok(result.zScores.some(Number.isFinite));
  assert.ok(result.warnings.some((warning) => warning.includes("missing samples")));
  await assert.rejects(computeFullWindowSpectrogram(plan(100), async () => [new Float32Array(99)]), /requested samples/);
});

test("worker streams bounded owned slices, reports progress and terminates on completion/cancellation/errors", async () => {
  const original = globalThis.Worker, workers = [], progress = [], reads = [];
  class FakeWorker {
    constructor() { workers.push(this); this.messages = []; }
    terminate() { this.terminated = true; }
    postMessage(message, transfer) { this.messages.push({ message, transfer }); }
  }
  globalThis.Worker = FakeWorker;
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  try {
    const p = plan(1000), abort = new AbortController();
    const pending = computeFullWindowSpectrogramOffThread(p, async (offset, count) => {
      reads.push([offset, count]); return [new Float32Array(count)];
    }, { signal: abort.signal, onProgress: (completed) => progress.push(completed) });
    const worker = workers[0];
    assert.deepEqual(worker.messages[0].message, { type: "start", plan: p });
    worker.onmessage({ data: { type: "read", id: 1, offset: 250, count: 100 } }); await tick();
    assert.deepEqual(reads, [[250, 100]]);
    assert.equal(worker.messages[1].transfer[0], worker.messages[1].message.data[0].buffer);
    worker.onmessage({ data: { type: "progress", completed: 500, total: 1000 } });
    assert.deepEqual(progress, [500]);
    worker.onmessage({ data: { type: "complete", result: { metrics: {} } } });
    assert.ok((await pending).metrics.workerRoundTripMs >= 0); assert.equal(worker.terminated, true);
    const cancelled = computeFullWindowSpectrogramOffThread(p, async () => [], { signal: abort.signal });
    abort.abort(); await assert.rejects(cancelled, { name: "AbortError" }); assert.equal(workers[1].terminated, true);
    const malformed = computeFullWindowSpectrogramOffThread(p, async () => []);
    workers[2].onmessage({ data: { type: "read", id: 1, offset: -1, count: 99 } });
    await assert.rejects(malformed, /Invalid spectrogram sample request/); assert.equal(workers[2].terminated, true);
    const failedRead = computeFullWindowSpectrogramOffThread(p, async () => { throw new Error("source unavailable"); });
    workers[3].onmessage({ data: { type: "read", id: 1, offset: 0, count: 99 } });
    await assert.rejects(failedRead, /source unavailable/); assert.equal(workers[3].terminated, true);
  } finally { if (original === undefined) delete globalThis.Worker; else globalThis.Worker = original; }
});

// Execute the production coordinator to verify exact source offsets and stale-work guards.
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(syntax) === "useEffect"
    && node.arguments[0]?.getText(syntax).includes("computeFullWindowSpectrogramOffThread")) effect = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(syntax); assert.ok(effect);
const effectCode = ts.transpileModule(`const run = ${effect.getText(syntax)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + "\nreturn run();";
function harness() {
  const states = [], requests = [], readers = [], p = plan(24000, 200, 100.006, 180);
  const env = { sourceRef: { current: {} }, spectrogramOpen: true, hasRecording: true,
    spectrogramInputPlan: { plan: p, requestKey: "first" }, setSpectrogramState: (value) => states.push(value),
    createMatlabFileReader() { const reader = { disposeCount: 0, dispose() { this.disposeCount++; } }; readers.push(reader); return reader; },
    performanceDiagnostics: { beginDecode: () => ({ update() {}, finish() {}, cancel() {}, fail() {} }) },
    isAbortFailure: (error) => error?.name === "AbortError",
    async readMatlabSourceWindow(_source, start, duration, channels) {
      const first = Math.floor(start * p.sampleRate), count = Math.ceil(duration * p.sampleRate);
      return { channelStartSecs: channels.map(() => first / p.sampleRate), data: channels.map(() => Float32Array.from({ length: count }, (_, i) => first + i)) };
    },
    computeFullWindowSpectrogramOffThread(plan, read, options) {
      return new Promise((resolve, reject) => requests.push({ plan, read, options, resolve, reject }));
    } };
  return { env, states, requests, readers, run: () => new Function(...Object.keys(env), effectCode)(...Object.values(env)) };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("real page supplies full-resolution raw slices at exact source indices, then disposes its reader", async () => {
  const h = harness(), cleanup = h.run(), request = h.requests[0];
  assert.equal(request.plan.sampleCount, 24000);
  const data = await request.read(77, 8);
  assert.deepEqual([...data[0]], Array.from({ length: 8 }, (_, i) => request.plan.firstSourceSample + 77 + i));
  request.options.onProgress(12000, 24000); assert.equal(h.states.at(-1).progress, .5);
  const result = { metrics: { computeMs: 10 } }; request.resolve(result); await tick();
  assert.equal(h.states.at(-1).result, result); assert.equal(h.readers[0].disposeCount, 1);
  cleanup(); assert.equal(request.options.signal.aborted, true);
});

test("cancelled results, progress, and late errors cannot replace a new window", async () => {
  for (const reject of [false, true]) {
    const h = harness(), cancel = h.run(), old = h.requests[0]; cancel();
    h.env.spectrogramInputPlan = { ...h.env.spectrogramInputPlan, requestKey: "second" };
    const cleanup = h.run(), fresh = { metrics: { computeMs: 10 } };
    h.requests[1].resolve(fresh); await tick();
    const count = h.states.length;
    old.options.onProgress(100, 100);
    if (reject) old.reject(new Error("late worker error")); else old.resolve({ metrics: {} });
    await tick(); assert.equal(h.states.length, count); assert.equal(h.states.at(-1).result, fresh);
    assert.equal(h.readers[0].disposeCount >= 1, true); cleanup();
  }
});
