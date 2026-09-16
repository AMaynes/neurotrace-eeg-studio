/** Whole-file indexes stay bounded, source-specific, and independent of detail views. */

import assert from "node:assert/strict";
import test from "node:test";

import {
  RECORDING_OVERVIEW_ENTRY_BYTES,
  RECORDING_OVERVIEW_TARGET_BUCKETS,
  RecordingOverviewCache,
  recordingOverviewCovers,
  recordingOverviewDisplayWindow,
  recordingOverviewPlan,
} from "../app/recording-overview.ts";

function source(channelCount = 2, durationSec = 3600) {
  return {
    meta: {
      id: "same-file-name",
      name: "recording.dat",
      fileName: "recording.dat",
      format: "raw-int16-le",
      durationSec,
      channelCount,
      channelLabels: Array.from({ length: channelCount }, (_, index) => `E${index + 1}`),
      channelUnits: Array(channelCount).fill("ADC count"),
      units: Array(channelCount).fill("ADC count"),
      sampleRates: Array(channelCount).fill(1000),
      sampleRate: 1000,
      warnings: [],
    },
    async getWindow() { throw new Error("Overview reuse must not load raw samples."); },
  };
}

function envelope(recording, durationSec = recording.meta.durationSec, buckets = 10) {
  const { channelCount, channelLabels, channelUnits } = recording.meta;
  return {
    startSec: 0,
    durationSec,
    bucketDurationSec: durationSec / buckets,
    channelIndices: Array.from({ length: channelCount }, (_, index) => index),
    channelLabels: [...channelLabels],
    channelUnits: [...channelUnits],
    channelStartSecs: Array(channelCount).fill(0),
    sampleRates: Array(channelCount).fill(buckets / durationSec),
    data: Array.from({ length: channelCount }, () => Float32Array.from({ length: buckets }, (_, index) => index)),
    minima: Array.from({ length: channelCount }, () => new Float32Array(buckets).fill(-32_768)),
    maxima: Array.from({ length: channelCount }, () => new Float32Array(buckets).fill(32_767)),
    gaps: Array.from({ length: channelCount }, () => new Uint8Array(buckets)),
    variation: Array.from({ length: channelCount }, () => new Float32Array(buckets).fill(1234)),
  };
}

test("whole-file plan includes all 157 channels with memory independent of recording duration", () => {
  const recording = source(157, 86_400);
  const plan = recordingOverviewPlan(recording.meta);
  assert.equal(plan.startSec, 0);
  assert.equal(plan.durationSec, 86_400);
  assert.equal(plan.bucketCount, RECORDING_OVERVIEW_TARGET_BUCKETS);
  assert.deepEqual(plan.channelIndices, Array.from({ length: 157 }, (_, index) => index));
  assert.ok(plan.bucketCount * 157 * 17 <= RECORDING_OVERVIEW_ENTRY_BYTES);
  assert.equal(recordingOverviewPlan({ ...recording.meta, durationSec: 86_400 * 365 }).bucketCount, plan.bucketCount);
});

test("large channel counts lower index resolution instead of exceeding the compact budget", () => {
  const recording = source(1024);
  const plan = recordingOverviewPlan(recording.meta);
  assert.ok(plan.bucketCount < RECORDING_OVERVIEW_TARGET_BUCKETS);
  assert.ok(plan.bucketCount * 1024 * 17 <= RECORDING_OVERVIEW_ENTRY_BYTES);
  assert.ok((plan.bucketCount + 1) * 1024 * 17 > RECORDING_OVERVIEW_ENTRY_BYTES);
  for (const changed of [
    { durationSec: 0 }, { durationSec: NaN }, { durationSec: Infinity },
    { channelCount: 0 }, { channelCount: 1.5 }, { channelLabels: [] },
    { channelUnits: [] }, { sampleRates: [] }, { sampleRates: Array(1024).fill(0) },
  ]) {
    assert.equal(recordingOverviewPlan({ ...recording.meta, ...changed }), null);
  }
});

test("short low-rate recordings never allocate more overview buckets than useful source samples", () => {
  const recording = source(2, 0.31);
  recording.meta.sampleRates = [1, 10];
  recording.meta.sampleRate = 1;
  assert.equal(recordingOverviewPlan(recording.meta).bucketCount, 4);
  assert.equal(recordingOverviewPlan({ ...recording.meta, durationSec: 0.01 }).bucketCount, 1);
  assert.equal(recordingOverviewPlan({ ...recording.meta, durationSec: 1 }).bucketCount, 10);
  assert.equal(recordingOverviewPlan({ ...recording.meta, durationSec: 1000 }).bucketCount, RECORDING_OVERVIEW_TARGET_BUCKETS);
});

