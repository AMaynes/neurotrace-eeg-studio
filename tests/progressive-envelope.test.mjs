/** Exact, immutable prefix publication and browser-worker delivery contracts. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createProgressiveEnvelopePublisher,
  envelopeOverviewTransferList,
} from "../app/progressive-envelope.ts";
import { buildRawDatEnvelopeWindowOffThread } from "../app/raw-dat-envelope-worker-client.ts";
import { buildEDFEnvelopeWindowOffThread } from "../app/edf-envelope-worker-client.ts";

function liveWindow() {
  return {
    data: [Float32Array.from([2, NaN, 7, 10])],
    minima: [Float32Array.from([1, Infinity, 4, 9])],
    maxima: [Float32Array.from([3, -Infinity, 9, 11])],
    gaps: [Uint8Array.from([0, 0, 1, 0])],
    variation: [Float32Array.from([2, 0, 5, 2])],
    startSec: 5,
    durationSec: 2,
    bucketDurationSec: 0.5,
    sampleRates: [2],
    channelStartSecs: [5],
    channelIndices: [7],
    channelLabels: ["A"],
    channelUnits: ["count"],
  };
}

test("overview publisher skips unfinished future buckets and isolates transferable snapshots", () => {
  const source = liveWindow();
  const before = structuredClone(source);
  const snapshots = [];
  const publish = createProgressiveEnvelopePublisher(source, 500, (snapshot) => {
    snapshots.push(structuredClone(snapshot, { transfer: envelopeOverviewTransferList(snapshot) }));
  });
  publish(0);
  assert.equal(snapshots.length, 0);
  publish(3);
  assert.equal(snapshots.length, 1);
  const snapshot = snapshots[0];
  assert.equal(snapshot.startSec, 5);
  assert.equal(snapshot.durationSec, 1.5);
  assert.equal(snapshot.bucketDurationSec, 0.5);
  assert.deepEqual([...snapshot.data[0]], [2, NaN, NaN]);
  assert.deepEqual([...snapshot.minima[0]], [1, NaN, 4]);
  assert.deepEqual([...snapshot.maxima[0]], [3, NaN, 9]);
  assert.deepEqual([...snapshot.gaps[0]], [0, 0, 1]);
  assert.deepEqual([...snapshot.variation[0]], [2, 0, 5]);
  assert.deepEqual(source, before, "snapshot normalization and transfer must not alter live accumulators");
  snapshot.channelIndices[0] = 99;
  assert.deepEqual(source.channelIndices, [7]);
});

test("overview publisher throttles growing prefixes but immediately publishes the finished window once", () => {
  let now = 0;
  const snapshots = [];
  const publish = createProgressiveEnvelopePublisher(liveWindow(), 500, (window) => snapshots.push(window), () => now);
  publish(1);
  now = 100;
  publish(2);
  assert.equal(snapshots.length, 1);
  now = 500;
  publish(2);
  publish(2);
  assert.equal(snapshots.length, 2);
  now = 501;
  publish(3);
  publish(4);
  publish(4);
  assert.deepEqual(snapshots.map((window) => window.data[0].length), [1, 2, 4]);
});

test("overview publication is opt-in and consumer errors do not corrupt construction", () => {
  let calls = 0;
  createProgressiveEnvelopePublisher(liveWindow(), undefined, () => calls++)(4);
  assert.equal(calls, 0);
  assert.doesNotThrow(() => createProgressiveEnvelopePublisher(liveWindow(), 500, () => {
    throw new Error("Preview is no longer mounted");
  })(1));
  for (const interval of [0, -1, NaN, Infinity]) {
    assert.throws(() => createProgressiveEnvelopePublisher(liveWindow(), interval, () => {}), /positive and finite/);
  }
});

test("DAT and EDF worker clients forward previews and ignore messages after abort", async (context) => {
  const workers = [];
  class WorkerDouble {
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(message) { this.request = message; }
    terminate() { this.terminated = true; }
    emit(message) { this.onmessage({ data: { requestId: this.request.requestId, ...message } }); }
  }
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: WorkerDouble });
  context.after(() => {
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else delete globalThis.Worker;
  });
  for (const build of [buildRawDatEnvelopeWindowOffThread, buildEDFEnvelopeWindowOffThread]) {
    const controller = new AbortController();
    const snapshots = [];
    const result = build({ overviewIntervalMs: 500 }, {
      signal: controller.signal,
      onOverview: (window) => snapshots.push(window),
      fallbackToMainThread: false,
    });
    const worker = workers.at(-1);
    const window = liveWindow();
    worker.emit({ type: "overview", window });
    assert.deepEqual(snapshots, [window]);
    controller.abort();
    await assert.rejects(result, { name: "AbortError" });
    assert.equal(worker.terminated, true);
    worker.emit({ type: "overview", window: liveWindow() });
    assert.equal(snapshots.length, 1, "late queued previews must not restore a cancelled source");
  }
});
