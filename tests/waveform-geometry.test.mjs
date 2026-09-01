/**
 * Overview & Purpose
 * Makes waveform rendering complexity deterministic. In particular, it proves
 * that equal-length traces can have radically different canvas raster work when
 * one signal oscillates rapidly, without relying on machine-specific timings.
 *
 * Architectural Relationships
 * Called by: Node's built-in test runner.
 * Calls: pure geometry measurements from app/waveform-geometry.ts.
 *
 * External Resources
 * None.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  maximumExtremaGroupsForBudget,
  measureEnvelopeTraceGeometry,
  measureRawTraceGeometry,
  waveformGeometryGroupingStride,
  waveformGeometryFitsBudget,
} from "../app/waveform-geometry.ts";

const projection = {
  widthPx: 2_048,
  rowHeightPx: 60,
  baseline: 0,
  pixelsPerUnit: 1,
};

test("detects activity-dependent raster work for equal-size raw traces", () => {
  // This matches the important shape of an 18 second, 200 Hz viewport: it is
  // below the viewer's former 1.5 samples/pixel direct-polyline cutoff.
  const sampleCount = 3_600;
  const quiet = new Float32Array(sampleCount);
  const busy = Float32Array.from({ length: sampleCount }, (_, index) => index % 2 ? -100 : 100);

  const quietGeometry = measureRawTraceGeometry(quiet, projection);
  const busyGeometry = measureRawTraceGeometry(busy, projection);

  assert.equal(quietGeometry.lineCommands, busyGeometry.lineCommands);
  assert.equal(quietGeometry.moveCommands, busyGeometry.moveCommands);
  assert.ok(Math.abs(quietGeometry.strokeLengthPx - projection.widthPx) < 1e-9);
  assert.ok(
    busyGeometry.strokeLengthPx > quietGeometry.strokeLengthPx * 100,
    "high-frequency content creates far more clipped canvas stroke work despite an identical sample count",
  );
  assert.ok(busyGeometry.verticalTravelPx <= busyGeometry.lineCommands * projection.rowHeightPx);
});

test("handles missing raw samples as bounded disconnected path runs", () => {
  const geometry = measureRawTraceGeometry(
    Float32Array.of(0, Number.NaN, Number.POSITIVE_INFINITY, -100, 100),
    { ...projection, widthPx: 40 },
  );

  assert.equal(geometry.pointCount, 3);
  assert.equal(geometry.moveCommands, 2);
  assert.equal(geometry.lineCommands, 1);
  assert.equal(geometry.verticalTravelPx, projection.rowHeightPx);
  assert.ok(Number.isFinite(geometry.strokeLengthPx));
});

test("measures exact-extrema vertical ink separately from midpoint geometry", () => {
  const bucketCount = 2_048;
  const quietMinima = new Float32Array(bucketCount).fill(-0.5);
  const quietMaxima = new Float32Array(bucketCount).fill(0.5);
  const quietMidpoints = new Float32Array(bucketCount);
  const busyMinima = new Float32Array(bucketCount).fill(-100);
  const busyMaxima = new Float32Array(bucketCount).fill(100);
  const busyMidpoints = Float32Array.from({ length: bucketCount }, (_, index) => index % 2 ? -100 : 100);
  const gaps = new Uint8Array(bucketCount);

  const quietGeometry = measureEnvelopeTraceGeometry(
    quietMinima,
    quietMaxima,
    quietMidpoints,
    gaps,
    projection,
  );
  const busyGeometry = measureEnvelopeTraceGeometry(
    busyMinima,
    busyMaxima,
    busyMidpoints,
    gaps,
    projection,
  );

  assert.equal(quietGeometry.moveCommands, busyGeometry.moveCommands);
  assert.equal(quietGeometry.lineCommands, busyGeometry.lineCommands);
  assert.ok(busyGeometry.strokeLengthPx > quietGeometry.strokeLengthPx * 40);
  assert.ok(
    busyGeometry.verticalTravelPx <= (bucketCount + bucketCount - 1) * projection.rowHeightPx,
    "clipping gives extrema plus midpoint paths a deterministic row-height bound",
  );
});

test("evaluates explicit command and stroke budgets without timing-flaky benchmarks", () => {
  const sampleCount = 3_600;
  const quietGeometry = measureRawTraceGeometry(new Float32Array(sampleCount), projection);
  const busyGeometry = measureRawTraceGeometry(
    Float32Array.from({ length: sampleCount }, (_, index) => index % 2 ? -100 : 100),
    projection,
  );
  const budget = {
    maxCommands: sampleCount,
    maxStrokeLengthPx: projection.widthPx * 12,
  };

  assert.equal(waveformGeometryFitsBudget(quietGeometry, budget), true);
  assert.equal(waveformGeometryFitsBudget(busyGeometry, budget), false);

  const oversizedQuietGeometry = measureRawTraceGeometry(new Float32Array(20_000), projection);
  assert.equal(
    waveformGeometryFitsBudget(oversizedQuietGeometry, budget),
    false,
    "a quiet trace can independently exceed the canvas command cap",
  );
  assert.equal(waveformGeometryGroupingStride(quietGeometry, budget), 1);
  assert.equal(waveformGeometryGroupingStride(busyGeometry, budget), 9);
});

test("hard-bounds exact-extrema fallback groups for any signal activity", () => {
  const budget = {
    maxCommands: 4_096,
    maxStrokeLengthPx: projection.widthPx * 12,
  };
  const groups = maximumExtremaGroupsForBudget(3_600, projection, budget);

  assert.equal(groups, Math.floor(budget.maxStrokeLengthPx / projection.rowHeightPx));
  assert.ok(groups * 2 <= budget.maxCommands);
  assert.ok(groups * projection.rowHeightPx <= budget.maxStrokeLengthPx);
  assert.equal(maximumExtremaGroupsForBudget(0, projection, budget), 0);
});

test("rejects invalid projections, mismatched envelopes, and invalid budgets", () => {
  assert.throws(
    () => measureRawTraceGeometry(Float32Array.of(1), { ...projection, rowHeightPx: 0 }),
    /row height/i,
  );
  assert.throws(
    () => measureEnvelopeTraceGeometry(
      Float32Array.of(0),
      Float32Array.of(1, 2),
      Float32Array.of(0),
      Uint8Array.of(0),
      projection,
    ),
    /equal lengths/i,
  );
  assert.throws(
    () => waveformGeometryFitsBudget(measureRawTraceGeometry(Float32Array.of(1), projection), {
      maxCommands: -1,
      maxStrokeLengthPx: 1,
    }),
    /command budget/i,
  );
  assert.throws(
    () => maximumExtremaGroupsForBudget(-1, projection, { maxCommands: 10, maxStrokeLengthPx: 10 }),
    /source count/i,
  );
  assert.throws(
    () => waveformGeometryGroupingStride(measureRawTraceGeometry(Float32Array.of(1), projection), {
      maxCommands: 10,
      maxStrokeLengthPx: 10,
    }, 0),
    /maximum stride/i,
  );
});
