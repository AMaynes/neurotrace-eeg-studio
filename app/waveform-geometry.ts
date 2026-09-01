/**
 * Overview & Purpose
 * Provides deterministic, browser-independent measurements of the screen-space
 * geometry emitted by waveform canvas paths. These measurements make activity-
 * dependent rendering regressions testable without relying on wall-clock canvas
 * benchmarks, which vary substantially across browsers and GPU drivers.
 *
 * Architectural Relationships
 * Called by: waveform rendering policy and focused geometry regression tests.
 * Calls: no browser APIs; all inputs are caller-owned signal arrays.
 *
 * External Resources
 * None.
 */

export interface TraceGeometryProjection {
  widthPx: number;
  rowHeightPx: number;
  /** Signal value placed at the vertical center of the row. */
  baseline: number;
  /** Positive screen pixels per signal unit. */
  pixelsPerUnit: number;
}

export interface WaveformGeometrySummary {
  /** Finite points or vertical extrema strokes accepted by the path. */
  pointCount: number;
  /** Canvas moveTo calls needed to begin disconnected path runs. */
  moveCommands: number;
  /** Canvas lineTo calls emitted after moveTo. */
  lineCommands: number;
  /** Total absolute vertical travel after confinement to the channel row. */
  verticalTravelPx: number;
  /** Total Euclidean path/stroke length after confinement to the row. */
  strokeLengthPx: number;
  /** Longest single confined segment. */
  longestSegmentPx: number;
}

export interface WaveformGeometryBudget {
  maxCommands: number;
  maxStrokeLengthPx: number;
}

export type GroupedExtremaVisitor = (
  startIndex: number,
  endIndex: number,
  minimum: number,
  maximum: number,
  interrupted: boolean,
) => void;

function validateProjection(projection: TraceGeometryProjection) {
  if (!(projection.widthPx > 0) || !Number.isFinite(projection.widthPx)) {
    throw new Error("Waveform geometry width must be positive and finite.");
  }
  if (!(projection.rowHeightPx > 0) || !Number.isFinite(projection.rowHeightPx)) {
    throw new Error("Waveform geometry row height must be positive and finite.");
  }
  if (!Number.isFinite(projection.baseline)) {
    throw new Error("Waveform geometry baseline must be finite.");
  }
  if (!(projection.pixelsPerUnit > 0) || !Number.isFinite(projection.pixelsPerUnit)) {
    throw new Error("Waveform geometry scale must be positive and finite.");
  }
}

function confinedY(value: number, projection: TraceGeometryProjection) {
  const center = projection.rowHeightPx / 2;
  const projected = center - (value - projection.baseline) * projection.pixelsPerUnit;
  return Math.min(projection.rowHeightPx, Math.max(0, projected));
}

function emptySummary(): WaveformGeometrySummary {
  return {
    pointCount: 0,
    moveCommands: 0,
    lineCommands: 0,
    verticalTravelPx: 0,
    strokeLengthPx: 0,
    longestSegmentPx: 0,
  };
}

/**
 * Measures the direct raw-sample polyline used by the waveform canvas. The
 * result intentionally measures clipped screen geometry, not signal amplitude:
 * once a trace rails outside its row, additional amplitude cannot increase the
 * browser's raster work.
 */
export function measureRawTraceGeometry(
  values: ArrayLike<number>,
  projection: TraceGeometryProjection,
): WaveformGeometrySummary {
  validateProjection(projection);
  const summary = emptySummary();
  if (!values.length) return summary;

  const xStep = values.length > 1 ? projection.widthPx / (values.length - 1) : 0;
  let connected = false;
  let previousX = 0;
  let previousY = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) {
      connected = false;
      continue;
    }
    const x = index * xStep;
    const y = confinedY(value, projection);
    summary.pointCount += 1;
    if (!connected) {
      summary.moveCommands += 1;
      connected = true;
    } else {
      const horizontal = x - previousX;
      const vertical = Math.abs(y - previousY);
      const length = Math.hypot(horizontal, vertical);
      summary.lineCommands += 1;
      summary.verticalTravelPx += vertical;
      summary.strokeLengthPx += length;
      summary.longestSegmentPx = Math.max(summary.longestSegmentPx, length);
    }
    previousX = x;
    previousY = y;
  }
  return summary;
}

