import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionOverview, MAX_SESSION_OVERVIEW_BARS } from "../app/session-overview.ts";
import { RecordingOverviewCache } from "../app/recording-overview.ts";

function fixture(ranges, { totalDurationSec = ranges[0].length, complete = true, step = 1, labels, units } = {}) {
  const channels = ranges.length;
  return {
    complete, totalDurationSec, byteLength: 0,
    window: {
      startSec: 0, durationSec: ranges[0].length * step, bucketDurationSec: step,
      channelIndices: ranges.map((_, index) => index),
      channelLabels: labels ?? ranges.map((_, index) => `EEG${index + 1}`),
      channelUnits: units ?? Array(channels).fill("µV"),
      sampleRates: Array(channels).fill(1 / step), channelStartSecs: Array(channels).fill(0),
      data: ranges.map((values) => Float32Array.from(values, ([min, max]) => (min + max) / 2)),
      minima: ranges.map((values) => Float32Array.from(values, ([min]) => min)),
      maxima: ranges.map((values) => Float32Array.from(values, ([, max]) => max)),
      gaps: ranges.map((values) => new Uint8Array(values.length)),
    },
  };
}

test("navigator bars reflect actual ranges and keep zero activity distinct from missing data", () => {
  const entry = fixture([[[0, 0], [-2, 3], [-10, 10], [-1, 1]]]);
  const result = buildSessionOverview(entry, { durationSec: 4, barCount: 4 });
  assert.deepEqual(result.bars.map((bar) => bar.peakToPeak), [0, 5, 20, 2]);
  assert.deepEqual(result.bars.map((bar) => bar.heightFraction), [0, 0.25, 1, 0.1]);
  assert.ok(result.bars.every((bar) => bar.state === "ready"));
  assert.equal(result.scaleMax, 20);
  assert.equal(result.status, "ready");
  assert.equal(result.coverageFraction, 1);
  assert.match(result.description, /Raw peak-to-peak.*EEG1.*20 µV maximum/);
  const different = fixture([[[0, 0], [-10, 10], [-1, 1], [-2, 3]]]);
  assert.notDeepEqual(buildSessionOverview(different, { durationSec: 4, barCount: 4 }).bars, result.bars);
});

test("explicit source channels preserve units and are never blended or independently normalized together", () => {
  const entry = fixture([[[0, 1], [0, 2]], [[0, 100], [0, 10]]], { labels: ["Fp1", "ECG"], units: ["µV", "mV"] });
  const result = buildSessionOverview(entry, { durationSec: 2, channelIndex: 1, barCount: 2 });
  assert.equal(result.channelLabel, "ECG");
  assert.equal(result.channelUnit, "mV");
  assert.deepEqual(result.bars.map((bar) => bar.peakToPeak), [100, 10]);
  assert.equal(result.scaleMax, 100);
  assert.equal(buildSessionOverview(entry, { durationSec: 2, channelIndex: 99 }).status, "unavailable");
});

test("reductions own complete buckets and preserve spikes and drifting extrema", () => {
  const entry = fixture([[[0, 1], [2, 3], [-100, 4], [5, 6], [7, 8]]]);
  const result = buildSessionOverview(entry, { durationSec: 5, barCount: 2 });
  assert.deepEqual(result.bars.map(({ startSec, endSec, peakToPeak }) => [startSec, endSec, peakToPeak]), [[0, 2, 3], [2, 5, 108]]);
  assert.equal(buildSessionOverview(entry, { durationSec: 5, barCount: 110 }).bars.length, 5, "never invent higher temporal resolution");
});

test("partial prefix keeps unread and partially scanned bins neutral", () => {
  const entry = fixture([[[0, 2], [0, 4], [0, 6]]], { totalDurationSec: 8, complete: false });
  const result = buildSessionOverview(entry, { durationSec: 8, barCount: 4, loading: true });
  assert.deepEqual(result.bars.map((bar) => bar.state), ["ready", "partial", "unread", "unread"]);
  assert.deepEqual(result.bars.map((bar) => bar.peakToPeak), [4, null, null, null]);
  assert.deepEqual(result.bars.map((bar) => bar.heightFraction), [1, null, null, null]);
  assert.equal(result.coverageEndSec, 3);
  assert.equal(result.coverageFraction, 3 / 8);
  assert.equal(result.complete, false);
  assert.equal(result.status, "partial");
  assert.match(result.description, /37% indexed.*Unread or gapped intervals are blank/);
});

