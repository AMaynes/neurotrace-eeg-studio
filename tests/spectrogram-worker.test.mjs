import assert from "node:assert/strict";
import test from "node:test";

import {
  BUZCODE_DEFAULT_SMOOTHING_SECONDS,
  BUZCODE_FFT_SIZE,
  BUZCODE_TAPER_COUNT,
  computeAverageSpectrogram,
  computeSpectrogram,
  displaySpectrogramPowers,
  spectrogramTransferList,
  spectrogramReadBounds,
  stableSpectrogramColorLimits,
  thetaRatioOverlay,
} from "../app/spectrogram-compute.ts";
import {
  computeAverageSpectrogramOffThread,
  computeSpectrogramOffThread,
} from "../app/spectrogram-worker-client.ts";

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

test("adapts the analysis window for a valid sub-second deep zoom", () => {
  const sampleRate = 128;
  const data = Float32Array.from({ length: 8 }, (_, index) => Math.sin((2 * Math.PI * index) / 8));
  const result = computeSpectrogram({ data, sampleRate });
  assert.equal(result.windowSize, data.length);
  assert.equal(result.frames, 1);
  assert.equal(result.metrics.finiteFrames, 1);
  assert.ok([...result.powers].some(Number.isFinite));
});

test("returns unique transferable result buffers and validates unsupported input", () => {
  const result = computeSpectrogram({ data: Float32Array.of(1, 2, 3, 4), sampleRate: 4 });
  const transfers = spectrogramTransferList(result);
  assert.deepEqual(transfers, [result.powers.buffer, result.frequencies.buffer, result.times.buffer, result.durations.buffer]);
  assert.equal(new Set(transfers).size, 4);
  assert.throws(() => computeSpectrogram({ data: new Float32Array(), sampleRate: 128 }), /at least one sample/i);
  assert.throws(() => computeSpectrogram({ data: Float32Array.of(1), sampleRate: 1 }), /at least 2 Hz/i);
});