/**
 * Measures the two paths used for an exact-extrema overview: one independent
 * vertical min/max stroke per finite bucket and one connected midpoint trace.
 * `gaps` break the midpoint trace exactly as they do in the viewer.
 */
export function measureEnvelopeTraceGeometry(
  minima: ArrayLike<number>,
  maxima: ArrayLike<number>,
  midpoints: ArrayLike<number>,
  gaps: ArrayLike<number>,
  projection: TraceGeometryProjection,
): WaveformGeometrySummary {
  validateProjection(projection);
  const length = minima.length;
  if (maxima.length !== length || midpoints.length !== length || gaps.length !== length) {
    throw new Error("Waveform envelope geometry arrays must have equal lengths.");
  }
  const summary = emptySummary();
  if (!length) return summary;

  const xStep = length > 1 ? projection.widthPx / (length - 1) : 0;
  for (let index = 0; index < length; index += 1) {
    const minimum = minima[index];
    const maximum = maxima[index];
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) continue;
    const span = Math.abs(confinedY(minimum, projection) - confinedY(maximum, projection));
    summary.pointCount += 1;
    summary.moveCommands += 1;
    summary.lineCommands += 1;
    summary.verticalTravelPx += span;
    summary.strokeLengthPx += span;
    summary.longestSegmentPx = Math.max(summary.longestSegmentPx, span);
  }

  let connected = false;
  let previousX = 0;
  let previousY = 0;
  for (let index = 0; index < length; index += 1) {
    const value = midpoints[index];
    if (!Number.isFinite(value) || gaps[index]) {
      connected = false;
      continue;
    }
    const x = index * xStep;
    const y = confinedY(value, projection);
    summary.pointCount += 1;
    if (!connected) {
      summary.moveCommands += 1;
      connected = true;
    } else {
      const horizontal = x - previousX;
      const vertical = Math.abs(y - previousY);
      const segmentLength = Math.hypot(horizontal, vertical);
      summary.lineCommands += 1;
      summary.verticalTravelPx += vertical;
      summary.strokeLengthPx += segmentLength;
      summary.longestSegmentPx = Math.max(summary.longestSegmentPx, segmentLength);
    }
    previousX = x;
    previousY = y;
  }
  return summary;
}

/** A policy hook for renderers; kept separate so tests need no timing thresholds. */
export function waveformGeometryFitsBudget(
  geometry: WaveformGeometrySummary,
  budget: WaveformGeometryBudget,
) {
  if (!Number.isSafeInteger(budget.maxCommands) || budget.maxCommands < 0) {
    throw new Error("Waveform geometry command budget must be a non-negative whole number.");
  }
  if (!(budget.maxStrokeLengthPx >= 0) || !Number.isFinite(budget.maxStrokeLengthPx)) {
    throw new Error("Waveform geometry stroke-length budget must be finite and non-negative.");
  }
  return geometry.moveCommands + geometry.lineCommands <= budget.maxCommands
    && geometry.strokeLengthPx <= budget.maxStrokeLengthPx;
}

/**
 * Returns the deterministic grouping stride needed to bring a trace under its
 * command and screen-space stroke budgets. A renderer using the returned value
 * must preserve each group's finite minimum and maximum rather than simply
 * dropping samples; this keeps transients visible while bounding raster work.
 */
