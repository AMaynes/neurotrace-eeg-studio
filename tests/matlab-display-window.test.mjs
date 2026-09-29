import assert from "node:assert/strict";
import test from "node:test";
import { buildMatlabDisplayWindow, createMatlabRawFlatlineDetector } from "../app/matlab-display-window.ts";
import { filterMatlabDisplayTrace, matlabDisplayDecimationFactor } from "../app/matlab-display-processing.ts";
import { buildMontage, detectRawSynchronizedFlatlines } from "../app/eeg-core.ts";

function fakeSource({ labels = ["LA1", "LA2", "LA3"], rates = [200, 200, 200], duration = 70 } = {}) {
  const arrays = rates.map((rate, ch) => Float64Array.from({ length: Math.floor(duration * rate) }, (_, i) =>
    50 * Math.sin(2 * Math.PI * 7 * i / rate) + 3 * Math.cos(2 * Math.PI * 43 * i / rate) + ch * 0.125 + i / 50000));
  const reads = [];
  return {
    arrays, reads,
    meta: { channelCount: labels.length, channelLabels: labels, channelUnits: labels.map(() => "µV"), sampleRates: rates, durationSec: duration },
    async getWindow(start, span, selected, options = {}) {
      options.signal?.throwIfAborted();
      reads.push({ start, span, selected: [...selected] });
      const first = selected.map((ch) => Math.floor(start * rates[ch]));
      return {
        data: selected.map((ch, position) => arrays[ch].slice(first[position], Math.min(arrays[ch].length, first[position] + Math.ceil(span * rates[ch])))),
        sampleRates: selected.map((ch) => rates[ch]), channelStartSecs: selected.map((ch, position) => first[position] / rates[ch]),
        startSec: start, durationSec: span, channelIndices: [...selected], channelLabels: selected.map((ch) => labels[ch]),
        channelUnits: selected.map(() => "µV"),
      };
    },
  };
}

const testOptions = { fallbackToMainThread: true, maxChunkDurationSec: 0.071, maxChunkBytes: 4096 };

function expectedSignals(source, start, duration, width, indices) {
  return indices.map((ch) => {
    const fs = source.meta.sampleRates[ch];
    const first = Math.floor(start * fs);
    const count = Math.max(0, Math.min(Math.floor(duration * fs), source.arrays[ch].length - first));
    return filterMatlabDisplayTrace(source.arrays[ch].slice(first, first + count), matlabDisplayDecimationFactor(count, width));
  });
}

function assertExactEnvelope(envelope, values, fs, factor, duration) {
  const minima = new Float64Array(envelope.minima.length).fill(Infinity);
  const maxima = new Float64Array(envelope.maxima.length).fill(-Infinity);
  for (let sample = 0; sample < values.length; sample++) {
    const bucket = Math.min(minima.length - 1, Math.floor((sample * factor + 1) * minima.length / (fs * duration)));
    minima[bucket] = Math.min(minima[bucket], values[sample]);
    maxima[bucket] = Math.max(maxima[bucket], values[sample]);
  }
  for (let i = 0; i < minima.length; i++) {
    assert.equal(envelope.minima[i], Number.isFinite(minima[i]) ? minima[i] : NaN, `minimum ${i}`);
    assert.equal(envelope.maxima[i], Number.isFinite(maxima[i]) ? maxima[i] : NaN, `maximum ${i}`);
  }
}

test("streamed MATLAB window exactly matches complete filtering, including fractional start and odd sample count", async () => {
  const source = fakeSource();
  for (const duration of [7.001, 10, 10.009]) {
    const progress = [];
    const request = { source, startSec: 1.006, durationSec: duration, pixelWidth: 1000, channelIndices: [2, 0, 1], montage: "referential" };
    const result = await buildMatlabDisplayWindow(request, { ...testOptions, onProgress: (value) => progress.push(value.fraction) });
    const expected = expectedSignals(source, request.startSec, duration, 1000, request.channelIndices);
    assert.deepEqual(result.data, expected.map((values) => Float64Array.from(values)));
    assert.deepEqual(result.envelopes, [null, null, null]);
    assert.deepEqual(result.labels, ["LA3", "LA1", "LA2"]);
    assert.deepEqual(result.sourceIndices, [[2], [0], [1]]);
    assert.deepEqual(result.sourceStartSampleIndices, [201, 201, 201]);
    assert.deepEqual(result.startSecs, [1.011, 1.011, 1.011]);
    assert.equal(progress.at(-1), 1);
    assert.ok(progress.every((value, i) => i === 0 || value >= progress[i - 1]));
  }
  assert.ok(source.reads.length > 100);
  assert.ok(source.reads.every((read) => read.span < 0.5), "reads stay bounded by block size plus FIR context");
});

test("screen envelopes are extrema of MATLAB-filtered samples, not of raw inputs", async () => {
  const source = fakeSource();
  const request = { source, startSec: 1.003, durationSec: 35.001, pixelWidth: 103, channelIndices: [0, 1, 2], montage: "referential" };
  const result = await buildMatlabDisplayWindow(request, testOptions);
  const expected = expectedSignals(source, request.startSec, request.durationSec, request.pixelWidth, request.channelIndices);
  result.envelopes.forEach((envelope, ch) => {
    assert.ok(envelope);
    assert.equal(envelope.startSec, request.startSec);
    assertExactEnvelope(envelope, expected[ch], 200, 2, request.durationSec);
  });
  assert.ok(result.data.every((values) => values.length === 103));
  assert.ok(result.byteLength < 10_000, "output memory scales with pixels, not full-window samples");
});

