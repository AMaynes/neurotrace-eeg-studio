import assert from "node:assert/strict";
import test from "node:test";
import { matlabSpectrogramInputPlan } from "../app/matlab-spectrogram-input.ts";

function metadata(rate = 200, durationSec = 20000) {
  return { channelLabels: ["LA1", "RA1", "LA3", "LA2", "ECG1", "eeg Fp1"],
    sampleRates: Array(6).fill(rate), durationSec };
}

// Literal reference operations: ts_EEG=(1:N)/fs+start and first minimum
// abs(ts_EEG-click), followed by inclusive +/-round(15*fs) indexing.
function referencePlan(meta, primary, start, duration, click) {
  const rate = meta.sampleRates[primary];
  const firstSourceSample = Math.floor(start * rate);
  const count = Math.min(Math.floor(duration * rate), Math.floor(meta.durationSec * rate) - firstSourceSample);
  if (count < 1) return null;
  const times = Array.from({ length: count }, (_, index) => (index + 1) / rate + start);
  let clicked = 0;
  for (let index = 1; index < count; index++) {
    if (Math.abs(times[index] - click) < Math.abs(times[clicked] - click)) clicked = index;
  }
  const first = Math.max(0, clicked - Math.round(15 * rate));
  const last = Math.min(count - 1, clicked + Math.round(15 * rate));
  return { firstSourceSample: firstSourceSample + first, sampleCount: last - first + 1,
    dataStart: times[first], baselineTime: times[clicked] };
}

function compareReference(meta, primary, start, duration, click) {
  const expected = referencePlan(meta, primary, start, duration, click);
  const actual = matlabSpectrogramInputPlan(meta, primary, start, duration, click);
  if (!expected) { assert.equal(actual, null); return; }
  for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, key);
  assert.equal(actual.readStart, expected.firstSourceSample / actual.sampleRate);
  assert.equal(actual.readDuration, expected.sampleCount / actual.sampleRate);
  return actual;
}

test("spectrogram selects the complete raw source group, including hidden contacts, in source order", () => {
  const meta = metadata();
  const plan = matlabSpectrogramInputPlan(meta, 2, 0, 60, 30);
  assert.deepEqual(plan.sourceIndices, [0, 2, 3]);
  assert.equal(plan.label, "LA raw group (3)");
  assert.equal(plan.sampleCount, 6001, "inclusive +/-15 seconds contains 30*fs+1 samples");
  assert.deepEqual(matlabSpectrogramInputPlan(meta, 4, 0, 60, 30).sourceIndices, [4]);
  assert.deepEqual(matlabSpectrogramInputPlan(meta, 5, 0, 60, 30).sourceIndices, [5]);
  // The helper intentionally accepts no displayed-channel selection or montage
  // values: hiding LA1 or displaying LA3-LA2 cannot change raw group power.
});

test("raw source grouping does not include already-derived bipolar channel labels", () => {
  const meta = { channelLabels: ["LA1", "LA1-2", "LA2", "LA3-LA4", " LA3 ", "la4", "eeg LA5", "ECG1"],
    sampleRates: Array(8).fill(200), durationSec: 60 };
  assert.deepEqual(matlabSpectrogramInputPlan(meta, 0, 0, 40, 20).sourceIndices, [0, 2, 4]);
  assert.deepEqual(matlabSpectrogramInputPlan(meta, 1, 0, 40, 20).sourceIndices, [1],
    "an imported bipolar signal is analyzed alone, never averaged with its raw-contact group");
  assert.equal(matlabSpectrogramInputPlan(meta, 1, 0, 40, 20).label, "LA1-2");
  assert.deepEqual(matlabSpectrogramInputPlan(meta, 5, 0, 40, 20).sourceIndices, [5],
    "MATLAB source-group matching is case-sensitive");
  assert.deepEqual(matlabSpectrogramInputPlan(meta, 6, 0, 40, 20).sourceIndices, [6]);
  assert.deepEqual(matlabSpectrogramInputPlan(meta, 7, 0, 40, 20).sourceIndices, [7]);
});

test("inclusive click crop is bounded by the loaded window, not only the file", () => {
  const meta = metadata();
  compareReference(meta, 0, 100, 80, 140);
  const left = compareReference(meta, 0, 100, 40, 100.005);
  assert.equal(left.sampleCount, 3001);
  assert.equal(left.firstSourceSample, 20000);
  const right = compareReference(meta, 0, 100, 40, 140);
  assert.equal(right.sampleCount, 3001);
  assert.equal(right.firstSourceSample + right.sampleCount, 28000);
  const short = compareReference(meta, 0, 100, 4.007, 102);
  assert.equal(short.sampleCount, Math.floor(4.007 * 200));
});

