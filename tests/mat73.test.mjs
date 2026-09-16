/** Verifies deterministic MATLAB v7.3 dataset selection and worker wiring. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { chooseMat73SignalDataset } from "../app/mat73.ts";
import { Mat73Source } from "../app/eeg-core.ts";
import { Mat73WorkerClient } from "../app/mat73-worker-client.ts";
import { RecordingOverviewCache } from "../app/recording-overview.ts";

test("selects the largest two-dimensional numeric dataset outside MATLAB internals", () => {
  const selected = chooseMat73SignalDataset([
    { path: "/#refs#/huge", shape: [10_000, 10_000], dtype: "<d", elementCount: 100_000_000 },
    { path: "/volume", shape: [100, 100, 100], dtype: "<d", elementCount: 1_000_000 },
    { path: "/Fs", shape: [1, 1], dtype: "<d", elementCount: 1 },
    { path: "/data", shape: [40_688_800, 20], dtype: "<d", elementCount: 813_776_000 },
  ]);

  assert.equal(selected?.path, "/data");
});

test("prefers a signal-like path when viable datasets have equal size", () => {
  const selected = chooseMat73SignalDataset([
    { path: "/other", shape: [200, 20], dtype: "<d", elementCount: 4_000 },
    { path: "/eeg", shape: [200, 20], dtype: "<d", elementCount: 4_000 },
  ]);

  assert.equal(selected?.path, "/eeg");
});

test("keeps large v7.3 files worker-backed instead of calling arrayBuffer", async () => {
  const [core, worker] = await Promise.all([
    readFile(new URL("../app/eeg-core.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/mat73-worker.ts", import.meta.url), "utf8"),
  ]);

  assert.match(core, /format:\s*"mat-v7\.3"/);
  assert.match(worker, /FS\.filesystems\.WORKERFS/);
  assert.match(worker, /dataset\.slice\(ranges\)/);
  assert.doesNotMatch(worker, /file\.arrayBuffer\(/);
  assert.match(core, /if \(await isMat73File\(file\)\) return Mat73Source\.create/);
});

test("MAT v7.3 envelope timing follows the bucket grid and is accepted by the recording overview cache", async (t) => {
  const requests = [];
  const metadata = {
    matrixPath: "/data", matrixShape: [3_600_000, 2], sampleAxis: 0,
    sampleCount: 3_600_000, channelCount: 2, sampleRate: 1000,
    sampleRateSource: "/Fs", channelLabels: ["A", "B"], warnings: [],
  };
  const client = {
    async readEnvelope(request) {
      requests.push(request);
      return {
        firstSample: request.firstSample,
        bucketDurationSec: request.durationSec / request.bucketCount,
        data: request.channelIndices.map(() => new Float32Array(request.bucketCount)),
        minima: request.channelIndices.map(() => new Float32Array(request.bucketCount).fill(-10)),
        maxima: request.channelIndices.map(() => new Float32Array(request.bucketCount).fill(10)),
        gaps: request.channelIndices.map(() => new Uint8Array(request.bucketCount)),
      };
    },
    async readWindow(firstSample, endSample, channelIndices) {
      return { firstSample, data: channelIndices.map(() => new Float32Array(endSample - firstSample)) };
    },
    close() {},
  };
  t.mock.method(Mat73WorkerClient, "create", async () => ({ client, metadata }));
  const source = await Mat73Source.create(new File(["synthetic"], "overview-v73.mat"));
  const whole = await source.getEnvelopeWindow(0, 3600, 2048);
  assert.deepEqual(whole.sampleRates, [2048 / 3600, 2048 / 3600]);
  assert.deepEqual(whole.channelStartSecs, [0, 0]);
  assert.equal(whole.bucketDurationSec, 3600 / 2048);
  const cache = new RecordingOverviewCache();
  assert.equal(cache.put(source, whole, { complete: true }), true,
    "source sample rates must not incorrectly describe a screen-resolution overview");
  assert.equal(cache.get(source).window, whole);

  const partial = await source.getEnvelopeWindow(.1255, 1.35, 9, [1]);
  assert.equal(requests.at(-1).firstSample, 125);
  assert.equal(requests.at(-1).startSec, .1255);
  assert.deepEqual(partial.channelStartSecs, [.1255], "bucket origin is the requested start, not the floored source frame");
  assert.equal(partial.sampleRates[0], 1 / partial.bucketDurationSec);
  const exact = await source.getWindow(.1255, .01, [1]);
  assert.deepEqual(exact.sampleRates, [1000], "exact samples retain their source rate");
  assert.deepEqual(exact.channelStartSecs, [.125], "exact samples retain their source frame origin");

  const empty = await source.getEnvelopeWindow(3600, 1, 9, [1]);
  assert.deepEqual(empty.sampleRates, [0]);
  assert.deepEqual(empty.channelStartSecs, [3600]);
});