test("double-precision bipolar derivation occurs before extrema, preserving cancellations", async () => {
  const source = fakeSource();
  const request = { source, startSec: 1.005, durationSec: 45, pixelWidth: 123, channelIndices: [0, 1, 2], montage: "bipolar" };
  const result = await buildMatlabDisplayWindow(request, testOptions);
  const filtered = expectedSignals(source, request.startSec, request.durationSec, request.pixelWidth, request.channelIndices);
  const derived = buildMontage(filtered, source.meta.channelLabels, "bipolar", new Set(), [100, 100, 100], [1.01, 1.01, 1.01], {
    allChannelLabels: source.meta.channelLabels, sourceChannelIndices: [0, 1, 2], channelUnits: ["µV", "µV", "µV"],
  });
  assert.deepEqual(result.labels, ["LA1-2", "LA2-3"]);
  assert.deepEqual(result.sourceIndices, [[0, 1], [1, 2]]);
  result.envelopes.forEach((envelope, row) => assertExactEnvelope(envelope, derived.data[row], 200, 2, request.durationSec));
  assert.ok(result.envelopes[0].maxima[50] < 0.126, "shared high-amplitude waveform cancels before envelope reduction");
  assert.ok(result.envelopes[0].minima[50] > 0.124);
});

test("mixed-rate referential channels retain separate factors/times; derived mixed-rate modes fail explicitly", async () => {
  const source = fakeSource({ labels: ["LA1", "LA2"], rates: [200, 100] });
  const request = { source, startSec: 2.003, durationSec: 15, pixelWidth: 1000, channelIndices: [0, 1], montage: "referential" };
  const result = await buildMatlabDisplayWindow(request, testOptions);
  assert.deepEqual(result.factors, [2, 1]);
  assert.deepEqual(result.sampleRates, [100, 100]);
  assert.deepEqual(result.startSecs, [2.008, 2.013]);
  assert.deepEqual(result.sourceStartSampleIndices, [400, 200]);
  assert.deepEqual(result.data, expectedSignals(source, request.startSec, request.durationSec, 1000, [0, 1]).map((values) => Float64Array.from(values)));
  await assert.rejects(buildMatlabDisplayWindow({ ...request, montage: "bipolar" }, testOptions), /equal sample rates/);
});

test("EOF counts use actual loaded input length; no fabricated samples are filtered", async () => {
  const source = fakeSource({ duration: 12.005 });
  const request = { source, startSec: 11.008, durationSec: 3, pixelWidth: 1000, channelIndices: [0], montage: "referential" };
  const result = await buildMatlabDisplayWindow(request, testOptions);
  assert.deepEqual(result.data, expectedSignals(source, request.startSec, request.durationSec, 1000, [0]).map((values) => Float64Array.from(values)));
  assert.equal(result.retainedSampleCounts[0], source.arrays[0].length - Math.floor(request.startSec * 200));
});

test("abort prevents further reads and no partial output is returned as a complete view", async () => {
  const source = fakeSource();
  const controller = new AbortController();
  await assert.rejects(buildMatlabDisplayWindow({ source, startSec: 1, durationSec: 40, pixelWidth: 200, channelIndices: [0], montage: "referential" }, {
    ...testOptions, signal: controller.signal,
    onProgress: ({ fraction }) => { if (fraction > 0) controller.abort(); },
  }), { name: "AbortError" });
  assert.equal(source.reads.length, 1);
});

test("streamed raw flatline state exactly matches complete source detection across short overlapping chunks", () => {
  for (const fs of [100, 200, 1000]) {
    const arrays = Array.from({ length: 5 }, (_, ch) => Float64Array.from({ length: 4 * fs + 1 }, (_, i) => {
      if (ch === 4) return Math.sin(i / 3);
      if (i >= 0.4 * fs && i <= 0.65 * fs) return ch;
      if (i >= 1 * fs + ch && i <= 2 * fs + ch) return ch + 10;
      if (i >= 2.5 * fs && i <= 2.8 * fs) return NaN;
      if (i >= 3 * fs) return ch - 2;
      return Math.sin(i / 7);
    }));
    const expected = detectRawSynchronizedFlatlines(arrays, arrays.map(() => fs), { startSec: 10 + 1 / fs })
      .map(({ startSec, endSec }) => ({ startSec, endSec }));
    for (const chunk of [1, 7, 31, 43, 101, 1000]) {
      const detector = createMatlabRawFlatlineDetector(5, fs, 10 + 1 / fs);
      for (let start = 0; start < arrays[0].length; start += chunk) {
        const first = Math.max(0, start - 3);
        detector.push(arrays.map((values) => values.subarray(first, Math.min(values.length, start + chunk))), first);
      }
      assert.deepEqual(detector.finish(), expected, `fs ${fs}, chunk ${chunk}`);
      assert.deepEqual(detector.finish(), expected, "finish is idempotent");
    }
  }
});

test("builder flatline markers use raw samples and MATLAB's plotted +1/fs time shift", async () => {
  const source = fakeSource();
  for (const values of source.arrays) values.fill(17, 200, 401);
  const result = await buildMatlabDisplayWindow({ source, startSec: 0.503, durationSec: 4,
    pixelWidth: 1000, channelIndices: [0, 1, 2], montage: "bipolar" }, testOptions);
  assert.deepEqual(result.flatlineRegions, [{ startSec: 1.008, endSec: 2.008 }]);
});
