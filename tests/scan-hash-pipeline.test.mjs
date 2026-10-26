import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createScanHashPipeline, parallelScanHashEnabled } from "../app/scan-hash-worker-client.ts";
import { BrowserWorker } from "./fixtures/browser-worker.mjs";
import { buildRawDatEnvelopeWindow } from "../app/raw-dat-envelope.ts";
import { executeEDFEnvelopeBuild } from "../app/edf-envelope-integrity.ts";

const threshold = 32 * 1024 * 1024;
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function withWorker(WorkerType, run) {
  const previous = globalThis.Worker;
  const navigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  globalThis.Worker = WorkerType;
  Object.defineProperty(globalThis, "navigator", { value: { hardwareConcurrency: 8 }, configurable: true });
  try { return await run(); }
  finally {
    if (previous === undefined) delete globalThis.Worker; else globalThis.Worker = previous;
    if (navigator) Object.defineProperty(globalThis, "navigator", navigator); else delete globalThis.navigator;
  }
}

test("parallel hashing is reserved for substantial files on machines with spare CPU capacity", () => {
  assert.equal(parallelScanHashEnabled(threshold, 8), true);
  assert.equal(parallelScanHashEnabled(threshold - 1, 8), false);
  for (const cores of [1, 2, 3, NaN]) assert.equal(parallelScanHashEnabled(threshold, cores), false);
});

test("a real hash worker preserves exact SHA-256 across chunks without detaching producer buffers", async () => {
  await withWorker(BrowserWorker, async () => {
    const pipeline = await createScanHashPipeline(threshold);
    assert.ok(pipeline);
    try {
      const input = Uint8Array.from({ length: 1024 * 1024 + 137 }, (_, index) => index * 47 & 255);
      const expected = createHash("sha256").update(input).digest("hex");
      for (let start = 0; start < input.length; start += 65_521) await pipeline.write(input.subarray(start, start + 65_521));
      assert.equal(input.byteLength, 1024 * 1024 + 137, "overview decoder keeps its source buffer");
      assert.equal(input[137], 137 * 47 & 255);
      assert.equal(await pipeline.hexDigest(), expected);
      assert.ok(pipeline.workMs >= 0);
    } finally { pipeline.dispose(); }
  });
});

test("hash pipeline applies backpressure with only one queued chunk", async () => {
  const workers = [];
  await withWorker(class {
    constructor() { workers.push(this); this.messages = []; }
    postMessage(message, transfer) {
      const copy = structuredClone(message, { transfer });
      if (copy.type === "ready") queueMicrotask(() => this.onmessage({ data: { id: copy.id, workMs: 0 } }));
      else this.messages.push(copy);
    }
    terminate() { this.stopped = true; }
    reply() { const message = this.messages.shift(); this.onmessage({ data: { id: message.id, workMs: 1 } }); }
  }, async () => {
    const pipeline = await createScanHashPipeline(threshold);
    assert.ok(pipeline);
    const worker = workers[0];
    try {
      await pipeline.write(new Uint8Array([1]));
      const next = pipeline.write(new Uint8Array([2]));
      await tick();
      assert.equal(worker.messages.length, 1);
      assert.deepEqual([...new Uint8Array(worker.messages[0].buffer)], [1]);
      worker.reply();
      await next;
      assert.equal(worker.messages.length, 1);
      assert.deepEqual([...new Uint8Array(worker.messages[0].buffer)], [2]);
      worker.reply();
    } finally { pipeline.dispose(); }
    assert.equal(worker.stopped, true);
  });
});

test("worker startup failure falls back before reading bytes; mid-stream failures reject verification", async () => {
  await withWorker(class { constructor() { throw new Error("No nested workers"); } }, async () => {
    assert.equal(await createScanHashPipeline(threshold), undefined);
  });
  const workers = [];
  await withWorker(class {
    constructor() { workers.push(this); }
    postMessage(message) {
      if (message.type === "ready") queueMicrotask(() => this.onmessage({ data: { id: message.id, workMs: 0 } }));
    }
    terminate() { this.stopped = true; }
  }, async () => {
    const pipeline = await createScanHashPipeline(threshold);
    const worker = workers[0];
    try {
      await pipeline.write(new Uint8Array([1, 2, 3]));
      worker.onerror({ message: "Hash thread failed", preventDefault() {} });
      await assert.rejects(pipeline.hexDigest(), /Hash thread failed/);
    } finally { pipeline.dispose(); }
    assert.equal(worker.stopped, true);
  });
});

