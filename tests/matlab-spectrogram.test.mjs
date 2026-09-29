import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  computeMatlabGaborCoefficients, computeMatlabSpectrogram, matlabPercentile,
  matlabSpectrogramTransferList, validateMatlabSpectrogramRequest,
} from "../app/matlab-spectrogram.ts";
import { computeMatlabSpectrogramOffThread } from "../app/matlab-spectrogram-worker-client.ts";

// Independent O(N²) direct DFT oracle. Test signals are small; production uses
// radix-2/Bluestein. Explicit complex sums detect phase, odd/even, and FFT-grid
// mistakes instead of comparing two paths through the same FFT implementation.
function directGabor(input, rate, frequency) {
  const n = input.length;
  const scale = 5 / frequency;
  const valid = scale >= 5 / (rate * 5 / 5.5) && scale <= n / rate;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  if (!valid) return { re, im };
  const spectrum = Array.from({ length: n }, (_, k) => {
    let real = 0;
    let imaginary = 0;
    input.forEach((value, j) => {
      real += value * Math.cos(-2 * Math.PI * j * k / n);
      imaginary += value * Math.sin(-2 * Math.PI * j * k / n);
    });
    const signedBin = k <= Math.floor(n / 2) ? k : k - n;
    const multiplier = Math.pow(4 * Math.PI, 0.25) * Math.sqrt(scale)
      * Math.exp(-0.5 * Math.pow(scale * signedBin * rate / n - 5, 2));
    return [real * multiplier, imaginary * multiplier];
  });
  for (let j = 0; j < n; j += 1) {
    spectrum.forEach(([real, imaginary], k) => {
      const angle = 2 * Math.PI * j * k / n;
      re[j] += (real * Math.cos(angle) - imaginary * Math.sin(angle)) / n;
      im[j] += (real * Math.sin(angle) + imaginary * Math.cos(angle)) / n;
    });
  }
  return { re, im };
}

