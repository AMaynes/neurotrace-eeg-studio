import assert from "node:assert/strict";
import test from "node:test";

import {
  BUZCODE_DEFAULT_SMOOTHING_SECONDS,
  BUZCODE_FFT_SIZE,
  BUZCODE_TAPER_COUNT,
  computeSpectrogram,
  displaySpectrogramPowers,
  spectrogramTransferList,
  thetaRatioOverlay,
} from "../app/spectrogram-compute.ts";
import { computeSpectrogramOffThread } from "../app/spectrogram-worker-client.ts";

test("uses TheStateEditor's one-second five-taper 3072-point spectral layout", () => {
  const sampleRate = 128;
  let noiseState = 0x12345678;
  const data = Float32Array.from({ length: sampleRate * 12 }, (_, index) => {
    noiseState = (1664525 * noiseState + 1013904223) >>> 0;
    const noise = (noiseState / 0xffffffff - 0.5) * 0.35;
    return Math.sin((2 * Math.PI * 10 * index) / sampleRate) + noise;
  });
  const result = computeSpectrogram({ data, sampleRate });
  assert.equal(result.windowSize, sampleRate);
  assert.equal(result.hop, sampleRate);
  assert.equal(result.frames, 12);
  assert.equal(result.fftSize, BUZCODE_FFT_SIZE);
  assert.equal(result.tapers, BUZCODE_TAPER_COUNT);
  assert.ok(result.maxHz < sampleRate / 2);
  assert.ok(result.maxHz > sampleRate / 2 - 1);
  assert.equal(result.metrics.finiteFrames, 12);
  assert.equal(result.powers.length, result.frames * result.bins);
  assert.equal(result.frequencies.length, result.bins);
  assert.equal(result.times.length, result.frames);
  const spacings = [...result.frequencies].slice(1).map((frequency, index) => frequency - result.frequencies[index]);
  assert.ok(spacings.every((spacing) => Math.abs(spacing - 0.5) < 0.02));

  const displayed = displaySpectrogramPowers(result, BUZCODE_DEFAULT_SMOOTHING_SECONDS);
  assert.equal(displayed.length, result.powers.length);
  assert.ok([...displayed].some(Number.isFinite));
  const theta = thetaRatioOverlay(result, BUZCODE_DEFAULT_SMOOTHING_SECONDS);
  assert.equal(theta.length, result.frames);
  assert.ok([...theta].some(Number.isFinite));
});

test("marks frames with less than 75 percent finite coverage as unavailable", () => {
  const data = new Float32Array(64).fill(Number.NaN);
  data.fill(1, 0, 47);
  const result = computeSpectrogram({ data, sampleRate: 64 });
  assert.equal(result.frames, 1);
  assert.ok([...result.powers].every(Number.isNaN));
  assert.equal(result.metrics.finiteFrames, 0);
  assert.equal(result.metrics.dftTerms, 0);
});

test("returns unique transferable result buffers and validates unsupported input", () => {
  const result = computeSpectrogram({ data: Float32Array.of(1, 2, 3, 4), sampleRate: 4 });
  const transfers = spectrogramTransferList(result);
  assert.deepEqual(transfers, [result.powers.buffer, result.frequencies.buffer, result.times.buffer]);
  assert.equal(new Set(transfers).size, 3);
  assert.throws(() => computeSpectrogram({ data: new Float32Array(), sampleRate: 128 }), /at least one sample/i);
  assert.throws(() => computeSpectrogram({ data: Float32Array.of(1), sampleRate: 1 }), /at least 2 Hz/i);
});

test("client transfers an input copy without detaching the caller's signal", async () => {
  const originalWorker = globalThis.Worker;
  let posted;
  let terminated = false;
  class FakeWorker {
    onmessage = null;
    onerror = null;
    postMessage(message, transfers) {
      posted = { message, transfers };
      const result = computeSpectrogram(message.request);
      queueMicrotask(() => this.onmessage?.({
        data: { type: "complete", requestId: message.requestId, result },
      }));
    }
    terminate() { terminated = true; }
  }
  globalThis.Worker = FakeWorker;
  try {
    const callerData = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const result = await computeSpectrogramOffThread({ data: callerData, sampleRate: 8 });
    assert.notEqual(posted.message.request.data, callerData);
    assert.deepEqual([...posted.message.request.data], [...callerData]);
    assert.deepEqual(posted.transfers, [posted.message.request.data.buffer]);
    assert.equal(callerData.byteLength, 32);
    assert.equal(result.powers.length, result.frames * result.bins);
    assert.ok(result.metrics.inputCopyMs >= 0);
    assert.ok(result.metrics.workerRoundTripMs >= 0);
    assert.equal(terminated, true);
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test("client abort terminates the worker and has no main-thread computation fallback", async () => {
  const originalWorker = globalThis.Worker;
  let terminated = false;
  class HangingWorker {
    onmessage = null;
    onerror = null;
    postMessage() {}
    terminate() { terminated = true; }
  }
  globalThis.Worker = HangingWorker;
  try {
    const controller = new AbortController();
    const pending = computeSpectrogramOffThread({ data: Float32Array.of(1, 2), sampleRate: 2 }, { signal: controller.signal });
    controller.abort(new DOMException("superseded", "AbortError"));
    await assert.rejects(pending, (error) => error?.name === "AbortError");
    assert.equal(terminated, true);
  } finally {
    globalThis.Worker = originalWorker;
  }

  globalThis.Worker = undefined;
  try {
    await assert.rejects(
      computeSpectrogramOffThread({ data: Float32Array.of(1, 2), sampleRate: 2 }),
      /does not provide module workers/i,
    );
  } finally {
    globalThis.Worker = originalWorker;
  }
});
