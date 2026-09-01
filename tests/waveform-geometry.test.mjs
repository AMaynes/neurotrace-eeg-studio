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
  clippingExcessIntensity,
  clippingSeverityColor,
  envelopeWindowMatchesViewport,
  envelopeTraceRenderMode,
  estimateEnvelopeActivityRate,
  gaussianClippingHaloIntensity,
  maximumExtremaGroupsForBudget,
  measureEnvelopeTraceGeometry,
  measureRawTraceGeometry,
  waveformGeometryGroupingStride,
  waveformGeometryFitsBudget,
  waveformOverviewColumnBudget,
  visitGroupedWaveformExtrema,
} from "../app/waveform-geometry.ts";

test("estimates sustained activity without calling a lone spike high frequency", () => {
  assert.equal(estimateEnvelopeActivityRate(400, -10, 10, 10), 1);
  assert.equal(estimateEnvelopeActivityRate(40, -10, 10, 10), 0.1);
  assert.equal(estimateEnvelopeActivityRate(40, 2, 2, 10), 0);
  assert.equal(estimateEnvelopeActivityRate(Number.NaN, -10, 10, 10), 0);
});

test("fades clipped-voltage indicators symmetrically around an out-of-range peak", () => {
  const minima = new Float32Array(9).fill(-40);
  const maxima = new Float32Array(9).fill(40);
  maxima[4] = 140;
  const gaps = new Uint8Array(9);
  const intensity = (index) => gaussianClippingHaloIntensity(
    minima,
    maxima,
    gaps,
    index,
    -100,
    100,
    50,
    2,
  );

  assert.equal(intensity(4), 0.8);
  assert.equal(intensity(3), intensity(5));
  assert.equal(intensity(2), intensity(6));
  assert.ok(intensity(4) > intensity(3));
  assert.ok(intensity(3) > intensity(2));
  assert.ok(intensity(2) > 0, "the indicator begins before and trails after the clipped peak");
  gaps[3] = 1;
  assert.equal(intensity(3), 0, "missing data interrupts the visual halo");
  assert.equal(gaussianClippingHaloIntensity(minima, maxima, gaps, -1, -100, 100, 50), 0);
  assert.throws(
    () => gaussianClippingHaloIntensity(minima, new Float32Array(3), gaps, 0, -100, 100, 50),
    /equal lengths/i,
  );
});

test("normalizes clipping color from background green through lime and yellow to orange", () => {
  assert.equal(clippingSeverityColor(0), "rgba(7, 18, 22, 0.760)");
  assert.equal(clippingSeverityColor(.5), "rgba(87, 223, 103, 0.870)");
  assert.equal(clippingSeverityColor(.78), "rgba(242, 218, 65, 0.932)");
  assert.equal(clippingSeverityColor(1), "rgba(255, 126, 45, 0.980)");
  assert.equal(clippingSeverityColor(2), clippingSeverityColor(1));
  assert.equal(clippingSeverityColor(Number.NaN), clippingSeverityColor(0));
});

test("uses equal severity for the same distance above and below 100 microvolts", () => {
  const gaps = new Uint8Array(1);
  const above = gaussianClippingHaloIntensity([0], [150], gaps, 0, -100, 100, 200);
  const below = gaussianClippingHaloIntensity([-150], [0], gaps, 0, -100, 100, 200);
  assert.equal(above, .25);
  assert.equal(below, above);
  assert.equal(clippingExcessIntensity(-100, 100, -100, 100, 200), 0);
  assert.equal(clippingExcessIntensity(-300, 100, -100, 100, 200), 1);
  assert.equal(clippingExcessIntensity(-100, 300, -100, 100, 200), 1);
});