test("complete all-channel overview survives detail zooms without reloading samples or losing extrema", () => {
  const recording = source(157);
  const cache = new RecordingOverviewCache();
  const index = envelope(recording);
  index.gaps[156][4] = 1;
  index.data[156][4] = NaN;
  assert.equal(cache.put(recording, index, { complete: true }), true);
  const details = new Map();
  for (let zoom = 0; zoom < 20; zoom += 1) {
    details.clear();
    details.set(`zoom-${zoom}`, new Float32Array(1024));
  }
  const entry = cache.get(recording);
  assert.equal(entry.window, index);
  assert.equal(entry.complete, true);
  assert.equal(entry.window.minima[156][3], -32_768);
  assert.equal(entry.window.maxima[156][3], 32_767);
  assert.equal(entry.window.variation[156][3], 1234);
  assert.equal(entry.window.gaps[156][4], 1);
  assert.ok(Number.isNaN(entry.window.data[156][4]));
  assert.equal(cache.byteLength, 157 * 10 * 17);
});

test("same file name and metadata never allow reuse for a different source instance", () => {
  const first = source();
  const second = source();
  const cache = new RecordingOverviewCache();
  assert.deepEqual(first.meta, second.meta);
  assert.equal(cache.put(first, envelope(first), { complete: true }), true);
  assert.equal(cache.get(second), undefined);
  assert.ok(cache.get(first));
});

test("prefix publication grows monotonically and cannot overwrite a completed index", () => {
  const recording = source();
  const cache = new RecordingOverviewCache();
  const prefix = envelope(recording, 600);
  assert.equal(cache.put(recording, prefix, { complete: false }), true);
  assert.equal(cache.get(recording).complete, false);
  assert.equal(cache.put(recording, envelope(recording, 300), { complete: false }), false);
  assert.equal(cache.put(recording, envelope(recording, 600), { complete: true }), false);
  assert.equal(cache.get(recording).window, prefix);
  const complete = envelope(recording);
  assert.equal(cache.put(recording, complete, { complete: true }), true);
  assert.equal(cache.put(recording, envelope(recording), { complete: false }), false);
  assert.equal(cache.get(recording).window, complete);
  assert.equal(cache.byteLength, 2 * 10 * 17);
});

test("roundoff in a final prefix cannot prevent publishing the completed recording", () => {
  const recording = source(1, 1.1);
  const cache = new RecordingOverviewCache();
  const final = envelope(recording, 1.1, 519);
  const prefix = { ...final, durationSec: 519 * final.bucketDurationSec };
  assert.ok(prefix.durationSec > final.durationSec);
  assert.equal(cache.put(recording, prefix, { complete: false }), true);
  assert.equal(cache.put(recording, final, { complete: true }), true);
  assert.equal(cache.get(recording).complete, true);
});

test("coverage excludes unread tails, invalid intervals, and requests needing finer resolution", () => {
  const recording = source();
  const cache = new RecordingOverviewCache();
  cache.put(recording, envelope(recording, 600, 100), { complete: false });
  const prefix = cache.get(recording);
  assert.equal(recordingOverviewCovers(prefix, 0, 600), true);
  assert.equal(recordingOverviewCovers(prefix, 300, 599, 6), true);
  assert.equal(recordingOverviewCovers(prefix, 0, 601), false);
  assert.equal(recordingOverviewCovers(prefix, 600, 3600), false);
  assert.equal(recordingOverviewCovers(prefix, 0, 600, 5), false);
  for (const [start, end, step] of [[-1, 100], [0, Infinity], [0, NaN], [5, 5], [6, 5], [0, 600, 0]]) {
    assert.equal(recordingOverviewCovers(prefix, start, end, step), false);
  }
});

test("invalid shapes or channel interpretation leave the previous overview untouched", () => {
  const recording = source();
  const cache = new RecordingOverviewCache();
  const original = envelope(recording);
  cache.put(recording, original, { complete: true });
  for (const changed of [
    { startSec: 1 }, { durationSec: 3601 }, { bucketDurationSec: 1 },
    { channelIndices: [1, 0] }, { channelLabels: [undefined, "E2"] },
    { channelUnits: ["µV", "ADC count"] }, { sampleRates: [1000, 1000] },
    { channelStartSecs: [0, 1] }, { data: [new Float32Array(10)] },
    { minima: [new Float32Array(11), new Float32Array(10)] },
    { maxima: [new Float64Array(10), new Float32Array(10)] },
    { gaps: [new Float32Array(10), new Uint8Array(10)] },
    { variation: [new Float32Array(10)] },
  ]) {
    assert.equal(cache.put(recording, { ...envelope(recording), ...changed }, { complete: true }), false);
    assert.equal(cache.get(recording).window, original);
  }
});

