/**
 * Focused coverage for the browser performance diagnostics collector.
 * Browser-only observers are injected so the suite stays deterministic in Node.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { PerformanceDiagnosticsCollector } from "../app/performance-diagnostics.ts";

test("tracks source read progress, duration, throughput, and subscribers", () => {
  let now = 0;
  const collector = new PerformanceDiagnosticsCollector({
    autoStart: false,
    now: () => now,
    notificationIntervalMs: 0,
    readHeapMemory: () => null,
  });
  const updates = [];
  const unsubscribe = collector.subscribe((snapshot) => updates.push(snapshot));

  const read = collector.beginSourceRead({ label: "EDF overview", totalBytes: 100, phase: "Reading records" });
  now = 20;
  read.advance(40, "Reducing extrema");
  let snapshot = collector.snapshot();
  assert.equal(snapshot.sourceReads.bytes, 40);
  assert.equal(snapshot.sourceReads.activeOperations, 1);
  assert.equal(snapshot.activeOperations[0].label, "EDF overview");
  assert.equal(snapshot.activeOperations[0].phase, "Reducing extrema");
  assert.equal(snapshot.activeOperations[0].progress, .4);
  assert.equal(snapshot.activeOperations[0].throughputBytesPerSecond, 2_000);

  now = 50;
  assert.equal(read.finish({ completedBytes: 100, transientAllocatedBytes: 4_096 }), 50);
  read.advance(50);
  snapshot = collector.snapshot();
  assert.equal(snapshot.sourceReads.bytes, 100);
  assert.equal(snapshot.sourceReads.operationsStarted, 1);
  assert.equal(snapshot.sourceReads.operationsCompleted, 1);
  assert.equal(snapshot.sourceReads.activeOperations, 0);
  assert.equal(snapshot.sourceReads.durationMs, 50);
  assert.equal(snapshot.sourceReads.throughputBytesPerSecond, 2_000);
  assert.equal(snapshot.allocations.reportedTransientBytes, 4_096);
  assert.ok(updates.length >= 4);

  unsubscribe();
  collector.dispose();
});

test("tracks decode failures and async measurement helpers", async () => {
  let now = 10;
  const collector = new PerformanceDiagnosticsCollector({
    autoStart: false,
    now: () => now,
    notificationIntervalMs: 0,
    readHeapMemory: () => null,
  });

  const decode = collector.beginDecode({ totalBytes: 200 });
  decode.advance(50);
  now = 30;
  decode.fail();
  let snapshot = collector.snapshot();
  assert.equal(snapshot.decoding.bytes, 50);
  assert.equal(snapshot.decoding.operationsFailed, 1);
  assert.equal(snapshot.decoding.durationMs, 20);

  now = 40;
  const result = await collector.measureDecode({ totalBytes: 25 }, async (progress) => {
    progress.advance(25);
    now = 45;
    return "decoded";
  });
  assert.equal(result, "decoded");
  snapshot = collector.snapshot();
  assert.equal(snapshot.decoding.bytes, 75);
  assert.equal(snapshot.decoding.operationsCompleted, 1);
  assert.equal(snapshot.decoding.operationsStarted, 2);
  collector.dispose();
});

test("observes heap churn, long tasks, and garbage collection when supported", () => {
  let now = 0;
  const callbacks = new Map();
  let stoppedObservers = 0;
  const collector = new PerformanceDiagnosticsCollector({
    autoStart: false,
    now: () => now,
    eventLoopSampleIntervalMs: 0,
    notificationIntervalMs: 0,
    readHeapMemory: () => null,
    observeEntries: (entryType, callback) => {
      callbacks.set(entryType, callback);
      return () => { stoppedObservers += 1; };
    },
  });
  collector.start();
  collector.sampleHeapMemory({ usedBytes: 1_000, allocatedBytes: 2_000, limitBytes: 10_000 });
  collector.sampleHeapMemory({ usedBytes: 1_600, allocatedBytes: 2_500, limitBytes: 10_000 });
  collector.sampleHeapMemory({ usedBytes: 1_200, allocatedBytes: 2_500, limitBytes: 10_000 });
  collector.recordTransientAllocation(300);
  callbacks.get("longtask")([{ entryType: "longtask", startTime: 0, duration: 80 }]);
  callbacks.get("gc")([{ entryType: "gc", startTime: 90, duration: 6, detail: { kind: "major" } }]);
  now = 200;

  const snapshot = collector.snapshot();
  assert.deepEqual(snapshot.capabilities, {
    heapMemory: true,
    longTaskObserver: true,
    gcObserver: true,
    eventLoopProbe: false,
  });
  assert.equal(snapshot.allocations.observedHeapGrowthBytes, 600);
  assert.equal(snapshot.allocations.observedHeapReleaseBytes, 400);
  assert.equal(snapshot.allocations.reportedTransientBytes, 300);
  assert.equal(snapshot.allocations.currentHeapUsedBytes, 1_200);
  assert.equal(snapshot.allocations.currentHeapAllocatedBytes, 2_500);
  assert.equal(snapshot.allocations.heapLimitBytes, 10_000);
  assert.equal(snapshot.allocations.peakHeapUsedBytes, 1_600);
  assert.equal(snapshot.mainThread.longTaskCount, 1);
  assert.equal(snapshot.mainThread.longTaskDurationMs, 80);
  assert.equal(snapshot.mainThread.utilizationEstimate, .4);
  assert.equal(snapshot.garbageCollection.count, 1);
  assert.equal(snapshot.garbageCollection.durationMs, 6);
  assert.deepEqual(snapshot.garbageCollection.byKind, { major: 1 });

  collector.dispose();
  assert.equal(stoppedObservers, 2);
});

test("accounts for canvas surfaces, render timing, FPS, and dropped frames", () => {
  let now = 50;
  const collector = new PerformanceDiagnosticsCollector({
    autoStart: false,
    now: () => now,
    frameWindowMs: 2_000,
    targetFrameRate: 60,
    notificationIntervalMs: 0,
    readHeapMemory: () => null,
  });
  collector.recordCanvasSurface("waveform", { width: 100, height: 50 }, { gpuSurfaceCopies: 2 });
  collector.recordCanvasSurface("spectrogram", { width: 20, height: 10 }, { bytesPerPixel: 8, gpuSurfaceCopies: 1 });
  collector.recordRender(4);
  collector.recordRender(10);
  collector.recordFrame(0);
  collector.recordFrame(1000 / 60);
  collector.recordFrame(50);

  let snapshot = collector.snapshot();
  assert.equal(snapshot.canvases.count, 2);
  assert.equal(snapshot.canvases.backingBytes, 21_600);
  assert.equal(snapshot.canvases.estimatedGpuBytes, 41_600);
  assert.equal(snapshot.rendering.renders, 2);
  assert.equal(snapshot.rendering.averageDurationMs, 7);
  assert.equal(snapshot.rendering.longestDurationMs, 10);
  assert.ok(Math.abs(snapshot.rendering.rollingFps - 40) < 1e-9);
  assert.equal(snapshot.rendering.rollingDroppedFrames, 1);
  assert.equal(snapshot.rendering.totalDroppedFrames, 1);

  collector.removeCanvasSurface("spectrogram");
  now = 100;
  const render = collector.beginRender({ frame: true, frameTimestampMs: 100 });
  now = 106;
  assert.equal(render.finish(), 6);
  snapshot = collector.snapshot();
  assert.equal(snapshot.canvases.count, 1);
  assert.equal(snapshot.rendering.renders, 3);
  assert.equal(snapshot.rendering.lastDurationMs, 6);
  collector.dispose();
});

test("direct aggregate recording remains available for already-timed code", () => {
  const collector = new PerformanceDiagnosticsCollector({ autoStart: false, readHeapMemory: () => null });
  collector.recordSourceRead(8_000, 20);
  collector.recordDecode(4_000, 10);
  const snapshot = collector.snapshot();
  assert.equal(snapshot.sourceReads.throughputBytesPerSecond, 400_000);
  assert.equal(snapshot.decoding.throughputBytesPerSecond, 400_000);
  collector.dispose();
});

test("operation completion accepts exact worker timing separate from wall time", () => {
  let now = 0;
  const collector = new PerformanceDiagnosticsCollector({
    autoStart: false,
    now: () => now,
    readHeapMemory: () => null,
  });
  const read = collector.beginSourceRead({ totalBytes: 1_000 });
  now = 100;
  read.finish({ completedBytes: 1_000, durationMs: 4 });
  const snapshot = collector.snapshot();
  assert.equal(snapshot.sourceReads.durationMs, 4);
  assert.equal(snapshot.sourceReads.throughputBytesPerSecond, 250_000);
  collector.dispose();
});

test("live main-thread pressure uses a rolling window while retaining session totals", () => {
  let now = 0;
  const collector = new PerformanceDiagnosticsCollector({
    autoStart: false,
    now: () => now,
    eventLoopSampleIntervalMs: 0,
    mainThreadWindowMs: 10_000,
    readHeapMemory: () => null,
  });
  collector.start();
  collector.recordLongTask(100);
  now = 500;
  assert.equal(collector.snapshot().mainThread.utilizationEstimate, .2);
  now = 10_001;
  const settled = collector.snapshot();
  assert.equal(settled.mainThread.utilizationEstimate, 0);
  assert.equal(settled.mainThread.longTaskCount, 1);
  assert.equal(settled.mainThread.longTaskDurationMs, 100);
  collector.dispose();
});
