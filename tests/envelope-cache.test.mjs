/** Fixed-grid cache reuse must preserve source extrema and bounded read costs. */

import assert from "node:assert/strict";
import test from "node:test";

import {
  exactEnvelopeFrameGrid,
  mergeAdjacentEnvelopeWindows,
  planAlignedEnvelopeRequest,
  planEnvelopeExtension,
} from "../app/envelope-cache.ts";
import { buildRawDatEnvelopeWindow } from "../app/raw-dat-envelope.ts";

function envelope(startSec, count, step = 1) {
  const values = Float32Array.from({ length: count }, (_, index) => startSec + index * step);
  return {
    data: [values],
    minima: [Float32Array.from(values, (value) => value - 7)],
    maxima: [Float32Array.from(values, (value) => value + 9)],
    gaps: [new Uint8Array(count)],
    variation: [Float32Array.from(values, (value) => Math.abs(value) + 1)],
    sampleRates: [1 / step],
    channelStartSecs: [startSec],
    startSec,
    durationSec: count * step,
    channelIndices: [7],
    channelLabels: ["Electrode7"],
    channelUnits: ["ADC count"],
    bucketDurationSec: step,
  };
}

function extension(base, overrides = {}) {
  return planEnvelopeExtension({
    base,
    startSec: 10,
    endSec: 110,
    requiredBucketDurationSec: 1,
    sampleRate: 1000,
    recordingDurationSec: 1000,
    maxBaseBytes: 1_000_000,
    ...overrides,
  });
}

test("new cache reads use complete source-frame bins without lowering requested resolution", () => {
  const plan = planAlignedEnvelopeRequest({
    startSec: 1.125,
    endSec: 17.75,
    bucketCount: 1000,
    sampleRate: 1000,
    recordingDurationSec: 100,
  });
  assert.deepEqual(plan, { startSec: 1.12, durationSec: 16.64, bucketCount: 1040 });
  assert.ok(plan.durationSec / plan.bucketCount <= (17.75 - 1.125) / 1000);
  assert.equal(plan.startSec * 1000 % 16, 0);
  assert.ok(plan.startSec <= 1.125 && plan.startSec + plan.durationSec >= 17.75);
});

test("initial alignment declines incomplete EOF buckets, output overflow, and invalid inputs", () => {
  const request = { startSec: 0, endSec: 10, bucketCount: 30, sampleRate: 10, recordingDurationSec: 10 };
  assert.equal(planAlignedEnvelopeRequest(request), null);
  assert.equal(planAlignedEnvelopeRequest({ ...request, endSec: 9, maxBucketCount: 29 }), null);
  for (const changed of [{ sampleRate: 0 }, { endSec: Infinity }, { startSec: -1 }, { bucketCount: 0 }]) {
    assert.equal(planAlignedEnvelopeRequest({ ...request, ...changed }), null);
  }
  assert.deepEqual(planAlignedEnvelopeRequest({ ...request, bucketCount: 25 }), {
    startSec: 0, durationSec: 10, bucketCount: 25,
  });
});

test("integer frame detection tolerates only conversion roundoff, not genuinely fractional samples", () => {
  assert.deepEqual(exactEnvelopeFrameGrid(1.17, 1.32 - 1.17, 50, 1000), {
    startFrame: 1170, endFrame: 1320, framesPerBucket: 3,
  });
  assert.equal(exactEnvelopeFrameGrid(1.17001, 0.15, 50, 1000), null);
  assert.equal(exactEnvelopeFrameGrid(1.17, 0.15001, 50, 1000), null);
  assert.equal(exactEnvelopeFrameGrid(1.17, 0.15, 49, 1000), null);
  assert.equal(exactEnvelopeFrameGrid(0, 0, 1, 1000), null);
});

