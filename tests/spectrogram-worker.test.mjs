import assert from "node:assert/strict";
import test from "node:test";

import {
  computeSpectrogram,
  spectrogramTransferList,
} from "../app/spectrogram-compute.ts";
import { computeSpectrogramOffThread } from "../app/spectrogram-worker-client.ts";

function originalSpectrogram(data, sampleRate) {
  const nominalWindowSize = Math.min(256, 2 ** Math.floor(Math.log2(Math.max(32, sampleRate))));
  const windowSize = Math.max(1, Math.min(data.length, nominalWindowSize));
  const targetHop = Math.max(1, Math.floor(windowSize / 4));
  const possibleFrames = Math.max(1, Math.floor((data.length - windowSize) / targetHop) + 1);
  const frames = Math.min(90, possibleFrames);
  const hop = frames > 1
    ? Math.max(1, Math.floor((data.length - windowSize) / (frames - 1)))
    : 1;
  const maxHz = Math.min(150, sampleRate / 2);
  const bins = 56;
  const powers = Array.from({ length: bins }, () => Array(frames).fill(Number.NaN));
  for (let frame = 0; frame < frames; frame += 1) {
    const offset = Math.min(Math.max(0, data.length - windowSize), frame * hop);
    let finiteSamples = 0;
    let mean = 0;
    for (let sample = 0; sample < windowSize; sample += 1) {
      const value = data[offset + sample];
      if (!Number.isFinite(value)) continue;
      mean += value;
      finiteSamples += 1;
    }
    if (finiteSamples / windowSize < 0.75) continue;
    mean /= finiteSamples;
    const coverageGain = windowSize / finiteSamples;
    for (let bin = 0; bin < bins; bin += 1) {
      const frequency = Math.exp(Math.log(1) + (bin / (bins - 1)) * Math.log(Math.max(1.01, maxHz)));
      let re = 0;
      let im = 0;
      for (let sample = 0; sample < windowSize; sample += 1) {
        const sourceValue = data[offset + sample];
        if (!Number.isFinite(sourceValue)) continue;
        const value = sourceValue - mean;
        const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * sample) / Math.max(1, windowSize - 1));
        const angle = (2 * Math.PI * frequency * sample) / sampleRate;
        re += value * hann * Math.cos(angle);
        im -= value * hann * Math.sin(angle);
      }
      re *= coverageGain;
      im *= coverageGain;
      powers[bin][frame] = Math.log10(re * re + im * im + 1e-9);
    }
  }
  return { powers, frames, bins, maxHz, windowSize, hop };
}

function assertSameNumber(actual, expected) {
  if (Number.isNaN(expected)) assert.ok(Number.isNaN(actual));
  else assert.equal(actual, expected);
}

test("matches the existing spectrogram algorithm exactly for finite and incomplete frames", () => {
  const data = Float32Array.from({ length: 387 }, (_, index) => (
    index % 19 === 0 ? Number.NaN : Math.sin(index / 6) * 31 + Math.cos(index / 17) * 4
  ));
  for (const sampleRate of [2, 31.5, 128, 512]) {
    const expected = originalSpectrogram(data, sampleRate);
    const actual = computeSpectrogram({ data, sampleRate });
    assert.deepEqual(
      { frames: actual.frames, bins: actual.bins, maxHz: actual.maxHz, windowSize: actual.windowSize, hop: actual.hop },
      { frames: expected.frames, bins: expected.bins, maxHz: expected.maxHz, windowSize: expected.windowSize, hop: expected.hop },
    );
    for (let bin = 0; bin < actual.bins; bin += 1) {
      for (let frame = 0; frame < actual.frames; frame += 1) {
        assertSameNumber(actual.powers[bin * actual.frames + frame], expected.powers[bin][frame]);
      }
    }
    assert.ok(actual.metrics.computeMs >= 0);
    assert.equal(actual.metrics.inputSamples, data.length);
  }
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

test("returns a unique transferable power buffer and validates unsupported input", () => {
  const result = computeSpectrogram({ data: Float32Array.of(1, 2, 3, 4), sampleRate: 4 });
  const transfers = spectrogramTransferList(result);
  assert.deepEqual(transfers, [result.powers.buffer]);
  assert.equal(new Set(transfers).size, 1);
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
