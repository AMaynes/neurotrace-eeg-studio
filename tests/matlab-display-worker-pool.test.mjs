import assert from 'node:assert/strict';
import test from 'node:test';
import { createMatlabDisplayWorkerPool, matlabDisplayWorkerCount } from '../app/matlab-display-worker-pool.ts';
import { filterMatlabDisplayTrace } from '../app/matlab-display-processing.ts';
import { BrowserWorker } from './fixtures/browser-worker.mjs';

test('parallel workers retain bit-exact filtering and channel order', async () => {
  const original = globalThis.Worker; const workers = [];
  globalThis.Worker = class extends BrowserWorker { constructor(url) { super(url); workers.push(this); } };
  const pool = createMatlabDisplayWorkerPool({ channelCount: 33, workerCount: 4, fallbackToMainThread: false });
  try {
    const channels = Array.from({ length: 33 }, (_, c) => ({ data: Float64Array.from({ length: 701 }, (_, i) => Math.sin(i * .17 + c) * 100),
      options: { factor: 2, inputSampleCount: 701 } }));
    const expected = channels.map(c => filterMatlabDisplayTrace(c.data, 2));
    assert.deepEqual(await pool.process(channels), expected);
    assert.deepEqual(await pool.process(channels.slice(0, 2)), expected.slice(0, 2));
    assert.equal(workers.length, 4);
  } finally { pool.close(); globalThis.Worker = original; }
  assert.ok(workers.every(w => w.stopped));
});

test('worker count leaves CPU capacity and has a hard limit', () => {
  assert.equal(matlabDisplayWorkerCount(200, 32), 4);
  assert.equal(matlabDisplayWorkerCount(200, 4), 2);
  assert.equal(matlabDisplayWorkerCount(3, 32), 1);
  assert.equal(matlabDisplayWorkerCount(200, NaN), 1);
  assert.throws(() => createMatlabDisplayWorkerPool({ channelCount: 2, workerCount: NaN }), /positive integer/);
});

test('abort rejects queued batches and closes every worker', async () => {
  const original = globalThis.Worker, workers = [], controller = new AbortController();
  globalThis.Worker = class { constructor() { workers.push(this); } postMessage() {} terminate() { this.stopped = true; } };
  try {
    const pool = createMatlabDisplayWorkerPool({ channelCount: 32, workerCount: 4, signal: controller.signal, fallbackToMainThread: false });
    const pending = pool.process(Array.from({ length: 32 }, () => ({ data: new Float64Array(4), options: { factor: 1, inputSampleCount: 4 } })));
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.ok(workers.every(w => w.stopped));
  } finally { globalThis.Worker = original; }
});

test('partial pool construction failure releases already-created workers', () => {
  const original = globalThis.Worker, workers = [];
  globalThis.Worker = class {
    constructor() { if (workers.length === 2) throw new Error('worker unavailable'); workers.push(this); }
    terminate() { this.stopped = true; }
  };
  try {
    assert.throws(() => createMatlabDisplayWorkerPool({ channelCount: 32, workerCount: 4, fallbackToMainThread: false }), /unavailable/);
    assert.ok(workers.every(w => w.stopped));
  } finally { globalThis.Worker = original; }
});
