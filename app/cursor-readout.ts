/** A cursor inspects the current display data, never a previously saved amplitude. */
export interface CursorDisplayData {
  data: readonly ArrayLike<number>[];
  envelopes: readonly ({
    minima: ArrayLike<number>;
    maxima: ArrayLike<number>;
    gaps: ArrayLike<number>;
    startSec: number;
    bucketDurationSec: number;
  } | null)[];
  sampleRates: readonly number[];
  sourceSampleRates: readonly number[];
  startSecs: readonly number[];
  units: readonly string[];
  unreadAfterSec?: number;
}

export type CursorReadout =
  | {
    kind: "sample";
    value: number;
    unit: string;
    sampleTimeSec: number;
    /** Index in this displayed row, whose first sample can start after time zero. */
    displaySampleIndex: number;
    /** Time-aligned source index; this does not imply an unfiltered/raw value. */
    sourceSampleIndex: number | null;
  }
  | {
    kind: "range";
    minimum: number;
    maximum: number;
    unit: string;
    startSec: number;
    endSec: number;
    bucketIndex: number;
  }
  | {
    kind: "unavailable";
    unit: string;
    reason: "invalid-position" | "no-data" | "invalid-timing" | "outside-data" | "missing-data";
  };

/** Correct only arithmetic roundoff near a grid boundary, not out-of-range cursors. */
function positionOnGrid(timeSec: number, startSec: number, rate: number) {
  const position = (timeSec - startSec) * rate;
  const nearest = Math.round(position);
  const tolerance = Math.min(1e-4, 8 * Number.EPSILON
    * Math.max(1, Math.abs(timeSec), Math.abs(startSec)) * rate);
  return Math.abs(position - nearest) <= tolerance ? nearest : position;
}

/**
 * Exact rows return the nearest available sample and its actual timestamp.
 * Envelope rows return the bucket's extrema and half-open time interval: their
 * representative/averaged `data` values are never claimed as source samples.
 * Missing samples and out-of-range coordinates must not turn into zeroes or
 * copies of an edge sample. Call with the current display after every refresh.
 */
export function readCursorReadout(display: CursorDisplayData, row: number, timeSec: number): CursorReadout {
  const unit = display.units[row] || "a.u.";
  const unavailable = (reason: Extract<CursorReadout, { kind: "unavailable" }>["reason"]): CursorReadout => ({
    kind: "unavailable", unit, reason,
  });
  if (!Number.isInteger(row) || row < 0 || !Number.isFinite(timeSec) || timeSec < 0) {
    return unavailable("invalid-position");
  }
  const values = display.data[row];
  if (!values?.length) return unavailable("no-data");
  if (Number.isFinite(display.unreadAfterSec) && timeSec >= display.unreadAfterSec!) {
    return unavailable("missing-data");
  }

  const envelope = display.envelopes[row];
  if (envelope) {
    const { minima, maxima, gaps, startSec, bucketDurationSec } = envelope;
    if (!Number.isFinite(startSec) || !(bucketDurationSec > 0) || !Number.isFinite(bucketDurationSec)) {
      return unavailable("invalid-timing");
    }
    const bucketIndex = Math.floor(positionOnGrid(timeSec, startSec, 1 / bucketDurationSec));
    if (bucketIndex < 0 || bucketIndex >= values.length) return unavailable("outside-data");
    const minimum = minima[bucketIndex];
    const maximum = maxima[bucketIndex];
    if (bucketIndex >= gaps.length || gaps[bucketIndex]
      || !Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum > maximum) {
      return unavailable("missing-data");
    }
    const bucketStart = startSec + bucketIndex * bucketDurationSec;
    const bucketEnd = startSec + (bucketIndex + 1) * bucketDurationSec;
    return {
      kind: "range", minimum, maximum, unit, bucketIndex,
      startSec: bucketStart,
      endSec: Number.isFinite(display.unreadAfterSec) ? Math.min(bucketEnd, display.unreadAfterSec!) : bucketEnd,
    };
  }

  const sampleRate = display.sampleRates[row];
  const startSec = display.startSecs[row];
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate) || !Number.isFinite(startSec)) {
    return unavailable("invalid-timing");
  }
  const position = positionOnGrid(timeSec, startSec, sampleRate);
  const displaySampleIndex = Math.round(position);
  if (position < 0 || position >= values.length || displaySampleIndex >= values.length) {
    return unavailable("outside-data");
  }
  const value = values[displaySampleIndex];
  if (!Number.isFinite(value)) return unavailable("missing-data");
  const sampleTimeSec = startSec + displaySampleIndex / sampleRate;
  const sourceRate = display.sourceSampleRates[row];
  const sourcePosition = sourceRate > 0 && Number.isFinite(sourceRate)
    ? positionOnGrid(sampleTimeSec, 0, sourceRate)
    : Number.NaN;
  const sourceSampleIndex = Number.isSafeInteger(sourcePosition) && sourcePosition >= 0
    ? sourcePosition
    : null;
  return { kind: "sample", value, unit, sampleTimeSec, displaySampleIndex, sourceSampleIndex };
}
