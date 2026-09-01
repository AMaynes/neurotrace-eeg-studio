/** Verifies bounded, cancellable Raw DAT overview construction. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildRawDatEnvelopeWindow,
  RAW_DAT_HOST_IS_LITTLE_ENDIAN,
  rawDatEnvelopeTransferList,
} from "../app/raw-dat-envelope.ts";
import { RawDatSource } from "../app/eeg-core.ts";
import { sha256Blob } from "../app/source-integrity.ts";

function rawDatBlob(frames) {
  const channelCount = frames[0]?.length ?? 0;
  const bytes = new Uint8Array(frames.length * channelCount * 2);
  const view = new DataView(bytes.buffer);
  frames.forEach((frame, frameIndex) => frame.forEach((value, channelIndex) => {
    view.setInt16((frameIndex * channelCount + channelIndex) * 2, value, true);
  }));
  return new Blob([bytes]);
}

function requestFor(blob, overrides = {}) {
  return {
    blob,
    sampleRate: 4,
    channelCount: 3,
    channelLabels: ["A", "B", "C"],
    channelUnits: ["µV", "mV", "count"],
    physicalScales: [2, 0.5, 1],
    physicalOffsets: [1, -10, 5],
    startSec: 0,
    durationSec: 2,
    bucketCount: 2,
    channelIndices: [2, 0],
    chunkSizeBytes: 12,
    ...overrides,
  };
}

const frames = [
  [1, 100, -10],
  [3, 90, -20],
  [-5, 80, -30],
  [7, 70, -40],
  [9, 60, -50],
  [11, 50, -60],
  [13, 40, -70],
  [15, 30, -80],
];

test("Raw DAT envelope builder preserves calibrated extrema and reports bounded progress", async () => {
  const blob = rawDatBlob(frames);
  const updates = [];
  const result = await buildRawDatEnvelopeWindow(requestFor(blob), {
    onProgress: (update) => updates.push(update),
  });

  assert.deepEqual([...result.window.minima[0]], [-35, -75]);
  assert.deepEqual([...result.window.maxima[0]], [-5, -45]);
  assert.deepEqual([...result.window.data[0]], [-20, -60]);
  assert.deepEqual([...result.window.variation[0]], [30, 30]);
  assert.deepEqual([...result.window.gaps[0]], [0, 0]);
  assert.deepEqual([...result.window.minima[1]], [-9, 19]);
  assert.deepEqual([...result.window.maxima[1]], [15, 31]);
  assert.deepEqual([...result.window.data[1]], [3, 25]);
  assert.deepEqual([...result.window.variation[1]], [44, 12]);
  assert.deepEqual(result.window.channelIndices, [2, 0]);
  assert.deepEqual(result.window.channelLabels, ["C", "A"]);
  assert.deepEqual(result.window.channelUnits, ["count", "µV"]);
  assert.deepEqual(result.window.sampleRates, [1, 1]);
  assert.deepEqual(result.window.channelStartSecs, [0, 0]);
  assert.equal(result.window.startSec, 0);
  assert.equal(result.window.durationSec, 2);
  assert.equal(result.window.bucketDurationSec, 1);

  assert.equal(result.metrics.backend, "direct");
  assert.equal(
    result.metrics.decoder,
    RAW_DAT_HOST_IS_LITTLE_ENDIAN ? "int16-array" : "data-view",
  );
  assert.equal(result.metrics.bytesRead, blob.size);
  assert.equal(result.metrics.totalBytes, blob.size);
  assert.equal(result.metrics.framesRead, 8);
  assert.equal(result.metrics.totalFrames, 8);
  assert.equal(result.metrics.samplesDecoded, 16);
  assert.equal(result.metrics.chunksRead, 4);
  assert.ok(result.metrics.elapsedMs >= 0);
  assert.ok(result.metrics.readMs >= 0);
  assert.ok(result.metrics.decodeMs >= 0);
  assert.equal(result.metrics.integrityMs, 0);
  assert.equal(result.integrity, undefined);
  assert.deepEqual(updates.map((update) => update.phase), [
    "reading", "decoding",
    "reading", "decoding",
    "reading", "decoding",
    "reading", "decoding",
    "complete",
  ]);
  assert.equal(updates.at(-1).bytesRead, blob.size);
  assert.equal(updates.at(-1).samplesDecoded, 16);
});

test("Raw DAT native int16 decoder exactly matches the portable little-endian decoder", async () => {
  const edgeFrames = [
    [-32768, 32767, -1],
    [0, -32767, 1],
    [32767, -1, -32768],
    [-12345, 23456, -23456],
    [12345, -23456, 23456],
  ];
  const blob = rawDatBlob(edgeFrames);
  const request = requestFor(blob, {
    sampleRate: 5,
    startSec: 0.1,
    durationSec: 0.8,
    bucketCount: 7,
    channelIndices: [2, 0, 1],
    chunkSizeBytes: 19,
  });
  const automatic = await buildRawDatEnvelopeWindow(request);
  const portable = await buildRawDatEnvelopeWindow(request, {
    decoder: "portable-data-view",
  });

  assert.equal(portable.metrics.decoder, "data-view");
  assert.deepEqual(
    automatic.window.data.map((channel) => [...channel]),
    portable.window.data.map((channel) => [...channel]),
  );
  assert.deepEqual(
    automatic.window.minima.map((channel) => [...channel]),
    portable.window.minima.map((channel) => [...channel]),
  );
  assert.deepEqual(
    automatic.window.maxima.map((channel) => [...channel]),
    portable.window.maxima.map((channel) => [...channel]),
  );
  assert.deepEqual(
    automatic.window.gaps.map((channel) => [...channel]),
    portable.window.gaps.map((channel) => [...channel]),
  );
});

test("Raw DAT worker core matches the established source envelope exactly", async () => {
  const blob = rawDatBlob(frames);
  const file = new File([blob], "fixture.dat");
  const source = await RawDatSource.create(file, {
    sampleRate: 4,
    channelCount: 3,
    channelLabels: ["A", "B", "C"],
    channelUnits: ["µV", "mV", "count"],
    physicalScale: [2, 0.5, 1],
    physicalOffset: [1, -10, 5],
  });
  const expected = await source.getEnvelopeWindow(0.25, 1.5, 3, [2, 0]);
  const actual = (await buildRawDatEnvelopeWindow(requestFor(blob, {
    startSec: 0.25,
    durationSec: 1.5,
    bucketCount: 3,
  }))).window;

  assert.deepEqual(actual.data.map((channel) => [...channel]), expected.data.map((channel) => [...channel]));
  assert.deepEqual(actual.minima.map((channel) => [...channel]), expected.minima.map((channel) => [...channel]));
  assert.deepEqual(actual.maxima.map((channel) => [...channel]), expected.maxima.map((channel) => [...channel]));
  assert.deepEqual(actual.gaps.map((channel) => [...channel]), expected.gaps.map((channel) => [...channel]));
  assert.deepEqual(actual.variation.map((channel) => [...channel]), expected.variation.map((channel) => [...channel]));
  assert.deepEqual(actual.sampleRates, expected.sampleRates);
  assert.deepEqual(actual.channelStartSecs, expected.channelStartSecs);
  assert.equal(actual.startSec, expected.startSec);
  assert.equal(actual.durationSec, expected.durationSec);
  assert.equal(actual.bucketDurationSec, expected.bucketDurationSec);
  assert.deepEqual(actual.channelIndices, expected.channelIndices);
  assert.deepEqual(actual.channelLabels, expected.channelLabels);
  assert.deepEqual(actual.channelUnits, expected.channelUnits);
});

test("Raw DAT envelope and exact SHA-256 share one sequential source pass", async () => {
  class TrackingBlob extends Blob {
    reads = [];

    slice(start, end, type) {
      this.reads.push([start ?? 0, end ?? this.size]);
      return super.slice(start, end, type);
    }
  }

  const signal = rawDatBlob(frames);
  const trailing = new Uint8Array([0xa5, 0x5a, 0xff]);
  const source = new Blob([signal, trailing]);
  const tracked = new TrackingBlob([signal, trailing]);
  const updates = [];
  const result = await buildRawDatEnvelopeWindow(requestFor(tracked, {
    integrity: { sha256: true },
  }), {
    onProgress: (update) => updates.push(update),
  });

  assert.equal(result.integrity?.hash, await sha256Blob(source));
  assert.equal(result.metrics.bytesRead, tracked.size);
  assert.equal(result.metrics.totalBytes, tracked.size);
  assert.equal(result.metrics.framesRead, 8);
  assert.equal(result.metrics.totalFrames, 8);
  assert.equal(result.metrics.samplesDecoded, 16);
  assert.ok(result.metrics.integrityMs >= 0);
  assert.equal(tracked.reads[0][0], 0);
  assert.equal(tracked.reads.at(-1)[1], tracked.size);
  for (let index = 1; index < tracked.reads.length; index += 1) {
    assert.equal(tracked.reads[index][0], tracked.reads[index - 1][1], "source slices must be contiguous");
  }
  assert.equal(
    tracked.reads.reduce((sum, [start, end]) => sum + end - start, 0),
    tracked.size,
    "hashing and overview generation must not reread any source byte",
  );
  assert.equal(updates.at(-1).phase, "complete");
  assert.equal(updates.at(-1).integrityMs, result.metrics.integrityMs);
});

test("Raw DAT envelope builder keeps oversampled empty buckets neutral", async () => {
  const blob = rawDatBlob([[10], [20]]);
  const result = await buildRawDatEnvelopeWindow({
    blob,
    sampleRate: 1,
    channelCount: 1,
    channelLabels: ["A"],
    channelUnits: ["count"],
    physicalScales: [1],
    physicalOffsets: [0],
    startSec: 0,
    durationSec: 2,
    bucketCount: 4,
    channelIndices: [0],
  });

  assert.equal(result.window.data[0][0], 10);
  assert.ok(Number.isNaN(result.window.data[0][1]));
  assert.equal(result.window.data[0][2], 20);
  assert.ok(Number.isNaN(result.window.data[0][3]));
  assert.deepEqual([...result.window.gaps[0]], [0, 0, 0, 0]);
  assert.ok(Number.isNaN(result.window.minima[0][1]));
  assert.ok(Number.isNaN(result.window.maxima[0][3]));
});

test("Raw DAT envelope builder transfers each result buffer once", async () => {
  const result = await buildRawDatEnvelopeWindow(requestFor(rawDatBlob(frames)));
  const transfer = rawDatEnvelopeTransferList(result);
  assert.equal(transfer.length, 10);
  assert.equal(new Set(transfer).size, transfer.length);
  assert.ok(transfer.every((buffer) => buffer instanceof ArrayBuffer && buffer.byteLength > 0));
});

test("Raw DAT worker core builds and transfers finest-to-coarsest pyramid levels", async () => {
  const updates = [];
  const result = await buildRawDatEnvelopeWindow(requestFor(rawDatBlob(frames), {
    bucketCount: 8,
    pyramidMinimumBucketCount: 2,
  }), {
    onProgress: (update) => updates.push(update),
  });

  assert.equal(result.pyramidLevels?.[0], result.window);
  assert.deepEqual(result.pyramidLevels?.map((level) => level.data[0].length), [8, 4, 2]);
  assert.deepEqual([...result.pyramidLevels.at(-1).minima[0]], [-35, -75]);
  assert.deepEqual([...result.pyramidLevels.at(-1).maxima[0]], [-5, -45]);
  assert.equal(result.metrics.decoder, RAW_DAT_HOST_IS_LITTLE_ENDIAN ? "int16-array" : "data-view");
  assert.equal(updates.at(-1).phase, "complete");
  assert.equal(updates.at(-1).decodeMs, result.metrics.decodeMs);

  const transfer = rawDatEnvelopeTransferList(result);
  assert.equal(transfer.length, 30);
  assert.equal(new Set(transfer).size, transfer.length);
  assert.ok(transfer.every((buffer) => buffer instanceof ArrayBuffer && buffer.byteLength > 0));
});

test("Raw DAT envelope builder rejects invalid mappings and aborted work", async () => {
  const blob = rawDatBlob(frames);
  await assert.rejects(
    buildRawDatEnvelopeWindow(requestFor(blob, { channelIndices: [0, 0] })),
    /requested more than once/i,
  );
  await assert.rejects(
    buildRawDatEnvelopeWindow(requestFor(blob, { channelIndices: [3] })),
    /outside 0–2/i,
  );
  await assert.rejects(
    buildRawDatEnvelopeWindow(requestFor(blob, { physicalScales: [1, 1] })),
    /exactly 3 values/i,
  );
  await assert.rejects(
    buildRawDatEnvelopeWindow(requestFor(blob, { physicalOffsets: [0, Number.NaN, 0] })),
    /finite values/i,
  );
  await assert.rejects(
    buildRawDatEnvelopeWindow(requestFor(blob, { pyramidMinimumBucketCount: 0 })),
    /pyramid minimum bucket count must be a positive/i,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    buildRawDatEnvelopeWindow(requestFor(blob), { signal: controller.signal }),
    (error) => error?.name === "AbortError",
  );
});

test("Raw DAT worker wiring transfers results and terminates immediately on abort", async () => {
  const client = await readFile(new URL("../app/raw-dat-envelope-worker-client.ts", import.meta.url), "utf8");
  const worker = await readFile(new URL("../app/raw-dat-envelope-worker.ts", import.meta.url), "utf8");
  assert.match(client, /new Worker\(new URL\("\.\/raw-dat-envelope-worker\.ts"/);
  assert.match(client, /const onAbort = \(\) => finish\(\(\) => reject\(abortReason/);
  assert.match(client, /worker\.terminate\(\)/);
  assert.match(worker, /rawDatEnvelopeTransferList\(result\)/);
  assert.match(worker, /type: "progress"/);
});
