import assert from "node:assert/strict";
import test from "node:test";

import {
  designMatlabDisplayFir,
  filterMatlabDisplayChunk,
  filterMatlabDisplayTrace,
  matlabDisplayChunkInputRange,
  matlabDisplayDecimationFactor,
  processMatlabDisplayTrace,
} from "../app/matlab-display-processing.ts";

// Independent transcription of the supplied .m: explicitly materialize its
// causal output, then its shifted/repeated-tail output, then d(1:factor:end).
// This is equation validation, not a claim to have executed MATLAB itself.
function matlabReference(input, factor) {
  if (factor === 1) return Float64Array.from(input);
  const order = 64;
  const n = Array.from({ length: order + 1 }, (_, i) => i - order / 2);
  const h = n.map((x) => x === 0 ? 0.4 : Math.sin(Math.PI * 0.4 * x) / (Math.PI * x));
  for (let i = 0; i < h.length; i++) h[i] *= 0.5 * (1 - Math.cos(2 * Math.PI * (n[i] + 32) / 64));
  const sum = h.reduce((a, b) => a + b, 0);
  for (let i = 0; i < h.length; i++) h[i] /= sum;
  const causal = new Float64Array(input.length);
  // Input-order convolution is deliberately a different summation order from
  // the production retained-output convolution. Compare with tight tolerance.
  for (let sample = 0; sample < input.length; sample++) {
    for (let tap = 0; tap < h.length && sample + tap < input.length; tap++) {
      causal[sample + tap] += input[sample] * h[tap];
    }
  }
  const shifted = input.length > 32
    ? Float64Array.from({ length: input.length }, (_, i) => causal[Math.min(i + 32, input.length - 1)])
    : causal;
  return shifted.filter((_, i) => i % factor === 0);
}

function near(actual, expected, tolerance = 2e-12) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance * Math.max(1, Math.abs(expected[i])),
      `sample ${i}: ${actual[i]} != ${expected[i]}`);
  }
}

test("MATLAB Hann coefficients retain actual fc=0.2 cycles/sample, not the incorrect comment", () => {
  const h = designMatlabDisplayFir();
  assert.equal(h.length, 65);
  assert.equal(h[0], 0);
  assert.equal(h[64], 0);
  assert.ok(Math.abs(h[32] - 0.40001458100594545) < 1e-15);
  assert.ok(Math.abs(h.reduce((a, b) => a + b, 0) - 1) < 1e-15);
  const gain = (f) => Math.abs(h.reduce((sum, value, i) => sum + value * Math.cos(2 * Math.PI * f * (i - 32)), 0));
  assert.ok(Math.abs(gain(0.2) - 0.5000187616111847) < 1e-14);
  assert.ok(gain(0.1) > 0.999);
  h.fill(99);
  assert.notEqual(designMatlabDisplayFir()[32], 99, "callers cannot mutate cached processing coefficients");
});

test("MATLAB factor uses rounded axis width, 1000-pixel minimum, and never exceeds two", () => {
  for (const width of [0, 200, 999.49, 1000]) {
    assert.equal(matlabDisplayDecimationFactor(1999, width), 1);
    assert.equal(matlabDisplayDecimationFactor(2000, width), 2);
  }
  assert.equal(matlabDisplayDecimationFactor(2000, 1000.49), 2);
  assert.equal(matlabDisplayDecimationFactor(2000, 1000.5), 1);
  assert.equal(matlabDisplayDecimationFactor(2002, 1000.5), 2);
  assert.equal(matlabDisplayDecimationFactor(5999, 3000), 1);
  assert.equal(matlabDisplayDecimationFactor(6000, 3000), 2);
  assert.equal(matlabDisplayDecimationFactor(1_000_000_000, 1000), 2);
  assert.equal(matlabDisplayDecimationFactor(0, 1000), 1);
  assert.throws(() => matlabDisplayDecimationFactor(-1, 1000), /sample count/);
  assert.throws(() => matlabDisplayDecimationFactor(1, NaN), /Axis width/);
});

test("factor one is identity, including empty inputs, precision, NaNs and caller ownership", () => {
  for (const input of [new Float32Array(), new Float32Array([1, NaN, 3]), new Float64Array([1 + 2 ** -40, 3])]) {
    const before = input.slice();
    assert.strictEqual(filterMatlabDisplayTrace(input, 1), input);
    assert.deepEqual(input, before);
  }
});