test("worker header labels use current BIDS names without changing channel identity or signal arrays", () => {
  const recording = source();
  const cache = new RecordingOverviewCache();
  const original = envelope(recording);
  recording.meta.channelLabels = ["Left1", "Right1"];
  assert.equal(cache.put(recording, original, { complete: true }), true);
  const indexed = cache.get(recording).window;
  assert.deepEqual(indexed.channelLabels, ["Left1", "Right1"]);
  assert.deepEqual(original.channelLabels, ["E1", "E2"], "worker metadata must not be mutated");
  assert.deepEqual(indexed.channelIndices, original.channelIndices);
  assert.equal(indexed.channelUnits, original.channelUnits);
  for (const field of ["data", "minima", "maxima", "gaps", "variation"]) {
    assert.equal(indexed[field], original[field], `${field} must retain the exact calibrated source values`);
  }
  assert.equal(cache.put(recording, { ...original, channelIndices: [1, 0] }, { complete: true }), false);
  assert.equal(cache.put(recording, { ...original, channelUnits: ["µV", "µV"] }, { complete: true }), false);
});

test("later channel renaming refreshes cached labels and selected display order without mutating snapshots", () => {
  const recording = source();
  const cache = new RecordingOverviewCache();
  const original = envelope(recording);
  cache.put(recording, original, { complete: true });
  const previousEntry = cache.get(recording);
  const previousBytes = cache.byteLength;
  recording.meta.channelLabels = ["UpdatedA", "UpdatedB"];
  const entry = cache.get(recording);
  assert.deepEqual(entry.window.channelLabels, ["UpdatedA", "UpdatedB"]);
  assert.deepEqual(previousEntry.window.channelLabels, ["E1", "E2"]);
  assert.deepEqual(original.channelLabels, ["E1", "E2"]);
  assert.equal(entry.window.data, original.data);
  assert.equal(entry.window.minima, original.minima);
  assert.equal(entry.window.maxima, original.maxima);
  assert.equal(entry.window.channelUnits, original.channelUnits);
  assert.equal(cache.byteLength, previousBytes);
  const display = recordingOverviewDisplayWindow(entry, 0, 3600, [1, 0]);
  assert.deepEqual(display.channelLabels, ["UpdatedB", "UpdatedA"]);
  assert.deepEqual(display.minima[0], original.minima[1]);
});

test("bounded cache evicts older recordings while protecting the last-used overview", () => {
  const first = source(1);
  const second = source(1);
  const third = source(1);
  const cache = new RecordingOverviewCache(340);
  assert.equal(cache.put(first, envelope(first), { complete: true }), true);
  assert.equal(cache.put(second, envelope(second), { complete: true }), true);
  cache.get(first);
  assert.equal(cache.put(third, envelope(third), { complete: true }), true);
  assert.equal(cache.get(second), undefined);
  assert.ok(cache.get(first));
  assert.ok(cache.get(third));
  assert.equal(cache.byteLength, 340);
  assert.equal(cache.size, 2);
  assert.equal(cache.put(first, envelope(first, 3600, 21), { complete: true }), false);
  assert.ok(cache.get(first), "a rejected oversized replacement must preserve the old entry");
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.byteLength, 0);
  assert.equal(cache.get(first), undefined);
  assert.throws(() => new RecordingOverviewCache(0), /positive byte budget/);
});

test("memory accounting includes retained backing buffers and does not double-count shared storage", () => {
  const recording = source(1);
  const cache = new RecordingOverviewCache();
  const shared = new ArrayBuffer(170);
  const index = envelope(recording);
  index.data = [new Float32Array(shared, 0, 10)];
  index.minima = [new Float32Array(shared, 40, 10)];
  index.maxima = [new Float32Array(shared, 80, 10)];
  index.variation = [new Float32Array(shared, 120, 10)];
  index.gaps = [new Uint8Array(shared, 160, 10)];
  assert.equal(cache.put(recording, index, { complete: true }), true);
  assert.equal(cache.byteLength, 170);
  const oversized = envelope(recording);
  oversized.data = [new Float32Array(RECORDING_OVERVIEW_ENTRY_BYTES / 4 + 1).subarray(0, 10)];
  assert.equal(cache.put(recording, oversized, { complete: true }), false);
  assert.equal(cache.get(recording).window, index);
});