test("averages channel power after transforming each signal independently", () => {
  const sampleRate = 64;
  const first = Float32Array.from({ length: sampleRate * 2 }, (_, index) => (
    Math.sin((2 * Math.PI * 8 * index) / sampleRate)
  ));
  const oppositePhase = Float32Array.from(first, (value) => -value);
  const single = computeSpectrogram({ data: first, sampleRate });
  const averaged = computeAverageSpectrogram({
    signals: [
      { data: first, dataStart: 0, sampleRate },
      { data: oppositePhase, dataStart: 0, sampleRate },
    ],
  });
  assert.equal(averaged.frames, single.frames);
  assert.equal(averaged.bins, single.bins);
  assert.deepEqual([...averaged.powers], [...single.powers]);
  assert.equal(averaged.metrics.inputSamples, first.length + oppositePhase.length);
  assert.throws(() => computeAverageSpectrogram({ signals: [] }), /at least one signal/i);
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
    const result = await computeSpectrogramOffThread({ data: callerData, sampleRate: 8, dataStart: 54 });
    assert.equal(result.dataStart, 54, "the worker preserves recording time");
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

test("covers a partial final second without stretching its time geometry", () => {
  const sampleRate = 128;
  const data = Float32Array.from({ length: 5 * sampleRate + 51 }, (_, i) => Math.sin(i * 0.7));
  const result = computeSpectrogram({ data, sampleRate, dataStart: 54 });
  assert.equal(result.frames, 6);
  assert.equal(result.durations[5], 51 / sampleRate);
  assert.equal(result.times[5] + result.durations[5] / 2, data.length / sampleRate);
  assert.ok([...result.powers].filter((_, i) => i % result.frames === 5).every(Number.isFinite));
});

test("panning preserves shared frame powers, smoothing, and color limits", () => {
  const sampleRate = 64;
  let seed = 17;
  const recording = Float32Array.from({ length: sampleRate * 100 }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.sin(i * 0.2) * (i < sampleRate * 4 ? 100 : 1) + seed / 0xffffffff;
  });
  const calculate = (viewStart) => {
    const bounds = spectrogramReadBounds(viewStart, 5.4, 100);
    assert.equal(bounds.start, Math.floor(bounds.start));
    assert.equal(bounds.start + bounds.duration, Math.ceil(bounds.start + bounds.duration));
    return computeSpectrogram({
      data: recording.slice(bounds.start * sampleRate, (bounds.start + bounds.duration) * sampleRate),
      sampleRate,
      dataStart: bounds.start,
    });
  };
  const before = calculate(34.658);
  const after = calculate(35.719);
  assert.notEqual(before.dataStart, after.dataStart);
  for (const smoothing of [0, 10, 60]) {
    const left = displaySpectrogramPowers(before, smoothing);
    const right = displaySpectrogramPowers(after, smoothing);
    const leftTheta = thetaRatioOverlay(before, smoothing);
    const rightTheta = thetaRatioOverlay(after, smoothing);
    for (let second = 36; second < 40; second += 1) {
      assert.equal(leftTheta[second - before.dataStart], rightTheta[second - after.dataStart]);
      for (let bin = 0; bin < before.bins; bin += 1) {
        assert.equal(
          left[bin * before.frames + second - before.dataStart],
          right[bin * after.frames + second - after.dataStart],
          `same power at ${second}s, bin ${bin}, smoothing ${smoothing}s`,
        );
      }
    }
  }
  const cache = new Map();
  const limits = stableSpectrogramColorLimits(cache, "recording:channel", displaySpectrogramPowers(before, 0));
  assert.equal(stableSpectrogramColorLimits(cache, "recording:channel", Float64Array.of(-100, 100)), limits);
  assert.notDeepEqual(stableSpectrogramColorLimits(cache, "other-channel", Float64Array.of(-100, 100)), limits);
  assert.equal(stableSpectrogramColorLimits(cache, "gap", Float64Array.of(NaN)), null);
  assert.equal(cache.has("gap"), false);
});

test("deep zoom loads whole recording seconds and smoothing does not fill gaps", () => {
  assert.deepEqual(spectrogramReadBounds(54.658, 0.1, 60.2), { start: 23, duration: 37.2 });
  const data = Float32Array.from({ length: 64 * 4 }, (_, i) => Math.sin(i));
  data.fill(NaN, 64, 128);
  const result = computeSpectrogram({ data, sampleRate: 64 });
  const smoothed = displaySpectrogramPowers(result, 10);
  for (let bin = 0; bin < result.bins; bin += 1) {
    assert.ok(Number.isNaN(smoothed[bin * result.frames + 1]));
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

test("client transfers all channel copies for averaged power", async () => {
  const originalWorker = globalThis.Worker;
  let posted;
  class FakeWorker {
    onmessage = null;
    onerror = null;
    postMessage(message, transfers) {
      posted = { message, transfers };
      const result = computeAverageSpectrogram(message.request);
      queueMicrotask(() => this.onmessage?.({
        data: { type: "complete", requestId: message.requestId, result },
      }));
    }
    terminate() {}
  }
  globalThis.Worker = FakeWorker;
  try {
    const signals = [
      { data: Float32Array.from([1, 2, 3, 4]), dataStart: 0, sampleRate: 4 },
      { data: Float32Array.from([4, 3, 2, 1]), dataStart: 0, sampleRate: 4 },
    ];
    await computeAverageSpectrogramOffThread({ signals });
    assert.equal(posted.message.type, "compute-average");
    assert.equal(posted.message.request.signals.length, 2);
    assert.deepEqual(posted.transfers, posted.message.request.signals.map((signal) => signal.data.buffer));
    assert.notEqual(posted.message.request.signals[0].data, signals[0].data);
  } finally {
    globalThis.Worker = originalWorker;
  }
});