export function waveformGeometryGroupingStride(
  geometry: WaveformGeometrySummary,
  budget: WaveformGeometryBudget,
  maximumStride = 64,
) {
  // Reuse validation, including the zero-budget edge cases, without duplicating
  // the public contract in two policy functions.
  waveformGeometryFitsBudget(geometry, budget);
  if (!Number.isSafeInteger(maximumStride) || maximumStride < 1) {
    throw new Error("Waveform geometry maximum stride must be a positive whole number.");
  }
  const commandCount = geometry.moveCommands + geometry.lineCommands;
  const commandRatio = budget.maxCommands === 0
    ? (commandCount > 0 ? Number.POSITIVE_INFINITY : 1)
    : commandCount / budget.maxCommands;
  const strokeRatio = budget.maxStrokeLengthPx === 0
    ? (geometry.strokeLengthPx > 0 ? Number.POSITIVE_INFINITY : 1)
    : geometry.strokeLengthPx / budget.maxStrokeLengthPx;
  return Math.min(maximumStride, Math.max(1, Math.ceil(Math.max(commandRatio, strokeRatio))));
}

/**
 * Produces a hard path-complexity bound for an outlined exact-extrema fallback.
 * A group contributes at most two rectangles (ten path verbs). Raster area is
 * already bounded by the clipped row, so stroke length is only used when
 * deciding whether the original polyline needs this fallback.
 */
export function maximumExtremaGroupsForBudget(
  sourceCount: number,
  projection: TraceGeometryProjection,
  budget: WaveformGeometryBudget,
) {
  validateProjection(projection);
  waveformGeometryFitsBudget(emptySummary(), budget);
  if (!Number.isSafeInteger(sourceCount) || sourceCount < 0) {
    throw new Error("Waveform geometry source count must be a non-negative whole number.");
  }
  if (sourceCount === 0) return 0;
  const commandGroups = Math.floor(budget.maxCommands / 10);
  return Math.max(0, Math.min(sourceCount, commandGroups, Math.ceil(projection.widthPx)));
}

/**
 * Visits exact extrema groups in one source pass without allocating output
 * arrays or dropping the finite portion of a partially missing group.
 */
export function visitGroupedWaveformExtrema(
  minima: ArrayLike<number>,
  maxima: ArrayLike<number>,
  gaps: ArrayLike<number> | undefined,
  maximumGroups: number,
  visit: GroupedExtremaVisitor,
) {
  if (maxima.length !== minima.length || (gaps && gaps.length !== minima.length)) {
    throw new Error("Grouped waveform extrema arrays must have equal lengths.");
  }
  if (!Number.isSafeInteger(maximumGroups) || maximumGroups < 1) {
    throw new Error("Grouped waveform extrema count must be a positive whole number.");
  }
  if (!minima.length) return 0;
  const groupSize = Math.max(1, Math.ceil(minima.length / maximumGroups));
  let emittedGroups = 0;
  for (let groupStart = 0; groupStart < minima.length; groupStart += groupSize) {
    const groupEnd = Math.min(minima.length, groupStart + groupSize);
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    let interrupted = false;
    for (let index = groupStart; index < groupEnd; index += 1) {
      const candidateMinimum = minima[index];
      const candidateMaximum = maxima[index];
      if (gaps?.[index] || !Number.isFinite(candidateMinimum) || !Number.isFinite(candidateMaximum)) {
        interrupted = true;
        continue;
      }
      minimum = Math.min(minimum, candidateMinimum);
      maximum = Math.max(maximum, candidateMaximum);
    }
    if (minimum === Number.POSITIVE_INFINITY || maximum === Number.NEGATIVE_INFINITY) continue;
    visit(groupStart, groupEnd, minimum, maximum, interrupted);
    emittedGroups += 1;
  }
  return emittedGroups;
}

/**
 * Hours-wide EEG views are navigational overviews. Rendering one envelope
 * bucket per CSS pixel on a 4K display creates large typed-array churn without
 * adding clinically resolvable detail. The tiered cap keeps close views crisp
 * and makes minute/hour navigation independent of monitor width.
 */
export function waveformOverviewColumnBudget(durationSec: number, widthPx: number) {
  if (!(durationSec > 0) || !Number.isFinite(durationSec)) return 1;
  if (!(widthPx > 0) || !Number.isFinite(widthPx)) return 1;
  const maximumColumns = durationSec >= 60 * 60
    ? 512
    : durationSec >= 5 * 60
      ? 1_024
      : Math.floor(widthPx);
  return Math.max(1, Math.min(Math.floor(widthPx), maximumColumns));
}