test("suppresses clipping halos until zoomed envelope coverage matches the viewport", () => {
  assert.equal(envelopeWindowMatchesViewport(10, 0.5, 20, 10, 10), true);
  assert.equal(envelopeWindowMatchesViewport(10 + 1e-8, 0.5, 20, 10, 10), true);
  assert.equal(envelopeWindowMatchesViewport(10, 0.5, 20, 12, 10), false, "a stale pan origin cannot seed the halo");
  assert.equal(envelopeWindowMatchesViewport(10, 0.5, 20, 10, 5), false, "a pre-zoom duration cannot seed the halo");
  assert.equal(envelopeWindowMatchesViewport(10, 0.5, 10, 10, 10), false, "a coarse partial envelope cannot seed the halo");
  assert.equal(envelopeWindowMatchesViewport(10, Number.NaN, 20, 10, 10), false);
});

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

test("keeps smooth overview traces continuous before grouping busy extrema", () => {
  const bucketCount = projection.widthPx;
  const quietMidpoints = Float32Array.from(
    { length: bucketCount },
    (_, index) => Math.sin(index / 80),
  );
  const quietMinima = Float32Array.from(quietMidpoints, (value) => value - .1);
  const quietMaxima = Float32Array.from(quietMidpoints, (value) => value + .1);
  const gaps = new Uint8Array(bucketCount);
  const budget = {
    maxCommands: Math.floor(projection.widthPx * 2.25),
    maxStrokeLengthPx: projection.widthPx * 4,
  };
  const quietDetailed = measureEnvelopeTraceGeometry(
    quietMinima,
    quietMaxima,
    quietMidpoints,
    gaps,
    projection,
  );
  const quietMidpoint = measureRawTraceGeometry(quietMidpoints, projection);

  assert.equal(waveformGeometryFitsBudget(quietDetailed, budget), false);
  assert.equal(waveformGeometryFitsBudget(quietMidpoint, budget), true);
  assert.equal(envelopeTraceRenderMode(quietDetailed, quietMidpoint, budget), "midpoint");

  const busyMidpoints = Float32Array.from(
    { length: bucketCount },
    (_, index) => index % 2 ? -100 : 100,
  );
  const busyDetailed = measureEnvelopeTraceGeometry(
    new Float32Array(bucketCount).fill(-100),
    new Float32Array(bucketCount).fill(100),
    busyMidpoints,
    gaps,
    projection,
  );
  const busyMidpoint = measureRawTraceGeometry(busyMidpoints, projection);

  assert.equal(envelopeTraceRenderMode(busyDetailed, busyMidpoint, budget), "grouped-extrema");

  const sparseDetailed = measureEnvelopeTraceGeometry(
    Float32Array.of(-1, -1),
    Float32Array.of(1, 1),
    Float32Array.of(0, 0),
    Uint8Array.of(0, 0),
    projection,
  );
  assert.equal(
    envelopeTraceRenderMode(sparseDetailed, measureRawTraceGeometry(Float32Array.of(0, 0), projection), budget),
    "detailed",
  );

  const clinicalBudget = {
    maxCommands: Math.floor(projection.widthPx * 3.25),
    maxStrokeLengthPx: projection.widthPx * 4,
  };
  assert.equal(
    envelopeTraceRenderMode(quietDetailed, quietMidpoint, clinicalBudget),
    "detailed",
    "one envelope bucket per pixel retains its exact extrema and continuous midpoint",
  );
  assert.equal(
    envelopeTraceRenderMode(busyDetailed, busyMidpoint, clinicalBudget),
    "grouped-extrema",
    "extra command headroom does not bypass the activity-dependent stroke budget",
  );
  const symmetricBusyDetailed = measureEnvelopeTraceGeometry(
    new Float32Array(bucketCount).fill(-100),
    new Float32Array(bucketCount).fill(100),
    new Float32Array(bucketCount),
    gaps,
    projection,
  );
  assert.equal(
    envelopeTraceRenderMode(
      symmetricBusyDetailed,
      measureRawTraceGeometry(new Float32Array(bucketCount), projection),
      clinicalBudget,
    ),
    "grouped-extrema",
    "a quiet midpoint cannot hide a high-activity exact envelope",
  );
});