test("partial overview displays exact scanned bins and explicitly unknown future bins", () => {
  const recording = source(2, 100);
  const cache = new RecordingOverviewCache();
  const prefix = envelope(recording, 40, 4);
  prefix.data[1][2] = 700;
  prefix.minima[1][2] = -900;
  prefix.maxima[1][2] = 1200;
  prefix.variation[1][2] = 8000;
  prefix.gaps[0][3] = 1;
  cache.put(recording, prefix, { complete: false });
  const display = recordingOverviewDisplayWindow(cache.get(recording), 25, 30, [1, 0]);
  assert.equal(display.startSec, 10);
  assert.equal(display.durationSec, 60);
  assert.equal(display.bucketDurationSec, 10);
  assert.deepEqual(display.channelIndices, [1, 0]);
  assert.deepEqual(display.channelLabels, ["E2", "E1"]);
  assert.deepEqual(display.channelStartSecs, [10, 10]);
  assert.deepEqual([...display.data[0]], [1, 700, 3, NaN, NaN, NaN]);
  assert.deepEqual([...display.gaps[0]], [0, 0, 0, 1, 1, 1]);
  assert.deepEqual([...display.gaps[1]], [0, 0, 1, 1, 1, 1]);
  assert.deepEqual([...display.variation[0]], [1234, 8000, 1234, 0, 0, 0]);
  assert.equal(display.minima[0][1], -900);
  assert.equal(display.maxima[0][1], 1200);
  assert.ok(Number.isNaN(display.minima[0][3]));
  assert.ok(Number.isNaN(display.maxima[0][3]));
  display.data[0][1] = 0;
  display.minima[0][1] = 0;
  display.maxima[0][1] = 0;
  display.gaps[0][1] = 1;
  display.variation[0][1] = 0;
  assert.equal(prefix.data[1][2], 700);
  assert.equal(prefix.minima[1][2], -900);
  assert.equal(prefix.maxima[1][2], 1200);
  assert.equal(prefix.gaps[1][2], 0);
  assert.equal(prefix.variation[1][2], 8000);
});

test("display ahead of scanning remains all gaps, including at recording EOF", () => {
  const recording = source(1, 100);
  const cache = new RecordingOverviewCache();
  cache.put(recording, envelope(recording, 20, 2), { complete: false });
  const entry = cache.get(recording);
  const display = recordingOverviewDisplayWindow(entry, 80, 50, [0]);
  assert.equal(display.startSec, 70);
  assert.equal(display.durationSec, 30);
  assert.ok([...display.data[0]].every(Number.isNaN));
  assert.ok([...display.minima[0]].every(Number.isNaN));
  assert.ok([...display.maxima[0]].every(Number.isNaN));
  assert.deepEqual([...display.gaps[0]], [1, 1, 1]);
  assert.deepEqual([...display.variation[0]], [0, 0, 0]);
  const finalPixel = recordingOverviewDisplayWindow(entry, 99.999, 0.001, [0]);
  assert.equal(finalPixel.startSec, 80);
  assert.equal(finalPixel.startSec + finalPixel.durationSec, 100);
  assert.throws(() => recordingOverviewDisplayWindow(entry, 100, 1, [0]), /valid recording interval/);
  assert.throws(() => recordingOverviewDisplayWindow(entry, 0, 1, [1]), /unique indexed channels/);
  assert.throws(() => recordingOverviewDisplayWindow(entry, 0, 1, [0, 0]), /unique indexed channels/);
});

test("completed overview crops preserve the fixed bucket grid and allow empty channel selection", () => {
  const recording = source(1, 1.1);
  const cache = new RecordingOverviewCache();
  const complete = envelope(recording, 1.1, 11);
  cache.put(recording, complete, { complete: true });
  const entry = cache.get(recording);
  const display = recordingOverviewDisplayWindow(entry, 0.31, 0.2, [0]);
  assert.ok(Math.abs(display.startSec - 0.2) < 1e-12);
  assert.ok(Math.abs(display.durationSec - 0.5) < 1e-12);
  assert.deepEqual([...display.data[0]], [2, 3, 4, 5, 6]);
  assert.deepEqual([...display.gaps[0]], [0, 0, 0, 0, 0]);
  const noChannels = recordingOverviewDisplayWindow(entry, 0, 1.1, []);
  assert.deepEqual(noChannels.data, []);
  assert.equal(noChannels.durationSec, 1.1);
});