function close(actual, expected, tolerance = 2e-10, message = "numeric match") {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${message}: ${actual} != ${expected}`);
}

const request = (data, sampleRate = 8, overrides = {}) => ({
  data: [Float64Array.from(data)], sampleRate, dataStart: 10, baselineTime: 11, ...overrides,
});

test("exact complex coefficients match independent DFT for odd, even, prime and radix-2 sizes", () => {
  for (const n of [7, 8, 9, 10, 16, 31, 32, 257]) {
    const input = Float64Array.from({ length: n }, (_, j) => Math.sin(j * 1.7) + 0.2 * j + (j === n - 1 ? 2 : 0));
    for (const frequency of [0.1, 3, 6, 7.25]) {
      const expected = directGabor(input, 8, frequency);
      const actual = computeMatlabGaborCoefficients(input, 8, frequency);
      actual.real.forEach((value, j) => close(value, expected.re[j], 2e-11, `real N=${n}, f=${frequency}, j=${j}`));
      actual.imaginary.forEach((value, j) => close(value, expected.im[j], 2e-11, `imaginary N=${n}, f=${frequency}, j=${j}`));
    }
  }
});

test("circular endpoint response and positive even-N Nyquist match the reference without padding", () => {
  const impulse = Float64Array.from({ length: 16 }, (_, j) => j === 15 ? 1 : 0);
  const output = computeMatlabGaborCoefficients(impulse, 16, 6);
  const expected = directGabor(impulse, 16, 6);
  close(output.real[0], expected.re[0]);
  assert.ok(Math.abs(output.real[0]) > 0.01, "circular edge response is not silently replaced by zero padding");
  const nyquist = Float64Array.from({ length: 16 }, (_, j) => (-1) ** j);
  const coefficients = computeMatlabGaborCoefficients(nyquist, 16, 8);
  const gain = (4 * Math.PI) ** 0.25 * Math.sqrt(5 / 8);
  coefficients.real.forEach((value, j) => close(value, nyquist[j] * gain));
  coefficients.imaginary.forEach((value) => close(value, 0));
});

test("recording-sized prime and composite transforms match an analytic periodic-tone oracle", () => {
  // A bin-centered real sinusoid has only two nonzero DFT bins. This oracle
  // needs no FFT/DFT implementation and exercises the real 30-second sizes.
  for (const [samples, rate, bin] of [[6000, 200, 337], [6001, 200, 337], [30001, 1000, 611]]) {
    const toneHz = bin * rate / samples;
    const frequency = toneHz * 0.91;
    const scale = 5 / frequency;
    const phase = 0.73;
    const amplitude = 17;
    const dc = 3;
    const response = (omega) => (4 * Math.PI) ** 0.25 * Math.sqrt(scale)
      * Math.exp(-0.5 * (scale * omega - 5) ** 2);
    const positiveGain = response(toneHz);
    const negativeGain = response(-toneHz);
    const input = Float64Array.from({ length: samples }, (_, j) => dc + amplitude * Math.cos(2 * Math.PI * bin * j / samples + phase));
    const result = computeMatlabGaborCoefficients(input, rate, frequency);
    assert.equal(result.validScale, true);
    for (let j = 0; j < samples; j += 1) {
      const angle = 2 * Math.PI * bin * j / samples + phase;
      close(result.real[j], dc * response(0) + amplitude / 2 * (positiveGain + negativeGain) * Math.cos(angle), 3e-10);
      close(result.imaginary[j], amplitude / 2 * (positiveGain - negativeGain) * Math.sin(angle), 3e-10);
    }
  }
});

test("fixed logspace bins, unmasked Gaussian DC tail, and MATLAB scale validity are preserved", () => {
  const dc = new Float64Array(16).fill(1);
  const result = computeMatlabSpectrogram(request(dc, 1000));
  assert.equal(result.frequencies.length, 60);
  assert.equal(result.frequencies[0], 1);
  assert.equal(result.frequencies[59], 150);
  result.frequencies.forEach((frequency, k) => close(frequency, 10 ** (Math.log10(150) * k / 59)));
  const coeff = computeMatlabGaborCoefficients(dc, 8, 3);
  close(coeff.real[0], (4 * Math.PI) ** 0.25 * Math.sqrt(5 / 3) * Math.exp(-12.5), 1e-14);
  assert.ok(coeff.real[0] > 0, "negative-frequency/DC terms are not analytically masked away");
  const lower = computeMatlabGaborCoefficients(dc, 8, 2.5);
  const upper = computeMatlabGaborCoefficients(dc, 8, 8 * 5 / 5.5);
  assert.equal(lower.validScale, true);
  assert.equal(upper.validScale, true);
  assert.equal(computeMatlabGaborCoefficients(dc, 8, 2.49).validScale, false);
  assert.equal(computeMatlabGaborCoefficients(dc, 8, 8).validScale, false);
  assert.ok(!result.warnings.some((warning) => /Nyquist/.test(warning)));
});

test("frequency output preserves original centers but never exceeds the recording's Nyquist limit", () => {
  const data = Float64Array.from({ length: 65 }, (_, index) => Math.sin(index * .7));
  const originalCenters = Array.from({ length: 60 }, (_, index) =>
    index === 59 ? 150 : 10 ** (index * Math.log10(150) / 59));
  for (const rate of [2, 2.1, 4, 8, 64, 100, 128, 200, 256, 299, 300, 1000]) {
    const result = computeMatlabSpectrogram(request(data, rate));
    const expected = originalCenters.filter((frequency) => frequency <= Math.min(150, rate / 2));
    assert.deepEqual([...result.frequencies], expected, `retained centers for ${rate} Hz sample rate`);
    assert.equal(result.height, expected.length);
    assert.equal(result.power.length, result.width * result.height);
    assert.equal(result.zScores.length, result.width * result.height);
    assert.ok(result.frequencies.every((frequency) => frequency <= rate / 2));
    assert.equal(result.warnings.some((warning) => /Nyquist limit are omitted/.test(warning)), rate < 300);
    assert.ok(!result.warnings.some((warning) => /retained to match/.test(warning)));
    assert.equal(matlabSpectrogramTransferList(result).reduce((sum, buffer) => sum + buffer.byteLength, 0), result.metrics.outputBytes);
    assert.ok(Number.isFinite(result.colorLimit));
  }
  const edf = computeMatlabSpectrogram(request(data, 200));
  assert.equal(edf.height, 55);
  close(edf.frequencies.at(-1), 98.10174794722279);
  assert.deepEqual([...computeMatlabSpectrogram(request(data, 2)).frequencies], [1]);
});

test("removing unsupported bins leaves retained MATLAB power and Z-score reference numbers unchanged", () => {
  const data = Float64Array.from({ length: 65 }, (_, index) =>
    Math.sin(index * .67) + (index > 35 ? 2 : 1) * Math.cos(index * 1.5) + index / 17);
  const result = computeMatlabSpectrogram(request(data, 200, { baselineTime: 10.16 }));
  // Frozen pre-cap reference values, additionally checked against the
  // independent direct-DFT oracle below. Only the discarded rows change.
  const references = [
    { bin: 35, frequency: 19.53896677301786,
      power: [0.010550384690540569, 0.19035449365181195, 0.018841691055566313],
      scores: [-1.6040600766645245, 0.686881111301915, -1.1447911633548522],
      mean: -10.971052851626974, deviation: 5.483749844327542 },
    { bin: 46, frequency: 49.729434882916706,
      power: [0.025841572438290286, 0.09770780413434996, 0.07015865345090487],
      scores: [-1.0319040568398916, 0.5349565230863516, 0.1447457409913469],
      mean: -12.072780865516776, deviation: 3.6864180767587467 },
    { bin: 54, frequency: 98.10174794722279,
      power: [0.0011958791951434844, 0.00030746604147778816, 0.0010290987339829582],
      scores: [2.6119067749524905, 1.2646167512571063, 2.4629229569012367],
      mean: -40.658957804509065, deviation: 4.378345743024903 },
  ];
  for (const reference of references) {
    // log/pow can differ by an ULP across JS engines/platforms. The frozen
    // center must agree numerically, not require identical last-bit rounding.
    close(result.frequencies[reference.bin], reference.frequency, 1e-13);
    close(result.baselineMean[reference.bin], reference.mean, 1e-12);
    close(result.baselineStd[reference.bin], reference.deviation, 1e-12);
    [0, 31, 64].forEach((sample, index) => {
      close(result.power[reference.bin * result.width + sample], reference.power[index], 1e-12);
      close(result.zScores[reference.bin * result.width + sample], reference.scores[index], 1e-12);
    });
  }
  for (let bin = 0; bin < result.height; bin += 1) {
    const reference = directGabor(data, 200, result.frequencies[bin]);
    for (let sample = 0; sample < result.width; sample += 1) {
      close(result.power[bin * result.width + sample], reference.re[sample] ** 2 + reference.im[sample] ** 2, 3e-11);
    }
  }
});

test("rates below the one-Hz grid fail clearly before any worker or large calculation", async () => {
  const input = [1, 2, 4, 3, -1, 5, 2, 0];
  for (const rate of [Number.MIN_VALUE, 0.1, 1, 1.999999999]) {
    assert.throws(() => validateMatlabSpectrogramRequest(request(input, rate)), /Nyquist limit is below the 1 Hz minimum/);
    assert.throws(() => computeMatlabSpectrogram(request(input, rate)), /Nyquist limit is below the 1 Hz minimum/);
    await assert.rejects(computeMatlabSpectrogramOffThread(request(input, rate)), /Nyquist limit is below the 1 Hz minimum/);
  }
  for (const rate of [0, -1, NaN, Infinity, -Infinity]) {
    assert.throws(() => validateMatlabSpectrogramRequest(request(input, rate)), /positive sample rate/);
  }
});

test("group averaging is over channel power, followed by exact epsilon log and sample-std baseline", () => {
  const a = Float64Array.from({ length: 17 }, (_, j) => Math.sin(j * 1.2) + j / 13);
  const b = Float64Array.from(a, (value) => -value);
  const result = computeMatlabSpectrogram(request(a, 8, { data: [a, b], baselineTime: 10.75 }));
  assert.equal(result.baselineFrameCount, 6);
  assert.equal(result.usedBaselineFallback, false);
  assert.equal(result.dataStart, 10);
  assert.equal(result.sampleRate, 8);
  assert.deepEqual([...result.times], Array.from({ length: 17 }, (_, j) => j / 8));
  for (let k = 0; k < result.height; k += 1) {
    const expected = directGabor(a, 8, result.frequencies[k]);
    const db = [];
    for (let j = 0; j < result.width; j += 1) {
      const power = expected.re[j] ** 2 + expected.im[j] ** 2;
      close(result.power[k * result.width + j], power, 3e-10);
      db.push(10 * Math.log10(power + 2 ** -52));
    }
    const mean = db[0] + db.slice(0, 6).reduce((sum, value) => sum + value - db[0], 0) / 6;
    const std = Math.max(2 ** -52, Math.sqrt(db.slice(0, 6).reduce((sum, value) => sum + (value - mean) ** 2, 0) / 5));
    close(result.baselineMean[k], mean);
    close(result.baselineStd[k], std);
    for (let j = 0; j < result.width; j += 1) close(result.zScores[k * result.width + j], (db[j] - mean) / std, 2e-8);
  }
  assert.ok(result.power.some((value) => value > 0.1), "opposite-phase channels do not cancel before power averaging");
  close(result.colorLimit, Math.max(1, matlabPercentile(Float64Array.from(result.zScores, Math.abs), 98)));
});

test("baseline fallback reproduces strict t < t(round(end/2)), including odd and even lengths", () => {
  for (const n of [7, 8, 9, 10]) {
    const input = Float64Array.from({ length: n }, (_, j) => Math.sin(j));
    const output = computeMatlabSpectrogram(request(input, 8, { baselineTime: 10 }));
    assert.equal(output.usedBaselineFallback, true);
    assert.equal(output.baselineFrameCount, Math.round(n / 2) - 1);
  }
  const longOrigin = computeMatlabSpectrogram(request(Array.from({ length: 16 }, (_, j) => Math.sin(j)), 1000,
    { dataStart: 14400, baselineTime: 14400.006 }));
  assert.equal(longOrigin.baselineFrameCount, 6, "hour-scale subtraction roundoff must not include the clicked sample");
});

test("clicked-sample baseline boundaries stay exact across fractional and hour-scale origins", () => {
  const input = Float64Array.from({ length: 21 }, (_, index) => Math.sin(index / 3) + index / 10);
  for (const origin of [0.0073, 12345.6789, 86399.997]) for (const rate of [200, 256, 1000]) {
    for (const clickedIndex of [0, 4, 5, 6, 19, 20]) {
      const output = computeMatlabSpectrogram(request(input, rate,
        { dataStart: origin, baselineTime: origin + clickedIndex / rate }));
      assert.equal(output.usedBaselineFallback, clickedIndex < 5);
      assert.equal(output.baselineFrameCount, clickedIndex < 5 ? 10 : clickedIndex,
        `strict pre-click count at ${origin}s, ${rate}Hz, sample ${clickedIndex}`);
    }
  }
});

test("percentile uses midpoint ranks and keeps at least symmetric ±1 limits", () => {
  assert.equal(matlabPercentile(Float64Array.of(1, 2, 3, 4), 25), 1.5);
  assert.equal(matlabPercentile(Float64Array.of(1, 2, 3, 4), 98), 4);
  assert.equal(matlabPercentile(Float64Array.of(1, 2, 3, 4), 50), 2.5);
  for (const length of [16, 1001]) {
    const flat = computeMatlabSpectrogram(request(new Float64Array(length), 1000, { baselineTime: 10.5 }));
    assert.ok(flat.zScores.every((value) => value === 0));
    assert.equal(flat.colorLimit, 1);
    assert.ok(flat.baselineStd.every((value) => value === 2 ** -52));
  }
});

test("input is immutable, exact output buffers transfer once, and invalid/oversized work is rejected", () => {
  const input = Float32Array.of(1, 3, 2, 7, 4, 1, -1, 0);
  const before = input.slice();
  const output = computeMatlabSpectrogram(request(input, 8));
  assert.deepEqual(input, before);
  const transfers = matlabSpectrogramTransferList(output);
  assert.equal(new Set(transfers).size, transfers.length);
  assert.equal(transfers.reduce((sum, buffer) => sum + buffer.byteLength, 0), output.metrics.outputBytes);
  assert.throws(() => computeMatlabSpectrogram(request([1, NaN, 3, 4])), /missing\/non-finite/);
  assert.throws(() => computeMatlabGaborCoefficients(Float64Array.of(1, NaN, 3, 4), 1000, 1), /missing\/non-finite/);
  assert.throws(() => computeMatlabSpectrogram(request(new Float64Array(16).fill(1e308))), /supported numeric range/);
  assert.throws(() => validateMatlabSpectrogramRequest(request([1, 2, 3], 0)), /positive sample rate/);
  assert.throws(() => validateMatlabSpectrogramRequest(request([1, 2, 3], 8, { data: [new Float64Array(3), new Float64Array(4)] })), /synchronized/);
  assert.throws(() => validateMatlabSpectrogramRequest(request(new Float64Array(200_000), 1000)), /memory budget.*Zoom in/);
});

test("worker client transfers private copies, surfaces errors, and cancels by terminating without fallback", async () => {
  const originalWorker = globalThis.Worker;
  const workers = [];
  class FakeWorker {
    constructor() { workers.push(this); }
    terminate() { this.terminated = true; }
    postMessage(message, transfer) { this.message = message; this.transfer = transfer; }
  }
  globalThis.Worker = FakeWorker;
  try {
    const input = request([1, 2, 4, 1, -2, 5, 3, 1]);
    const abort = new AbortController();
    const pending = computeMatlabSpectrogramOffThread(input, { signal: abort.signal });
    const worker = workers[0];
    assert.notEqual(worker.message.request.data[0], input.data[0]);
    assert.equal(worker.transfer[0], worker.message.request.data[0].buffer);
    assert.notEqual(worker.transfer[0], input.data[0].buffer);
    abort.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(worker.terminated, true);
    const success = computeMatlabSpectrogramOffThread(input);
    const second = workers[1];
    second.onmessage({ data: { type: "complete", requestId: second.message.requestId, result: computeMatlabSpectrogram(input) } });
    assert.equal((await success).width, 8);
    assert.equal(second.terminated, true);
    const failure = computeMatlabSpectrogramOffThread(input);
    const third = workers[2];
    third.onmessage({ data: { type: "error", requestId: third.message.requestId, name: "RangeError", message: "bad input" } });
    await assert.rejects(failure, /bad input/);
    assert.equal(third.terminated, true);
    delete globalThis.Worker;
    await assert.rejects(computeMatlabSpectrogramOffThread(input), /does not provide module workers/);
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
  }
  const workerSource = await readFile(new URL("../app/matlab-spectrogram-worker.ts", import.meta.url), "utf8");
  assert.match(workerSource, /computeMatlabSpectrogram\(data.request\)/);
  assert.match(workerSource, /matlabSpectrogramTransferList\(result\)/);
});

test("worker errors, uncloneable inputs, and pre-aborts release resources without hanging", async () => {
  const originalWorker = globalThis.Worker;
  const workers = [];
  let failPost = false;
  class FakeWorker {
    constructor() { workers.push(this); }
    terminate() { this.terminated = true; }
    postMessage(message) {
      if (failPost) throw new DOMException("transfer failed", "DataCloneError");
      this.message = message;
    }
  }
  globalThis.Worker = FakeWorker;
  try {
    const input = request([1, 2, 4, 1, -2, 5, 3, 1]);
    const preAborted = new AbortController();
    preAborted.abort(new Error("obsolete request"));
    await assert.rejects(computeMatlabSpectrogramOffThread(input, { signal: preAborted.signal }), /obsolete request/);
    assert.equal(workers.length, 0);

    const loadFailure = computeMatlabSpectrogramOffThread(input);
    let prevented = false;
    workers[0].onerror({ message: "worker asset unavailable", preventDefault() { prevented = true; } });
    await assert.rejects(loadFailure, { name: "WorkerError", message: "worker asset unavailable" });
    assert.equal(prevented, true);
    assert.equal(workers[0].terminated, true);

    const unreadable = computeMatlabSpectrogramOffThread(input);
    workers[1].onmessageerror();
    await assert.rejects(unreadable, { name: "DataCloneError" });
    assert.equal(workers[1].terminated, true);

    failPost = true;
    await assert.rejects(computeMatlabSpectrogramOffThread(input), /transfer failed/);
    assert.equal(workers[2].terminated, true);
    failPost = false;

    const originalSlice = input.data[0].slice;
    input.data[0].slice = () => { throw new Error("copy allocation failed"); };
    await assert.rejects(computeMatlabSpectrogramOffThread(input), /copy allocation failed/);
    assert.equal(workers[3].terminated, true);
    input.data[0].slice = originalSlice;

    const count = workers.length;
    await assert.rejects(computeMatlabSpectrogramOffThread(request(new Float64Array(70_000), 1000)), /memory budget/);
    assert.equal(workers.length, count, "size guard runs before worker creation or input copying");
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
  }
});