test("panning only requests missing adjacent buckets and preserves cached arrays", () => {
  const base = envelope(0, 100);
  const right = extension(base);
  assert.equal(right.base, base);
  assert.deepEqual(right.missing, [{ startSec: 100, durationSec: 10, bucketCount: 10 }]);
  assert.equal(right.startSec, 0);
  assert.equal(right.durationSec, 110);
  const left = extension(envelope(10, 100), { startSec: 0, endSec: 100 });
  assert.deepEqual(left.missing, [{ startSec: 0, durationSec: 10, bucketCount: 10 }]);
  const both = extension(envelope(20, 60), { startSec: 0, endSec: 100 });
  assert.deepEqual(both.missing, [
    { startSec: 0, durationSec: 20, bucketCount: 20 },
    { startSec: 80, durationSec: 20, bucketCount: 20 },
  ]);
});

test("extensions trim distant history and reject insufficient overlap, finer zoom, and excess memory", () => {
  const base = envelope(0, 200);
  const plan = extension(base, { startSec: 180, endSec: 220 });
  assert.equal(plan.base.startSec, 160);
  assert.equal(plan.base.durationSec, 40);
  assert.equal(plan.durationSec, 60);
  assert.ok(plan.durationSec <= 2 * 40);
  assert.deepEqual([...plan.base.minima[0]], [...base.minima[0].slice(160)]);
  assert.equal(base.data[0].length, 200, "planning must not mutate the original cache");
  assert.equal(extension(base, { startSec: 181, endSec: 221 }), null);
  assert.equal(extension(envelope(0, 100), { requiredBucketDurationSec: 0.5 }), null);
  assert.equal(extension(envelope(0, 100), { maxBaseBytes: 1699 }), null);
  const capped = extension(envelope(0, 100), { maxBaseBytes: 1700 });
  assert.equal(capped.bucketCount, 100);
  assert.equal(capped.base.startSec, 10);
  assert.deepEqual(capped.missing, [{ startSec: 100, durationSec: 10, bucketCount: 10 }]);
  assert.ok(extension(envelope(0, 100), { maxBaseBytes: 1870 }));
  assert.equal(extension(envelope(0, 100), { startSec: 10, endSec: 90 }), null);
});

test("extensions decline fractional-frame grids and EOF fragments instead of fabricating bins", () => {
  assert.equal(extension(envelope(0.0005, 100)), null);
  assert.equal(extension(envelope(0, 100, 0.1005), { startSec: 1, endSec: 11 }), null);
  assert.equal(extension(envelope(0, 100, 0.3), {
    startSec: 1,
    endSec: 30.1,
    requiredBucketDurationSec: 0.3,
    recordingDurationSec: 30.1,
  }), null);
  assert.equal(extension(envelope(0, 100), { recordingDurationSec: 100 }), null);
});

test("adjacent merge retains values, gaps, variation, metadata, and chronological order exactly", () => {
  const first = envelope(10, 2);
  const second = envelope(12, 3);
  first.data[0][1] = NaN;
  first.gaps[0][1] = 1;
  second.minima[0][0] = -32768;
  second.maxima[0][1] = 32767;
  const merged = mergeAdjacentEnvelopeWindows([second, first]);
  for (const field of ["data", "minima", "maxima", "gaps", "variation"]) {
    assert.deepEqual([...merged[field][0]], [...first[field][0], ...second[field][0]]);
  }
  assert.equal(merged.startSec, 10);
  assert.equal(merged.durationSec, 5);
  assert.deepEqual(merged.channelStartSecs, [10]);
  assert.deepEqual(merged.channelIndices, [7]);
  assert.deepEqual(merged.channelLabels, ["Electrode7"]);
  assert.deepEqual(merged.channelUnits, ["ADC count"]);
  assert.equal(mergeAdjacentEnvelopeWindows([first]), first);
});