test("factor two matches independent MATLAB equations for DC, impulses, ramps and sines", () => {
  for (const length of [0, 1, 2, 31, 32, 33, 64, 65, 1999, 2000, 2001, 6001]) {
    for (const kind of ["DC", "ramp", "first", "middle", "last", "sine", "mixture"]) {
      const input = Float64Array.from({ length }, (_, i) => kind === "DC" ? 1
        : kind === "ramp" ? i / 31
        : kind === "first" ? Number(i === 0)
        : kind === "middle" ? Number(i === Math.floor(length / 2))
        : kind === "last" ? Number(i === length - 1)
        : kind === "sine" ? Math.sin(2 * Math.PI * 0.2 * i)
        : Math.sin(2 * Math.PI * 0.05 * i) + 0.8 * Math.cos(2 * Math.PI * 0.3 * i) + i / 700);
      const before = input.slice();
      const actual = filterMatlabDisplayTrace(input, 2);
      assert.ok(actual instanceof Float64Array);
      near(actual, matlabReference(input, 2));
      assert.deepEqual(input, before);
    }
  }
});

test("MATLAB boundary quirks are deliberate: DC transient, repeated tail, final impulse disappears", () => {
  const dc = filterMatlabDisplayTrace(new Float64Array(2000).fill(1), 2);
  assert.ok(Math.abs(dc[0] - 0.7000072905029728) < 1e-14);
  assert.ok(Math.abs(Math.max(...dc) - 1.0946736726701263) < 1e-14);
  const ramp = filterMatlabDisplayTrace(Float64Array.from({ length: 2000 }, (_, i) => i), 2);
  assert.ok(Math.abs(ramp.at(-1) - 1967) < 1e-10);
  assert.ok(ramp.slice(-16).every((value) => value === ramp.at(-1)));
  const finalImpulse = new Float64Array(2000);
  finalImpulse[1999] = 1;
  assert.ok(filterMatlabDisplayTrace(finalImpulse, 2).every((value) => value === 0));
  const shortImpulse = Float64Array.from({ length: 32 }, (_, i) => Number(i === 0));
  near(filterMatlabDisplayTrace(shortImpulse, 2), matlabReference(shortImpulse, 2));
});

test("bounded chunks exactly reproduce whole-window results without resetting FIR history or tail", () => {
  for (const factor of [1, 2]) {
    for (const length of [1, 31, 32, 33, 2000, 2001, 8003]) {
      const input = Float64Array.from({ length }, (_, i) => Math.sin(i / 7) + i / 13);
      const full = filterMatlabDisplayTrace(input, factor);
      for (const chunkSize of [1, 7, 16, 32, 33, 127, 1024]) {
        const reassembled = new Float64Array(full.length);
        for (let start = 0; start < full.length; start += chunkSize) {
          const count = Math.min(chunkSize, full.length - start);
          const range = matlabDisplayChunkInputRange(length, factor, start, count);
          assert.ok(range.endSample - range.firstSample <= chunkSize * factor + 64);
          const chunk = filterMatlabDisplayChunk(input.subarray(range.firstSample, range.endSample), {
            inputSampleCount: length, factor, inputStartIndex: range.firstSample,
            outputStartIndex: start, outputSampleCount: count,
          });
          reassembled.set(chunk, start);
        }
        assert.deepEqual(reassembled, Float64Array.from(full), `factor ${factor}, length ${length}, chunk ${chunkSize}`);
      }
    }
  }
  assert.throws(() => filterMatlabDisplayChunk(new Float64Array(20), { inputSampleCount: 2000, factor: 2 }), /does not cover/);
  assert.throws(() => matlabDisplayChunkInputRange(2000, 2, 999, 2), /exceeds/);
  assert.throws(() => filterMatlabDisplayTrace(new Float32Array(10), 3), /factor/);
});

test("retention is window-relative, while time-axis offset is one original sample at every rate", () => {
  for (const fs of [200, 1000]) {
    for (const start of [0, 1, 101]) {
      for (const length of [1999, 2000, 2001]) {
        const input = Float64Array.from({ length }, (_, i) => Math.sin(i / 3));
        const result = processMatlabDisplayTrace(input, fs, 1000, start);
        const factor = length >= 2000 ? 2 : 1;
        assert.equal(result.factor, factor);
        assert.equal(result.sampleRate, fs / factor);
        assert.equal(result.outputStartSampleIndex, start);
        assert.equal(result.sampleTimeOffsetSec, 1 / fs);
        assert.equal(result.compensatedGroupDelaySamples, factor === 2 ? 32 : 0);
        near(result.data, matlabReference(input, factor));
        assert.equal(result.outputStartSampleIndex / fs + result.sampleTimeOffsetSec, start / fs + 1 / fs);
      }
    }
  }
  assert.throws(() => processMatlabDisplayTrace(new Float32Array(1), 0, 1000), /sample rate/);
  assert.throws(() => processMatlabDisplayTrace(new Float32Array(1), 200, 1000, -1), /start sample index/);
});

test("filtered doubles are not silently rounded to Float32", () => {
  const input = Float64Array.from({ length: 2001 }, (_, i) => 100_000 + Math.sin(i / 3) / 100_000);
  const result = processMatlabDisplayTrace(input, 200, 1000);
  assert.ok(result.data instanceof Float64Array);
  assert.ok(result.data.some((value) => value !== Math.fround(value)));
  near(result.data, matlabReference(input, 2));
});
