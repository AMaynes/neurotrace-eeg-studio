/** Standalone Level-5 overview navigation uses exact samples without copying wide windows. */
import assert from "node:assert/strict";
import test from "node:test";
import { MatSource, RawDatSource } from "../app/eeg-core.ts";
import { mergeAdjacentEnvelopeWindows } from "../app/envelope-cache.ts";
import { matWriter } from "./fixtures/legacy-mat.mjs";

async function matSource(channels, sampleRate = 4, options = {}) {
  const writer = matWriter();
  const sampleCount = channels[0].length;
  const values = new Float64Array(sampleCount * channels.length);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    channels.forEach((channel, index) => { values[sample * channels.length + index] = channel[sample]; });
  }
  return MatSource.create(writer.file([
    writer.numeric([sampleRate], { name: "Fs" }),
    writer.numeric(values, { name: "data", dimensions: [channels.length, sampleCount] }),
  ], "synthetic-overview.mat"), options);
}

test("standalone MAT overview matches existing exact DAT envelope and time boundaries", async () => {
  const channels = [
    [1, 3, -5, 7, 9, 11, 13, 15],
    [100, 90, 80, 70, 60, 50, 40, 30],
    [-10, -20, -30, -40, -50, -60, -70, -80],
  ];
  const channelLabels = ["A", "B", "C"];
  const channelUnits = ["count", "count", "count"];
  const mat = await matSource(channels, 4, { channelLabels, channelUnits });
  const bytes = Buffer.alloc(channels.length * channels[0].length * 2);
  channels[0].forEach((_, sample) => channels.forEach((channel, index) => {
    bytes.writeInt16LE(channel[sample], (sample * channels.length + index) * 2);
  }));
  const dat = await RawDatSource.create(new File([bytes], "synthetic-overview.dat"), {
    sampleRate: 4, channelCount: 3, channelLabels, channelUnits,
  });
  for (const [start, duration, buckets, selected] of [
    [0, 2, 2, [2, 0]],
    [0.125, 1.4, 7, [1, 2, 0]],
    [1.75, 1, 5, [0]],
    [-0.5, 1, 4, undefined],
  ]) {
    assert.deepEqual(await mat.getEnvelopeWindow(start, duration, buckets, selected),
      await dat.getEnvelopeWindow(start, duration, buckets, selected));
  }
  assert.deepEqual((await mat.getWindow(0, 2)).data.map((values) => [...values]), channels,
    "overview generation must never mutate source samples");
});

test("standalone MAT overview preserves finite extrema and explicitly marks nonfinite gaps", async () => {
  const source = await matSource([[1, NaN, 3, 4, Infinity, -Infinity, 7, 9]]);
  const window = await source.getEnvelopeWindow(0, 2, 4);
  assert.deepEqual([...window.minima[0]], [1, 3, NaN, 7]);
  assert.deepEqual([...window.maxima[0]], [1, 4, NaN, 9]);
  assert.deepEqual([...window.data[0]], [NaN, 3.5, NaN, 8]);
  assert.deepEqual([...window.gaps[0]], [1, 0, 1, 0]);
  assert.deepEqual([...window.variation[0]], [0, 1, 0, 2]);
});

test("standalone MAT overview keeps oversampled empty buckets neutral", async () => {
  const source = await matSource([[10, 20]], 1);
  const window = await source.getEnvelopeWindow(0, 2, 4);
  assert.deepEqual([...window.data[0]], [10, NaN, 20, NaN]);
  assert.deepEqual([...window.minima[0]], [10, NaN, 20, NaN]);
  assert.deepEqual([...window.maxima[0]], [10, NaN, 20, NaN]);
  assert.deepEqual([...window.gaps[0]], [0, 0, 0, 0]);
  assert.deepEqual(window.channelStartSecs, [0]);
  assert.deepEqual(window.sampleRates, [2]);
  assert.equal(window.bucketDurationSec, 0.5);
});

test("aligned standalone MAT overview pieces exactly match one read across decimal frame boundaries", async () => {
  const values = Float32Array.from({ length: 4000 }, (_, frame) => (frame % 251) - 125);
  for (const sampleRate of [1000, 512, 441]) {
    const source = await matSource([values], sampleRate);
    for (const startFrame of [0, 1000, 2900]) {
      const whole = await source.getEnvelopeWindow(startFrame / sampleRate, 1000 / sampleRate, 50);
      for (const splitFrames of [20, 180, 620]) {
        const first = await source.getEnvelopeWindow(startFrame / sampleRate, splitFrames / sampleRate, splitFrames / 20);
        const second = await source.getEnvelopeWindow((startFrame + splitFrames) / sampleRate,
          (1000 - splitFrames) / sampleRate, (1000 - splitFrames) / 20);
        const combined = mergeAdjacentEnvelopeWindows([second, first]);
        for (const field of ["data", "minima", "maxima", "gaps", "variation"]) {
          assert.deepEqual(combined[field], whole[field],
            `${field} changed at source rate ${sampleRate}, start frame ${startFrame}, split ${splitFrames}`);
        }
        assert.equal(combined.bucketDurationSec, whole.bucketDurationSec);
        assert.deepEqual(combined.sampleRates, whole.sampleRates);
        assert.deepEqual(combined.channelStartSecs, whole.channelStartSecs);
      }
    }
  }
});