test("parallel DAT scan matches serial envelopes and hashes every byte exactly once, including trailing data", async () => {
  await withWorker(BrowserWorker, async () => {
    const blob = new Blob([Int16Array.from({ length: 291 }, (_, i) => i * 47 - 5000), new Uint8Array([1, 2, 3])]);
    const request = { blob, sampleRate: 100, channelCount: 3, channelLabels: ["A", "B", "C"],
      channelUnits: ["count", "count", "count"], physicalScales: [1, 0.5, 2], physicalOffsets: [0, -1, 5],
      startSec: 0.11, durationSec: 0.7, bucketCount: 13, channelIndices: [2, 0], chunkSizeBytes: 37, integrity: { sha256: true } };
    const serial = await buildRawDatEnvelopeWindow(request);
    const pipeline = await createScanHashPipeline(threshold);
    assert.ok(pipeline);
    const ranges = [], slice = blob.slice.bind(blob);
    blob.slice = (start, end) => { ranges.push([start, end]); return slice(start, end); };
    try {
      const parallel = await buildRawDatEnvelopeWindow(request, { hashPipeline: pipeline });
      assert.deepEqual(parallel.window, serial.window);
      assert.equal(parallel.integrity.hash, createHash("sha256").update(new Uint8Array(await blob.arrayBuffer())).digest("hex"));
      assert.equal(parallel.integrity.hash, serial.integrity.hash);
      assert.equal(parallel.metrics.bytesRead, blob.size);
      assert.equal(ranges[0][0], 0);
      assert.equal(ranges.at(-1)[1], blob.size);
      ranges.slice(1).forEach(([start], index) => assert.equal(start, ranges[index][1], "one contiguous source pass"));
    } finally { pipeline.dispose(); }
  });
});

test("parallel EDF scan retains exact waveform, annotation, header and trailing-byte integrity", async () => {
  await withWorker(BrowserWorker, async () => {
    const records = Array.from({ length: 3 }, (_, index) => {
      const bytes = new Uint8Array(70);
      new DataView(bytes.buffer).setInt16(0, (index + 1) * 100, true);
      bytes.set(new TextEncoder().encode(`+${index}\x14Marker ${index}\x14\0`), 6);
      return bytes;
    });
    const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), ...records, new Uint8Array([3, 2, 1])]);
    const header = { headerBytes: 8, bytesPerDataRecord: 70, dataRecordCount: 3, dataRecordDurationSec: 1,
      signals: [
        { index: 0, label: "A", isAnnotation: false, physicalDimension: "uV", physicalMinimum: -32768,
          physicalMaximum: 32767, digitalMinimum: -32768, digitalMaximum: 32767,
          samplesPerRecord: 3, sampleRate: 3, byteOffsetInRecord: 0 },
        { index: 1, label: "EDF Annotations", isAnnotation: true, samplesPerRecord: 32, byteOffsetInRecord: 6 },
      ] };
    const request = { blob, header, startSec: 0.2, durationSec: 2.5, bucketCount: 7, channelIndices: [0],
      chunkSizeBytes: 70, integrity: { sha256: true, edfAnnotations: true } };
    const serial = await executeEDFEnvelopeBuild(request);
    const pipeline = await createScanHashPipeline(threshold);
    assert.ok(pipeline);
    try {
      const parallel = await executeEDFEnvelopeBuild(request, { hashPipeline: pipeline });
      assert.deepEqual(parallel.window, serial.window);
      assert.deepEqual(parallel.integrity, serial.integrity);
      assert.equal(parallel.integrity.edfAnnotations.events.length, 3);
      assert.equal(parallel.metrics.bytesRead, blob.size);
      assert.equal(parallel.integrity.hash, createHash("sha256").update(new Uint8Array(await blob.arrayBuffer())).digest("hex"));
    } finally { pipeline.dispose(); }
  });
});
