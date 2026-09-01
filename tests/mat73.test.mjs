/** Verifies deterministic MATLAB v7.3 dataset selection and worker wiring. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { chooseMat73SignalDataset } from "../app/mat73.ts";

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