test("merge rejects incompatible channels, units, shape, timing, and missing metadata", () => {
  const first = envelope(0, 10);
  for (const changed of [
    { channelIndices: [8] },
    { channelUnits: ["µV"] },
    { channelLabels: ["Other"] },
    { variation: undefined },
    { gaps: [new Uint8Array(2)] },
    { sampleRates: [2] },
    { channelStartSecs: [11] },
  ]) {
    assert.throws(() => mergeAdjacentEnvelopeWindows([first, { ...envelope(10, 10), ...changed }]), /Envelope merge/);
  }
  assert.throws(() => mergeAdjacentEnvelopeWindows([first, envelope(9, 10)]), /adjacent/);
  assert.throws(() => mergeAdjacentEnvelopeWindows([first, envelope(11, 10)]), /adjacent/);
  assert.throws(() => mergeAdjacentEnvelopeWindows([]), /at least one/);
});

test("one-hour DAT overview pan reads only ten added seconds and keeps every overlapping peak", async () => {
  const sampleRate = 10;
  const channelCount = 3;
  const values = Int16Array.from({ length: 3620 * sampleRate * channelCount },
    (_, index) => (index * 47 % 65536) - 32768);
  const source = {
    blob: new Blob([values]),
    sampleRate,
    channelCount,
    channelLabels: ["A1", "A2", "B1"],
    channelUnits: ["ADC count", "ADC count", "ADC count"],
    physicalScales: [1, 0.5, 2],
    physicalOffsets: [0, -1, 10],
    channelIndices: [2, 0],
    chunkSizeBytes: 4096,
  };
  const original = await buildRawDatEnvelopeWindow({ ...source, startSec: 0, durationSec: 3600, bucketCount: 3600 });
  const plan = planEnvelopeExtension({
    base: original.window,
    startSec: 10,
    endSec: 3610,
    requiredBucketDurationSec: 1,
    sampleRate,
    recordingDurationSec: 3620,
    maxBaseBytes: 1_000_000,
  });
  assert.ok(plan);
  const additions = await Promise.all(plan.missing.map((part) => buildRawDatEnvelopeWindow({ ...source, ...part })));
  const bytesRead = additions.reduce((sum, result) => sum + result.metrics.bytesRead, 0);
  assert.equal(bytesRead, 10 * sampleRate * channelCount * 2);
  assert.equal(original.metrics.bytesRead / bytesRead, 360);
  const merged = mergeAdjacentEnvelopeWindows([plan.base, ...additions.map((result) => result.window)]);
  for (const field of ["data", "minima", "maxima", "gaps", "variation"]) {
    for (let channel = 0; channel < 2; channel += 1) {
      assert.deepEqual(merged[field][channel].slice(0, 3600), original.window[field][channel]);
    }
  }
  const full = await buildRawDatEnvelopeWindow({ ...source, startSec: 0, durationSec: 3610, bucketCount: 3610 });
  assert.deepEqual(merged, full.window);
});

test("DAT split reads keep identical bucket membership at nonbinary durations and positive offsets", async () => {
  const values = Int16Array.from({ length: 20_000 }, (_, index) => index);
  const source = {
    blob: new Blob([values]), sampleRate: 1000, channelCount: 1,
    channelLabels: ["A1"], channelUnits: ["ADC count"], physicalScales: [1], physicalOffsets: [0],
  };
  for (const widthFrames of [3, 7, 20, 33, 100]) {
    for (const startFrame of [20, 120, 1020]) {
      const full = (await buildRawDatEnvelopeWindow({
        ...source, startSec: startFrame / 1000, durationSec: widthFrames * 100 / 1000, bucketCount: 100,
      })).window;
      const pieces = [];
      for (const firstBucket of [0, 50]) {
        pieces.push((await buildRawDatEnvelopeWindow({
          ...source,
          startSec: (startFrame + widthFrames * firstBucket) / 1000,
          durationSec: widthFrames * 50 / 1000,
          bucketCount: 50,
        })).window);
      }
      const merged = mergeAdjacentEnvelopeWindows(pieces);
      assert.ok(Math.abs(merged.durationSec - full.durationSec) <= Number.EPSILON * 16,
        "duration representations may differ only by floating-point arithmetic roundoff");
      assert.deepEqual({ ...merged, durationSec: full.durationSec }, full,
        `start frame ${startFrame}, ${widthFrames} frames per bucket`);
    }
  }
});

