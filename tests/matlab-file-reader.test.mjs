import assert from "node:assert/strict";
import test from "node:test";
import { createMatlabFileReader } from "../app/matlab-file-reader.ts";
import { RawDatSource, EDFSource } from "../app/eeg-core.ts";

async function rawSource() {
  return RawDatSource.create(new File([new Int16Array(400)], "synthetic.dat"), { sampleRate: 200, channelCount: 2 });
}

function fakeWorkers() {
  const original = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class {
    constructor(url, options) { this.url = url; this.options = options; this.messages = []; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    complete(window = { synthetic: true }) {
      const requestId = this.messages.at(-1).requestId;
      this.onmessage({ data: { type: "complete", requestId, result: { window, metrics: { bytesRead: 100, readMs: 1, decodeMs: 2 } } } });
    }
  };
  return { workers, restore: () => {
    if (original === undefined) delete globalThis.Worker;
    else globalThis.Worker = original;
  } };
}

test("one lazy worker serializes many raw reads, preserves mapping, and forwards per-read diagnostics", async () => {
  const fake = fakeWorkers();
  try {
    const progress = [];
    const metrics = [];
    const localMetrics = [];
    const source = await rawSource();
    const reader = createMatlabFileReader(source, { onProgress: (item) => progress.push(item), onComplete: (item) => metrics.push(item) });
    assert.equal(fake.workers.length, 0);
    const selected = [1];
    const first = reader.readWindow(0, 0.2, selected, { onComplete: (item) => localMetrics.push(item) });
    selected[0] = 0;
    const second = reader.readWindow(0.2, 0.2, [0]);
    const worker = fake.workers[0];
    assert.equal(fake.workers.length, 1);
    assert.equal(worker.messages.length, 1, "queued read must not run concurrently");
    assert.equal(worker.messages[0].request.format, "raw-dat");
    assert.deepEqual(worker.messages[0].request.channelIndices, [1]);
    assert.equal(worker.messages[0].request.sampleRate, 200);
    worker.onmessage({ data: { type: "progress", requestId: worker.messages[0].requestId, progress: { bytesRead: 32 } } });
    worker.complete({ sequence: 1 });
    assert.deepEqual(await first, { sequence: 1 });
    assert.equal(worker.messages.length, 2);
    assert.equal(worker.terminated, undefined, "successful chunk must keep worker alive");
    worker.complete({ sequence: 2 });
    assert.deepEqual(await second, { sequence: 2 });
    assert.equal(fake.workers.length, 1);
    assert.equal(progress.length, 1);
    assert.equal(metrics.length, 2);
    assert.equal(localMetrics.length, 1);
    reader.dispose();
    assert.equal(worker.terminated, true);
    await assert.rejects(reader.readWindow(1, 1), { name: "AbortError" });
  } finally { fake.restore(); }
});

test("view or read cancellation terminates immediately and rejects active and queued reads", async () => {
  const fake = fakeWorkers();
  try {
    for (const perRead of [false, true]) {
      const abort = new AbortController();
      const reader = createMatlabFileReader(await rawSource(), perRead ? {} : { signal: abort.signal });
      const first = reader.readWindow(0, 0.2, [0], perRead ? { signal: abort.signal } : {});
      const queued = reader.readWindow(0.2, 0.2, [0]);
      const checks = [assert.rejects(first, { name: "AbortError" }), assert.rejects(queued, { name: "AbortError" })];
      abort.abort();
      assert.equal(fake.workers.at(-1).terminated, true);
      await Promise.all(checks);
    }
  } finally { fake.restore(); }
});

test("EDF routes its header and file to the same worker, and diagnostic failures cannot break results", async () => {
  const fake = fakeWorkers();
  try {
    // Exercise dispatch identity without loading real patient data or relying on
    // the decoder's separate EDF fixtures.
    const source = Object.create(EDFSource.prototype);
    Object.defineProperties(source, { sourceBlob: { value: new Blob(["synthetic"]) }, header: { value: { testHeader: true } } });
    const reader = createMatlabFileReader(source, { onComplete: () => { throw new Error("diagnostics unavailable"); } });
    const pending = reader.readWindow(10, 2, [3]);
    const worker = fake.workers[0];
    assert.equal(worker.messages[0].request.format, "edf");
    assert.equal(worker.messages[0].request.blob, source.sourceBlob);
    assert.equal(worker.messages[0].request.header, source.header);
    worker.complete();
    assert.deepEqual(await pending, { synthetic: true });
    reader.dispose();
  } finally { fake.restore(); }
});

test("worker failure and unavailable workers never decode EDF/DAT on the main thread", async () => {
  const fake = fakeWorkers();
  try {
    const source = await rawSource();
    source.getWindow = () => { throw new Error("must not decode here"); };
    const reader = createMatlabFileReader(source);
    const pending = reader.readWindow(0, 0.2);
    const check = assert.rejects(pending, /worker crashed/);
    fake.workers[0].onerror({ message: "worker crashed", preventDefault() {} });
    await check;
    assert.equal(fake.workers[0].terminated, true);
    delete globalThis.Worker;
    await assert.rejects(createMatlabFileReader(source).readWindow(0, 0.2), /does not provide module workers/);
  } finally { fake.restore(); }
});

test("non-EDF/DAT sources use their own API serially and receive cancellation", async () => {
  const fake = fakeWorkers();
  try {
    const calls = [];
    const source = { getWindow(start, duration, channels, options) {
      return new Promise((resolve) => calls.push({ start, duration, channels, options, resolve }));
    } };
    const reader = createMatlabFileReader(source);
    const first = reader.readWindow(0, 1, [2]);
    const second = reader.readWindow(1, 1, [3]);
    await Promise.resolve();
    assert.equal(calls.length, 1);
    calls[0].resolve({ sequence: 1 });
    assert.deepEqual(await first, { sequence: 1 });
    await Promise.resolve();
    assert.equal(calls.length, 2);
    const check = assert.rejects(second, { name: "AbortError" });
    reader.dispose();
    assert.equal(calls[1].options.signal.aborted, true);
    await check;
    calls[1].resolve({ stale: true });
    assert.equal(fake.workers.length, 0);
  } finally { fake.restore(); }
});
