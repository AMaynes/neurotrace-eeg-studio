/** Runs the real worker logic against a synthetic HDF5 adapter and task queue. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as contracts from "../app/mat73.ts";
import * as progressive from "../app/progressive-envelope.ts";
import { Mat73WorkerClient } from "../app/mat73-worker-client.ts";

const source = await readFile(new URL("../app/mat73-worker.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const sampleValue = (sample, channel) => sample === 333 ? Number.NaN : sample % 37 - 18 + channel * 5;

async function workerHarness(valuesAt = sampleValue) {
  const tasks = [];
  const messages = [];
  const reads = [];
  const files = [];
  class Dataset {
    constructor(path) { this.path = path; this.dtype = "<d"; }
    get shape() { return this.path === "/Fs" ? [1, 1] : [600_000, 2]; }
    get value() { return new Float64Array([1000]); }
    slice(ranges) {
      assert.equal(files.at(-1).closed, false, "no HDF5 access after close");
      const [[start, end], [firstChannel, endChannel]] = ranges;
      reads.push({ start, end, firstChannel, endChannel });
      return Float64Array.from({ length: (end - start) * (endChannel - firstChannel) }, (_, index) =>
        valuesAt(start + Math.floor(index / (endChannel - firstChannel)), firstChannel + index % (endChannel - firstChannel)));
    }
  }
  class Group {}
  class H5File {
    constructor() { this.closed = false; files.push(this); }
    keys() { return ["data", "Fs"]; }
    get(key) { return new Dataset(`/${key}`); }
    close() { this.closed = true; }
  }
  class TaskChannel {
    constructor() {
      this.port1 = { onmessage: undefined, close() {} };
      this.port2 = { close() {}, postMessage: () => tasks.push(() => this.port1.onmessage()) };
    }
  }
  const scope = { postMessage: (message, transfer = []) => messages.push(structuredClone(message, { transfer })) };
  vm.runInNewContext(compiled, {
    exports: {}, self: scope, Float32Array, Float64Array, Uint8Array, Uint32Array,
    ArrayBuffer, TextDecoder, AbortController, DOMException, MessageChannel: TaskChannel,
    performance: { now: () => messages.length * 1000 },
    require(id) {
      if (id === "h5wasm") return {
        __esModule: true, Dataset, Group, Reference: class {},
        default: { File: H5File, ready: Promise.resolve({ FS: {
          mkdir() {}, mount() {}, unmount() {}, rmdir() {}, filesystems: { WORKERFS: {} },
        } }) },
      };
      if (id === "./mat73") return contracts;
      if (id === "./progressive-envelope") return progressive;
      throw new Error(`Unexpected worker dependency: ${id}`);
    },
  });
  const settle = async () => { for (let step = 0; step < 6; step++) await Promise.resolve(); };
  const send = (request) => scope.onmessage({ data: request });
  const advance = async () => { tasks.shift()?.(); await settle(); };
  send({ type: "open", requestId: 1, file: { name: "synthetic.mat" } });
  await settle();
  assert.equal(messages[0].type, "opened");
  return { send, advance, settle, messages, reads, tasks };
}

const envelope = (requestId = 2) => ({
  type: "envelope", requestId, firstSample: 0, endSample: 600_000,
  startSec: 0, durationSec: 600, bucketCount: 24,
  channelIndices: [0, 1], overviewIntervalMs: 1,
});

test("MAT73 overview yields to ordinary windows and publishes immutable exact prefixes", async () => {
  const harness = await workerHarness();
  harness.send(envelope());
  assert.equal(harness.reads.length, 1, "the full-file request stops after one bounded chunk");
  const prefix = harness.messages.find((message) => message.type === "overview").result;
  assert.ok(prefix.data[0].length > 0 && prefix.data[0].length < 24);
  harness.send({ type: "window", requestId: 3, firstSample: 500_000, endSample: 500_003, channelIndices: [1] });
  const ordinary = harness.messages.find((message) => message.type === "window");
  assert.deepEqual(ordinary.result.data[0], Float32Array.from([500_000, 500_001, 500_002], (sample) => sampleValue(sample, 1)));
  assert.equal(harness.messages.some((message) => message.type === "envelope"), false,
    "ordinary navigation finishes before the background full scan");
  while (harness.tasks.length) await harness.advance();
  const final = harness.messages.find((message) => message.type === "envelope").result;
  for (const message of harness.messages.filter((message) => message.type === "overview")) {
    for (const field of ["data", "minima", "maxima", "gaps"]) {
      for (let channel = 0; channel < 2; channel++) {
        assert.deepEqual(message.result[field][channel], final[field][channel].slice(0, message.result.data[0].length));
      }
    }
  }
  const expected = [0, 1].map(() => ({
    data: new Float32Array(24).fill(Number.NaN), minima: new Float32Array(24).fill(Infinity),
    maxima: new Float32Array(24).fill(-Infinity), counts: new Uint32Array(24),
  }));
  for (let sample = 0; sample < 600_000; sample++) {
    const bucket = Math.floor(sample / 25_000);
    for (let channel = 0; channel < 2; channel++) {
      const value = sampleValue(sample, channel);
      if (!Number.isFinite(value)) continue;
      const output = expected[channel];
      const count = ++output.counts[bucket];
      output.data[bucket] = count === 1 ? value : output.data[bucket] + (value - output.data[bucket]) / count;
      if (value < output.minima[bucket]) output.minima[bucket] = value;
      if (value > output.maxima[bucket]) output.maxima[bucket] = value;
    }
  }
  for (let channel = 0; channel < 2; channel++) {
    for (const field of ["data", "minima", "maxima"]) assert.deepEqual(final[field][channel], expected[channel][field]);
  }
});

test("MAT73 cancellation stops further chunks while subsequent reads remain usable", async () => {
  const harness = await workerHarness();
  harness.send(envelope());
  harness.send({ type: "cancel", requestId: 2 });
  while (harness.tasks.length) await harness.advance();
  assert.equal(harness.reads.length, 1);
  assert.equal(harness.messages.some((message) => message.type === "envelope"), false);
  harness.send({ type: "window", requestId: 3, firstSample: 20, endSample: 23, channelIndices: [0] });
  assert.equal(harness.messages.at(-1).type, "window");
});

test("MAT73 progressive gaps and fractional buckets have the same final values", async () => {
  const harness = await workerHarness((sample, channel) => channel === 0 ? Number.NaN : sampleValue(sample, channel));
  harness.send({ ...envelope(), startSec: .1255, firstSample: 125, durationSec: 599.4, endSample: 599526, bucketCount: 29 });
  while (harness.tasks.length) await harness.advance();
  const final = harness.messages.find((message) => message.type === "envelope").result;
  assert.ok(final.minima[0].every(Number.isNaN));
  assert.ok(final.data[0].every(Number.isNaN));
  assert.ok(final.gaps[0].every((value) => value === 1));
  for (const message of harness.messages.filter((message) => message.type === "overview")) {
    for (const field of ["data", "minima", "maxima", "gaps"]) {
      for (let channel = 0; channel < 2; channel++) {
        assert.deepEqual(message.result[field][channel], final[field][channel].slice(0, message.result.data[0].length));
      }
    }
  }
});

test("MAT73 close fences suspended jobs before opening a replacement file", async () => {
  const harness = await workerHarness();
  harness.send(envelope());
  harness.send({ type: "close", requestId: 3 });
  harness.send({ type: "open", requestId: 4, file: { name: "replacement.mat" } });
  await harness.settle();
  while (harness.tasks.length) await harness.advance();
  assert.equal(harness.reads.length, 1, "old job cannot read the replacement dataset");
  assert.equal(harness.messages.some((message) => message.type === "envelope"), false);
  harness.send({ type: "window", requestId: 5, firstSample: 4, endSample: 7, channelIndices: [0] });
  assert.equal(harness.messages.at(-1).requestId, 5);
  assert.equal(harness.messages.at(-1).type, "window");
});

test("MAT73 client keeps previews pending and cancels background work without closing the source", async (t) => {
  const workers = [];
  class FakeWorker {
    messages = [];
    constructor() { workers.push(this); }
    postMessage(message) {
      this.messages.push(message);
      if (message.type === "open") queueMicrotask(() => this.onmessage({ data: { type: "opened", requestId: message.requestId, result: {} } }));
    }
    terminate() { this.terminated = true; }
    respond(message) { this.onmessage({ data: message }); }
  }
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: FakeWorker });
  t.after(() => {
    if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker);
    else delete globalThis.Worker;
  });
  const { client } = await Mat73WorkerClient.create(new File(["x"], "synthetic.mat"));
  const worker = workers[0];
  const controller = new AbortController();
  const previews = [];
  const pending = client.readEnvelope(envelope(), controller.signal, (preview) => previews.push(preview));
  const rejected = assert.rejects(pending, { name: "AbortError" });
  const request = worker.messages.at(-1);
  worker.respond({ type: "overview", requestId: request.requestId, result: { data: [] } });
  assert.equal(previews.length, 1);
  controller.abort();
  await rejected;
  assert.deepEqual(worker.messages.at(-1), { type: "cancel", requestId: request.requestId });
  worker.respond({ type: "overview", requestId: request.requestId, result: { data: [] } });
  assert.equal(previews.length, 1, "late canceled previews are ignored");
  assert.equal(worker.terminated, undefined);
  const window = client.readWindow(0, 1, [0]);
  worker.respond({ type: "window", requestId: worker.messages.at(-1).requestId, result: { data: [new Float32Array([7])], firstSample: 0 } });
  assert.equal((await window).data[0][0], 7);
  const outstanding = client.readEnvelope(envelope());
  const closedRead = assert.rejects(outstanding, { name: "AbortError" });
  client.close();
  await closedRead;
  const closeRequest = worker.messages.at(-1);
  assert.equal(closeRequest.type, "close");
  worker.respond({ type: "closed", requestId: closeRequest.requestId });
  await Promise.resolve();
  assert.equal(worker.terminated, true);
  await assert.rejects(client.readWindow(0, 1, [0]), /closed/);
});