test("hard-bounds exact-extrema fallback groups for any signal activity", () => {
  const budget = {
    maxCommands: 4_096,
    maxStrokeLengthPx: projection.widthPx * 12,
  };
  const groups = maximumExtremaGroupsForBudget(3_600, projection, budget);

  assert.equal(groups, Math.min(
    Math.floor(budget.maxCommands / 20),
    Math.ceil(projection.widthPx),
  ));
  assert.ok(groups * 20 <= budget.maxCommands);
  assert.ok(groups <= Math.ceil(projection.widthPx));
  assert.equal(maximumExtremaGroupsForBudget(0, projection, budget), 0);
});

test("caps overview columns aggressively for minute and hour-scale windows", () => {
  assert.equal(waveformOverviewColumnBudget(20, 3_712), 3_712);
  assert.equal(waveformOverviewColumnBudget(5 * 60, 3_712), 1_024);
  assert.equal(waveformOverviewColumnBudget(60 * 60, 3_712), 512);
  assert.equal(waveformOverviewColumnBudget(6 * 60 * 60, 3_712), 512);
  assert.equal(waveformOverviewColumnBudget(6 * 60 * 60, 320), 320);
  assert.equal(waveformOverviewColumnBudget(0, 3_712), 1);
  assert.equal(waveformOverviewColumnBudget(Number.NaN, 3_712), 1);
});

test("groups exact extrema once while preserving partial gaps", () => {
  const groups = [];
  const emitted = visitGroupedWaveformExtrema(
    Float32Array.of(3, 1, Number.NaN, Number.NaN, Number.NaN, Number.NaN),
    Float32Array.of(4, 7, Number.NaN, Number.NaN, Number.NaN, Number.NaN),
    Uint8Array.of(0, 0, 1, 1, 1, 1),
    2,
    (start, end, minimum, maximum, interrupted, representativeMean) => {
      groups.push({ start, end, minimum, maximum, interrupted, representativeMean });
    },
  );

  assert.equal(emitted, 1, "an all-gap group is omitted");
  assert.deepEqual(groups, [{
    start: 0,
    end: 3,
    minimum: 1,
    maximum: 7,
    interrupted: true,
    representativeMean: 3.75,
  }]);

  const constantGroups = [];
  visitGroupedWaveformExtrema(
    Float32Array.of(5, 5, 5, 5),
    Float32Array.of(5, 5, 5, 5),
    undefined,
    2,
    (start, end, minimum, maximum, interrupted, representativeMean) => {
      constantGroups.push({ start, end, minimum, maximum, interrupted, representativeMean });
    },
  );
  assert.deepEqual(constantGroups, [
    { start: 0, end: 2, minimum: 5, maximum: 5, interrupted: false, representativeMean: 5 },
    { start: 2, end: 4, minimum: 5, maximum: 5, interrupted: false, representativeMean: 5 },
  ]);

  const retainedGapExtrema = [];
  visitGroupedWaveformExtrema(
    Float32Array.of(-8, -3),
    Float32Array.of(9, 4),
    Uint8Array.of(1, 0),
    1,
    (start, end, minimum, maximum, interrupted, representativeMean) => {
      retainedGapExtrema.push({ start, end, minimum, maximum, interrupted, representativeMean });
    },
  );
  assert.deepEqual(retainedGapExtrema, [
    { start: 0, end: 2, minimum: -8, maximum: 9, interrupted: true, representativeMean: .5 },
  ], "a real gap breaks continuity without discarding its known extrema");
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
    () => visitGroupedWaveformExtrema(Float32Array.of(1), Float32Array.of(1, 2), undefined, 1, () => {}),
    /equal lengths/i,
  );
  assert.throws(
    () => waveformGeometryGroupingStride(measureRawTraceGeometry(Float32Array.of(1), projection), {
      maxCommands: 10,
      maxStrokeLengthPx: 10,
    }, 0),
    /maximum stride/i,
  );
});