test("gaps and unknown extrema do not render as zero or discard other known intervals", () => {
  const entry = fixture([[[0, 1], [0, 100], [NaN, NaN], [2, 2]]]);
  entry.window.gaps[0][1] = 1;
  const before = entry.window.minima[0].slice();
  const result = buildSessionOverview(entry, { durationSec: 4, barCount: 4 });
  assert.deepEqual(result.bars.map((bar) => bar.state), ["ready", "gap", "gap", "ready"]);
  assert.deepEqual(result.bars.map((bar) => bar.heightFraction), [1, null, null, 0]);
  assert.equal(result.status, "partial");
  assert.equal(result.complete, true, "index completion does not erase signal gaps");
  assert.deepEqual(entry.window.minima[0], before, "published snapshots remain immutable");
});

test("missing or invalid index shows a neutral timeline and never reads source data", () => {
  for (const loading of [false, true]) {
    const result = buildSessionOverview(undefined, { durationSec: 86400, loading });
    assert.equal(result.status, loading ? "loading" : "unavailable");
    assert.ok(result.bars.every((bar) => bar.state === "unread" && bar.heightFraction === null && bar.peakToPeak === null));
    assert.equal(result.channelIndex, null);
    assert.equal(result.coverageFraction, 0);
  }
  const entry = fixture([[[0, 1], [0, 2]]]);
  assert.equal(buildSessionOverview(entry, { durationSec: 5 }).status, "unavailable", "stale duration cannot stretch another recording's index");
  assert.equal(buildSessionOverview(entry, { durationSec: NaN }).bars.length, 0);
  assert.equal(buildSessionOverview({ ...entry, window: { ...entry.window, bucketDurationSec: 0 } }, { durationSec: 2 }).status, "unavailable");
});

test("output and input work stay bounded independently of recording duration", () => {
  const entry = fixture([Array.from({ length: 2048 }, (_, index) => [0, index])], { totalDurationSec: 86400, step: 86400 / 2048 });
  const result = buildSessionOverview(entry, { durationSec: 86400, barCount: 10_000_000 });
  assert.equal(result.bars.length, MAX_SESSION_OVERVIEW_BARS);
  assert.equal(result.bars.at(-1).endSec, 86400);
  const oversized = fixture([Array.from({ length: 2049 }, () => [0, 1])]);
  assert.equal(buildSessionOverview(oversized, { durationSec: 2049 }).status, "unavailable");
});

test("same-name source changes use only their own cached index and refreshed labels", () => {
  const firstEntry = fixture([[[0, 1], [0, 9]]]);
  const secondEntry = fixture([[[0, 9], [0, 1]]]);
  const source = () => ({ meta: {
    id: "same", name: "same.edf", durationSec: 2, channelCount: 1,
    channelLabels: ["Fp1"], channelUnits: ["µV"], sampleRates: [200],
  }, getWindow() { assert.fail("navigator must not read a source"); } });
  const first = source();
  const second = source();
  const cache = new RecordingOverviewCache();
  assert.equal(cache.put(first, firstEntry.window, { complete: true }), true);
  const options = { durationSec: 2, barCount: 2 };
  assert.equal(buildSessionOverview(cache.get(second), options).status, "unavailable");
  assert.equal(cache.put(second, secondEntry.window, { complete: true }), true);
  assert.deepEqual(buildSessionOverview(cache.get(first), options).bars.map((bar) => bar.heightFraction), [1 / 9, 1]);
  assert.deepEqual(buildSessionOverview(cache.get(second), options).bars.map((bar) => bar.heightFraction), [1, 1 / 9]);
  second.meta.channelLabels = ["Renamed Fp1"];
  assert.equal(buildSessionOverview(cache.get(second), options).channelLabel, "Renamed Fp1");
});