test("repeated pans retain bounded coverage while reading only each newly exposed interval", async () => {
  const source = {
    blob: new Blob([Int16Array.from({ length: 1000 }, (_, index) => index - 500)]),
    sampleRate: 1, channelCount: 1, channelLabels: ["A1"], channelUnits: ["ADC count"],
    physicalScales: [1], physicalOffsets: [0],
  };
  let base = (await buildRawDatEnvelopeWindow({ ...source, startSec: 0, durationSec: 100, bucketCount: 100 })).window;
  let readBytes = 0;
  for (let start = 10; start <= 500; start += 10) {
    const plan = extension(base, { startSec: start, endSec: start + 100, sampleRate: 1 });
    assert.ok(plan);
    const parts = await Promise.all(plan.missing.map((part) => buildRawDatEnvelopeWindow({ ...source, ...part })));
    readBytes += parts.reduce((sum, part) => sum + part.metrics.bytesRead, 0);
    base = mergeAdjacentEnvelopeWindows([plan.base, ...parts.map((part) => part.window)]);
    assert.ok(base.durationSec <= 200);
    assert.ok(base.startSec <= start && base.startSec + base.durationSec >= start + 100);
    assert.equal(base.minima[0][Math.round(start - base.startSec)], start - 500);
  }
  assert.equal(readBytes, 500 * 2);
});

test("large recording offsets keep canonical time metadata and exact split-read membership", async () => {
  const startFrame = 1_000_000_020;
  const sampleRate = 1000;
  // A synthetic random-access blob models a long source without retaining its
  // preceding bytes or touching any patient recording.
  const blob = {
    size: (startFrame + 2000) * 2,
    slice(firstByte, endByte) {
      const values = Int16Array.from({ length: (endByte - firstByte) / 2 },
        (_, index) => (firstByte / 2 + index) % 32768);
      return new Blob([values]);
    },
  };
  const source = {
    blob, sampleRate, channelCount: 1, channelLabels: ["A1"], channelUnits: ["ADC count"],
    physicalScales: [1], physicalOffsets: [0],
  };
  const full = (await buildRawDatEnvelopeWindow({
    ...source, startSec: startFrame / sampleRate, durationSec: 0.6, bucketCount: 200,
  })).window;
  const left = (await buildRawDatEnvelopeWindow({
    ...source, startSec: startFrame / sampleRate, durationSec: 0.3, bucketCount: 100,
  })).window;
  const right = (await buildRawDatEnvelopeWindow({
    ...source, startSec: (startFrame + 300) / sampleRate, durationSec: 0.3, bucketCount: 100,
  })).window;
  assert.deepEqual(mergeAdjacentEnvelopeWindows([left, right]), full);
  assert.equal(full.bucketDurationSec, 0.003);
  assert.deepEqual(full.sampleRates, [1000 / 3]);
  assert.equal(full.data[0].length, 200);
  assert.equal(full.minima[0][0], startFrame % 32768);
});

