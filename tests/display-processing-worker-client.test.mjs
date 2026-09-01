/** Fast-path behavior for clinical display processing worker dispatch. */

import assert from "node:assert/strict";
import test from "node:test";

import { processDisplaySignalsOffThread } from "../app/display-processing-worker-client.ts";

const FILTERS_OFF = {
  enabled: false,
  highPassHz: 0.5,
  lowPassHz: 70,
  notchHz: 60,
  zeroPhase: true,
};

test("factor-1 unfiltered windows bypass the worker without copying or detaching caller buffers", async () => {
  const previousWorker = globalThis.Worker;
  let workerConstructions = 0;
  globalThis.Worker = class {
    constructor() {
      workerConstructions += 1;
      throw new Error("worker must not start for a no-op request");
    }
  };

  try {
    const firstOwner = new Float32Array([99, 1, 2, 3, 88]);
    const secondOwner = new Float32Array([77, 4, 5, 6, 66]);
    const first = firstOwner.subarray(1, 4);
    const second = secondOwner.subarray(1, 4);
    const result = await processDisplaySignalsOffThread({
      data: [first, second],
      sampleRates: [200, 500],
      filters: FILTERS_OFF,
      pixelCount: 1,
      sourceStartSampleIndices: [101, 207],
    }, { fallbackToMainThread: false });

    assert.equal(workerConstructions, 0);
    assert.deepEqual(result.factors, [1, 1]);
    assert.deepEqual(result.sampleRates, [200, 500]);
    assert.deepEqual(result.outputStartSampleIndices, [101, 207]);
    assert.deepEqual(result.data.map((channel) => [...channel]), [[1, 2, 3], [4, 5, 6]]);
    assert.notStrictEqual(result.data[0], first, "result exposes a distinct typed-array view");
    assert.notStrictEqual(result.data[1], second, "result exposes a distinct typed-array view");
    assert.strictEqual(result.data[0].buffer, first.buffer, "factor-1 output remains zero-copy");
    assert.strictEqual(result.data[1].buffer, second.buffer, "factor-1 output remains zero-copy");
    assert.equal(result.data[0].byteOffset, first.byteOffset);
    assert.equal(result.data[1].byteOffset, second.byteOffset);
    assert.equal(first.buffer.byteLength, firstOwner.byteLength, "caller buffer was not detached");
    assert.equal(second.buffer.byteLength, secondOwner.byteLength, "caller buffer was not detached");
    assert.deepEqual([...firstOwner], [99, 1, 2, 3, 88]);
    assert.deepEqual([...secondOwner], [77, 4, 5, 6, 66]);
  } finally {
    if (previousWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = previousWorker;
  }
});

test("filtering or factor-2 clinical preparation still dispatches a worker", async () => {
  const previousWorker = globalThis.Worker;
  let workerConstructions = 0;
  globalThis.Worker = class {
    constructor() {
      workerConstructions += 1;
      throw new Error("expected worker construction sentinel");
    }
  };

  try {
    const lowRate = new Float32Array([1, 2, 3, 4]);
    await assert.rejects(
      processDisplaySignalsOffThread({
        data: [lowRate],
        sampleRates: [200],
        filters: { ...FILTERS_OFF, enabled: true },
        pixelCount: 2,
        sourceStartSampleIndices: [0],
      }, { fallbackToMainThread: false }),
      /worker construction sentinel/,
    );
    assert.equal(workerConstructions, 1);

    const highRate = new Float32Array([1, 2, 3, 4]);
    await assert.rejects(
      processDisplaySignalsOffThread({
        data: [highRate],
        sampleRates: [1_000],
        filters: FILTERS_OFF,
        pixelCount: 2,
        sourceStartSampleIndices: [2],
      }, { fallbackToMainThread: false }),
      /worker construction sentinel/,
    );
    assert.equal(workerConstructions, 2);
    assert.equal(highRate.buffer.byteLength, 16, "failed worker construction did not detach input");
  } finally {
    if (previousWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = previousWorker;
  }
});

test("no-op validation preserves factor-1 output start-index rules", async () => {
  await assert.rejects(
    processDisplaySignalsOffThread({
      data: [new Float32Array([1, 2])],
      sampleRates: [200],
      filters: FILTERS_OFF,
      pixelCount: 200,
      sourceStartSampleIndices: [-1],
    }),
    /source start sample index must be a non-negative safe integer/i,
  );
});