test("aligned MAT metadata remains identical for short buckets at a late recording time", async () => {
  const sampleRate = 1000;
  const startFrame = 1_000_000;
  const source = await matSource([new Float32Array(startFrame + 1000)], sampleRate);
  const whole = await source.getEnvelopeWindow(startFrame / sampleRate, 1, 50);
  const first = await source.getEnvelopeWindow(startFrame / sampleRate, 0.02, 1);
  const second = await source.getEnvelopeWindow((startFrame + 20) / sampleRate, 0.98, 49);
  const combined = mergeAdjacentEnvelopeWindows([first, second]);
  assert.equal(first.bucketDurationSec, 0.02);
  assert.deepEqual(first.sampleRates, [50]);
  assert.deepEqual(combined, whole);
});

test("standalone MAT overview handles zero duration, EOF and no selected channels", async () => {
  const source = await matSource([[10, 20, 30, 40]], 4);
  for (const [start, duration] of [[0.125, 0], [1, 1], [2, 0.5]]) {
    const window = await source.getEnvelopeWindow(start, duration, 3);
    assert.equal(window.durationSec, 0);
    assert.equal(window.bucketDurationSec, 0);
    assert.deepEqual([...window.data[0]], [NaN, NaN, NaN]);
    assert.deepEqual([...window.minima[0]], [NaN, NaN, NaN]);
    assert.deepEqual([...window.maxima[0]], [NaN, NaN, NaN]);
    assert.deepEqual([...window.gaps[0]], [0, 0, 0]);
  }
  const empty = await source.getEnvelopeWindow(0, 1, 3, []);
  assert.deepEqual(empty.channelIndices, []);
  assert.deepEqual(empty.data, []);
  assert.deepEqual(empty.minima, []);
});

test("standalone MAT overview rejects invalid windows, buckets and channel selections", async () => {
  const source = await matSource([[10, 20, 30, 40]], 4);
  for (const buckets of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(source.getEnvelopeWindow(0, 1, buckets), { code: "INVALID_WINDOW" });
  }
  for (const [start, duration, selected] of [[NaN, 1], [0, -1], [0, Infinity], [0, 1, [1]], [0, 1, [0, 0]]]) {
    await assert.rejects(source.getEnvelopeWindow(start, duration, 3, selected), { code: "INVALID_WINDOW" });
  }
});

test("wide standalone MAT overview is bounded to requested buckets and yields after its work budget", async (t) => {
  const samples = Float32Array.from({ length: 150_001 }, (_, index) => (index % 103) - 51);
  samples[65_535] = -32_000;
  samples[65_536] = 31_000;
  const source = await matSource([samples], 1000);
  source.getWindow = () => { throw new Error("must not materialize a full raw window"); };
  // Simulate costly batches instead of relying on the test machine's speed.
  let workTime = 0;
  t.mock.method(performance, "now", () => { workTime += 8; return workTime; });
  let navigationRan = false;
  const navigation = new Promise((resolve) => setTimeout(() => { navigationRan = true; resolve(); }, 0));
  const window = await source.getEnvelopeWindow(0, source.meta.durationSec, 17);
  assert.equal(navigationRan, true, "large overview scans must yield before completing");
  await navigation;
  for (const arrays of [window.data, window.minima, window.maxima, window.gaps, window.variation]) {
    assert.equal(arrays[0].length, 17, "no full-window sample array in the returned envelope");
  }
  assert.equal(Math.min(...window.minima[0]), -32_000);
  assert.equal(Math.max(...window.maxima[0]), 31_000);
});

test("fast standalone MAT overview batches do not each schedule a browser timer", async (t) => {
  const source = await matSource([new Float32Array(150_001)], 1000);
  t.mock.method(performance, "now", () => 0);
  const timer = t.mock.method(globalThis, "setTimeout", () => {
    throw new Error("batches within the work budget should not yield");
  });
  await source.getEnvelopeWindow(0, source.meta.durationSec, 10);
  assert.equal(timer.mock.callCount(), 0);
});

test("standalone MAT overview cancels already-aborted and superseded scans, then retries cleanly", async (t) => {
  const samples = Float32Array.from({ length: 150_001 }, (_, index) => index % 101);
  const source = await matSource([samples], 1000);
  let workTime = 0;
  t.mock.method(performance, "now", () => { workTime += 8; return workTime; });
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(source.getEnvelopeWindow(0, 1, 10, undefined, { signal: cancelled.signal }), { name: "AbortError" });

  const controller = new AbortController();
  const reason = new Error("Synthetic newer navigation request");
  const scan = source.getEnvelopeWindow(0, source.meta.durationSec, 10, undefined, { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(scan, (error) => error === reason);
  const retry = await source.getEnvelopeWindow(0, 1, 10);
  assert.equal(retry.data[0].length, 10);
  assert.equal(Math.min(...retry.minima[0]), 0);
  assert.equal(Math.max(...retry.maxima[0]), 100);
});
