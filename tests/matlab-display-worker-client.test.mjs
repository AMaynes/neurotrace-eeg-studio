import assert from "node:assert/strict";
import test from "node:test";
import { createMatlabDisplayWorkerClient } from "../app/matlab-display-worker-client.ts";
import { filterMatlabDisplayChunk } from "../app/matlab-display-processing.ts";

test("worker client reuses one worker and copies only bounded views without detaching cached owners", async () => {
  const original = globalThis.Worker;
  let created = 0, terminated = 0;
  const sent = [];
  globalThis.Worker = class {
    constructor() { created++; }
    terminate() { terminated++; }
    postMessage(request) {
      sent.push(request);
      queueMicrotask(() => this.onmessage({ data: { id: request.id, data: request.channels.map((c) => filterMatlabDisplayChunk(c.data, c.options)) } }));
    }
  };
  try {
    const client = createMatlabDisplayWorkerClient({ fallbackToMainThread: false });
    const owner = Float64Array.from({ length: 10000 }, (_, i) => i);
    const view = owner.subarray(5000, 5010);
    for (let i = 0; i < 2; i++) {
      const result = await client.process([{ data: view, options: { factor: 1, inputSampleCount: 10 } }]);
      assert.deepEqual(result[0], view);
    }
    assert.equal(created, 1);
    assert.equal(sent[0].channels[0].data.buffer.byteLength, 80);
    assert.notStrictEqual(sent[0].channels[0].data.buffer, owner.buffer);
    assert.equal(owner.byteLength, 80000);
    client.close();
    assert.equal(terminated, 1);
    await assert.rejects(client.process([]), { name: "AbortError" });
  } finally {
    if (original === undefined) delete globalThis.Worker;
    else globalThis.Worker = original;
  }
});

test("abort terminates pending worker processing", async () => {
  const original = globalThis.Worker;
  let terminated = false;
  globalThis.Worker = class { postMessage() {} terminate() { terminated = true; } };
  try {
    const controller = new AbortController();
    const client = createMatlabDisplayWorkerClient({ signal: controller.signal, fallbackToMainThread: false });
    const pending = client.process([{ data: new Float32Array(1), options: { factor: 1, inputSampleCount: 1 } }]);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(terminated, true);
  } finally {
    if (original === undefined) delete globalThis.Worker;
    else globalThis.Worker = original;
  }
});

test("worker deserialization failure rejects pending work instead of leaving a permanent loader", async () => {
  const original = globalThis.Worker;
  let terminated = false;
  globalThis.Worker = class {
    postMessage() { queueMicrotask(() => this.onmessageerror()); }
    terminate() { terminated = true; }
  };
  try {
    const client = createMatlabDisplayWorkerClient({ fallbackToMainThread: false });
    await assert.rejects(client.process([{ data: new Float32Array(1), options: { factor: 1, inputSampleCount: 1 } }]), /deserialize/);
    assert.equal(terminated, true);
  } finally {
    if (original === undefined) delete globalThis.Worker;
    else globalThis.Worker = original;
  }
});