test("canceling an incremental read leaves cached buckets untouched and a retry merges exactly", async () => {
  const source = {
    blob: new Blob([Int16Array.from({ length: 1200 }, (_, index) => index * 17 % 32768)]),
    sampleRate: 10, channelCount: 1, channelLabels: ["A1"], channelUnits: ["ADC count"],
    physicalScales: [0.5], physicalOffsets: [-10], chunkSizeBytes: 40,
  };
  const original = (await buildRawDatEnvelopeWindow({
    ...source, startSec: 0, durationSec: 100, bucketCount: 100,
  })).window;
  const snapshot = structuredClone(original);
  const plan = extension(original, { sampleRate: 10, recordingDurationSec: 120 });
  assert.ok(plan);
  const controller = new AbortController();
  await assert.rejects(buildRawDatEnvelopeWindow({ ...source, ...plan.missing[0] }, {
    signal: controller.signal,
    onProgress: () => controller.abort(),
  }), { name: "AbortError" });
  assert.deepEqual(original, snapshot, "canceled extension must not alter the usable old cache");
  const retry = await buildRawDatEnvelopeWindow({ ...source, ...plan.missing[0] });
  const merged = mergeAdjacentEnvelopeWindows([plan.base, retry.window]);
  const complete = await buildRawDatEnvelopeWindow({
    ...source, startSec: 0, durationSec: 110, bucketCount: 110,
  });
  assert.deepEqual(merged, complete.window);
  assert.deepEqual(original, snapshot, "successful merge must also leave caller-owned input untouched");
});

test("157-channel cache at its size cap reads only 50 new bins for a ten-second pan", () => {
  const channelCount = 157;
  const bucketCount = 25_143;
  const step = 0.2;
  const base = envelope(0, bucketCount, step);
  // Shared arrays keep this metadata/budget regression small; production
  // channels own separate arrays but have exactly the same byte accounting.
  for (const field of ["data", "minima", "maxima", "gaps", "variation"]) {
    base[field] = Array(channelCount).fill(base[field][0]);
  }
  base.channelIndices = Array.from({ length: channelCount }, (_, index) => index);
  base.channelLabels = base.channelIndices.map((index) => `Electrode${index}`);
  base.channelUnits = Array(channelCount).fill("ADC count");
  base.sampleRates = Array(channelCount).fill(1 / step);
  base.channelStartSecs = Array(channelCount).fill(0);
  const plan = extension(base, {
    startSec: 10,
    endSec: 10 + bucketCount * step,
    requiredBucketDurationSec: step,
    recordingDurationSec: 10_000,
    maxBaseBytes: channelCount * bucketCount * 17,
  });
  assert.ok(plan);
  assert.equal(plan.bucketCount, bucketCount);
  assert.equal(plan.base.startSec, 10);
  assert.equal(plan.base.data[0].length, bucketCount - 50);
  assert.deepEqual(plan.missing, [{ startSec: 5028.6, durationSec: 10, bucketCount: 50 }]);
  assert.equal(plan.base.minima[0].buffer, base.minima[0].buffer, "planning retains zero-copy views");
});

test("alignment at a 157-channel cache cap may use complete coarser bins only within display resolution", () => {
  const request = {
    startSec: 10.001,
    endSec: 3610.001,
    sampleRate: 1000,
    bucketCount: 25_143,
    maxBucketCount: 25_143,
    recordingDurationSec: 7200,
  };
  assert.equal(planAlignedEnvelopeRequest(request), null, "omitting a display ceiling keeps the strict finer-grid contract");
  const plan = planAlignedEnvelopeRequest({ ...request, maximumBucketDurationSec: 0.2 });
  assert.ok(plan);
  assert.ok(plan.bucketCount <= 25_143);
  assert.ok(plan.durationSec / plan.bucketCount <= 0.2);
  assert.ok(plan.startSec <= request.startSec);
  assert.ok(plan.startSec + plan.durationSec >= request.endSec);
  assert.ok(exactEnvelopeFrameGrid(plan.startSec, plan.durationSec, plan.bucketCount, 1000));
  assert.equal(planAlignedEnvelopeRequest({ ...request, maximumBucketDurationSec: 0.143 }), null,
    "alignment must not become coarser than the visible resolution to fit the cap");
  assert.equal(planAlignedEnvelopeRequest({
    ...request, endSec: 7200, maximumBucketDurationSec: 1,
  }), null, "an incomplete final grid bucket must still fall back to a normal EOF read");
});