test("fractional requested origins preserve MATLAB's requested-start plus 1/fs time grid", () => {
  for (const rate of [4, 200, 1000]) for (const start of [1.006, 14400.003]) {
    const meta = metadata(rate);
    for (const click of [start, start + 0.01, start + 17.134, start + 39.9]) {
      compareReference(meta, 0, start, 40.007, click);
    }
  }
  const plan = matlabSpectrogramInputPlan(metadata(200), 0, 1.006, 5, 2);
  assert.equal(plan.firstSourceSample, 201);
  assert.equal(plan.readStart, 1.005);
  assert.equal(plan.dataStart, 1.011, "plot origin is not rounded to the source seek grid");
});

test("exact ties select the first minimum even at fractional origins", () => {
  const meta = metadata(4);
  for (const start of [0, 1.006, 14400.003]) {
    for (let index = 0; index < 12; index++) {
      const before = start + (index + 1) / 4;
      const after = start + (index + 2) / 4;
      compareReference(meta, 0, start, 40, (before + after) / 2);
    }
  }
});

test("EOF clamps source samples but keeps inclusive final sample and rejects empty ranges", () => {
  const meta = metadata(200, 100.005);
  const end = compareReference(meta, 0, 99, 10, 120);
  assert.equal(end.sampleCount, 201);
  assert.equal(end.firstSourceSample, 19800);
  assert.equal(end.baselineTime, 100.005);
  assert.equal(matlabSpectrogramInputPlan(meta, 0, 101, 10, 110), null);
  assert.equal(matlabSpectrogramInputPlan(meta, 0, 0, 0.001, 0), null);
  assert.equal(matlabSpectrogramInputPlan(meta, 99, 0, 10, 3), null);
});

test("EOF metadata round-trip noise does not remove the final source sample", () => {
  const meta = metadata(1000, 1001 / 1000);
  assert.ok(meta.durationSec * 1000 < 1001, "fixture exposes binary floating-point round-trip loss");
  const end = matlabSpectrogramInputPlan(meta, 0, 0, 2, 2);
  assert.equal(end.sampleCount, 1001);
  assert.equal(end.baselineTime, 1.001);
  assert.equal(end.firstSourceSample + end.sampleCount, 1001);
  const requested = matlabSpectrogramInputPlan(meta, 0, 0, 1.001, 2);
  assert.equal(requested.sampleCount, 1000, "requested duration still follows MATLAB's literal floor");
  const seek = matlabSpectrogramInputPlan(metadata(1000, 3), 0, 1.001, 1, 1.5);
  assert.equal(seek.firstSourceSample, 1000, "requested start also retains the literal floor");
  const fractional = matlabSpectrogramInputPlan(metadata(1000, 1.00125), 0, 0, 2, 2);
  assert.equal(fractional.sampleCount, 1001, "a genuinely partial sample is not rounded up");
});

test("mixed rates inside the raw group fail clearly instead of resampling or dropping channels", () => {
  const meta = metadata();
  meta.sampleRates[2] = 1000;
  assert.throws(() => matlabSpectrogramInputPlan(meta, 0, 0, 40, 20), /equal source sample rates/);
  assert.deepEqual(matlabSpectrogramInputPlan(meta, 1, 0, 40, 20).sourceIndices, [1], "another group's rate does not matter");
});

test("invalid metadata or window inputs cannot produce negative or NaN source reads", () => {
  const meta = metadata();
  for (const rate of [NaN, Infinity, -1, 0]) {
    assert.equal(matlabSpectrogramInputPlan(metadata(rate), 0, 0, 40, 20), null);
  }
  for (const duration of [NaN, Infinity, -1, 0]) {
    assert.equal(matlabSpectrogramInputPlan(metadata(200, duration), 0, 0, 40, 20), null);
    assert.equal(matlabSpectrogramInputPlan(meta, 0, 0, duration, 20), null);
  }
  for (const start of [NaN, Infinity, -Infinity, -1]) {
    assert.equal(matlabSpectrogramInputPlan(meta, 0, start, 40, 20), null);
  }
  for (const click of [NaN, Infinity, -Infinity]) {
    assert.equal(matlabSpectrogramInputPlan(meta, 0, 0, 40, click), null);
  }
  for (const channel of [NaN, Infinity, -1, 1.5, 99]) {
    assert.equal(matlabSpectrogramInputPlan(meta, channel, 0, 40, 20), null);
  }
});
