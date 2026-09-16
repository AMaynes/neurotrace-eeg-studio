/** Standalone Level-5 overview navigation uses exact samples without copying wide windows. */
import assert from "node:assert/strict";
import test from "node:test";
import { MatSource, RawDatSource } from "../app/eeg-core.ts";
import { mergeAdjacentEnvelopeWindows } from "../app/envelope-cache.ts";
import { buildRawDatEnvelopeWindow } from "../app/raw-dat-envelope.ts";
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

test("progressive MAT previews contain exact completed prefixes for every selected channel on aligned and fractional grids", async (t) => {
  const channels = Array.from({ length: 3 }, (_, channel) => Float32Array.from(
    { length: 150_001 }, (_, frame) => (frame % (101 + channel)) - 50 + channel * 1_000,
  ));
  channels[0][700] = Number.NaN;
  channels[2][32_767] = 31_000;
  channels[2][32_768] = -32_000;
  const source = await matSource(channels, 1000, {
    channelLabels: ["A", "B", "C"], channelUnits: ["count", "µV", "a.u."],
  });
  t.mock.method(performance, "now", () => 0);
  for (const [start, duration, buckets] of [[.137, 120, 600], [.1375, 120.001, 137]]) {
    const snapshots = [];
    const originalSnapshots = [];
    const expected = await source.getEnvelopeWindow(start, duration, buckets, [2, 0]);
    const result = await source.getEnvelopeWindow(start, duration, buckets, [2, 0], {
      overviewIntervalMs: 100,
      onOverview(snapshot) {
        snapshots.push(snapshot);
        originalSnapshots.push(structuredClone(snapshot));
      },
    });
    assert.deepEqual(result, expected, "publication cannot change final source extrema, means, variation, gaps, or timing");
    assert.ok(snapshots.length >= 2, "a useful prefix arrives before the completed window even under a time throttle");
    assert.ok(snapshots[0].data[0].length < buckets);
    assert.equal(snapshots.at(-1).data[0].length, buckets);
    assert.deepEqual(snapshots, originalSnapshots, "later accumulation must never mutate an already published snapshot");
    for (const snapshot of snapshots) {
      const completed = snapshot.data[0].length;
      assert.deepEqual(snapshot.channelIndices, [2, 0]);
      assert.deepEqual(snapshot.channelLabels, ["C", "A"]);
      assert.deepEqual(snapshot.channelUnits, ["a.u.", "count"]);
      assert.equal(snapshot.startSec, result.startSec);
      assert.equal(snapshot.bucketDurationSec, result.bucketDurationSec);
      assert.equal(snapshot.durationSec, completed * result.bucketDurationSec);
      assert.deepEqual(snapshot.sampleRates, result.sampleRates);
      assert.deepEqual(snapshot.channelStartSecs, result.channelStartSecs);
      for (const field of ["data", "minima", "maxima", "gaps", "variation"]) {
        for (let channel = 0; channel < 2; channel += 1) {
          assert.equal(snapshot[field][channel].length, completed, "all channels end at the same completed bucket");
          assert.deepEqual(snapshot[field][channel], result[field][channel].slice(0, completed));
          assert.notEqual(snapshot[field][channel].buffer, result[field][channel].buffer);
        }
      }
    }
  }
});

test("progressive MAT snapshots normalize empty and missing buckets without mutating live accumulation", async () => {
  const source = await matSource([[1, Number.NaN, 3, 4], [11, 12, 13, 14]], 4);
  const snapshots = [];
  const result = await source.getEnvelopeWindow(0, 1, 8, undefined, {
    overviewIntervalMs: 1,
    onOverview(snapshot) { snapshots.push(structuredClone(snapshot)); snapshot.data[0].fill(999); },
  });
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0], result);
  assert.deepEqual([...result.data[0]], [1, NaN, NaN, NaN, 3, NaN, 4, NaN]);
  assert.deepEqual([...result.gaps[0]], [0, 0, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual([...result.minima[0]], [1, NaN, NaN, NaN, 3, NaN, 4, NaN]);
});

test("time-chunked multichannel MAT accumulation remains byte-identical to the production DAT worker builder", async () => {
  const channels = Array.from({ length: 3 }, (_, channel) => Float32Array.from(
    { length: 70_001 }, (_, frame) => (frame % (131 + channel)) - 65,
  ));
  channels[2][21_844] = -32_000;
  channels[2][21_845] = 31_000;
  const channelLabels = ["A", "B", "C"];
  const channelUnits = ["count", "count", "count"];
  const source = await matSource(channels, 1000, { channelLabels, channelUnits });
  const bytes = Buffer.alloc(channels.length * channels[0].length * 2);
  channels[0].forEach((_, frame) => channels.forEach((channel, index) => {
    bytes.writeInt16LE(channel[frame], (frame * channels.length + index) * 2);
  }));
  const dat = await RawDatSource.create(new File([bytes], "synthetic-chunked.dat"), {
    sampleRate: 1000, channelCount: 3, channelLabels, channelUnits,
  });
  // Compare the same inclusive first source frame; fractional bucket widths
  // still exercise the non-integer grid independently of the MAT accumulator.
  for (const [start, duration, buckets] of [[.125, 65, 650], [.125, 65.001, 37]]) {
    const expected = await buildRawDatEnvelopeWindow({
      ...dat.envelopeWorkerSource,
      startSec: start, durationSec: duration, bucketCount: buckets, channelIndices: [2, 0, 1],
    });
    assert.deepEqual(
      await source.getEnvelopeWindow(start, duration, buckets, [2, 0, 1], { overviewIntervalMs: 1, onOverview() {} }),
      expected.window,
    );
  }
});

test("progressive MAT cancellation stops after a completed multichannel prefix and permits an exact retry", async (t) => {
  const channels = [new Float32Array(100_000).fill(7), new Float32Array(100_000).fill(19)];
  const source = await matSource(channels, 1000);
  t.mock.method(performance, "now", () => 0);
  const controller = new AbortController();
  const reason = new Error("Synthetic superseding zoom");
  const snapshots = [];
  await assert.rejects(source.getEnvelopeWindow(0, 100, 100, [1, 0], {
    signal: controller.signal,
    overviewIntervalMs: 1,
    onOverview(snapshot) { snapshots.push(snapshot); controller.abort(reason); },
  }), (error) => error === reason);
  assert.equal(snapshots.length, 1, "the canceled scan cannot publish more previews");
  assert.equal(snapshots[0].durationSec, 32);
  assert.deepEqual(snapshots[0].channelIndices, [1, 0]);
  assert.deepEqual([...snapshots[0].data[0]], new Array(32).fill(19));
  assert.deepEqual([...snapshots[0].data[1]], new Array(32).fill(7));
  const retry = await source.getEnvelopeWindow(0, 100, 100, [1, 0]);
  assert.deepEqual([...retry.data[0]], new Array(100).fill(19));
  assert.deepEqual([...retry.data[1]], new Array(100).fill(7));
});
