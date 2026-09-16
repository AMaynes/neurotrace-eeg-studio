/**
 * Plans incremental overview reads on a fixed, whole-source-frame bucket grid.
 * Only complete adjacent buckets are reused: no interpolation, rebinning, or
 * fabricated samples. Callers own channel selection, cancellation, and caching.
 */

import type { EnvelopeWindowData } from "./eeg-core";

export interface EnvelopeReadPlan {
  startSec: number;
  durationSec: number;
  bucketCount: number;
}

export interface AlignedEnvelopeRequest {
  startSec: number;
  endSec: number;
  bucketCount: number;
  sampleRate: number;
  recordingDurationSec: number;
  maxBucketCount?: number;
  /** Optional display-resolution ceiling when a finer planned grid exceeds the cache cap. */
  maximumBucketDurationSec?: number;
}

export interface EnvelopeExtensionRequest {
  /** Caller must first establish that this base contains the requested channels. */
  base: EnvelopeWindowData;
  startSec: number;
  endSec: number;
  requiredBucketDurationSec: number;
  sampleRate: number;
  recordingDurationSec: number;
  /** Budget for the finest level alone; reserve separate space for its pyramid. */
  maxBaseBytes: number;
}

export interface EnvelopeExtensionPlan extends EnvelopeReadPlan {
  /** Unchanged cached buckets, possibly cropped to bound retained coverage. */
  base: EnvelopeWindowData;
  /** Missing left and/or right intervals, in time order, on the base grid. */
  missing: EnvelopeReadPlan[];
}

/**
 * Recognizes complete whole-frame buckets despite floating-point second/frame
 * conversion. Decoders can then use integer division, making a split read give
 * every boundary sample the same bucket as a full read. Fractional grids return
 * null and keep their original decoding behavior.
 */
export function exactEnvelopeFrameGrid(
  startSec: number,
  durationSec: number,
  bucketCount: number,
  sampleRate: number,
): { startFrame: number; endFrame: number; framesPerBucket: number } | null {
  if (!Number.isFinite(startSec) || startSec < 0 || !Number.isFinite(durationSec) || durationSec <= 0
    || !Number.isFinite(sampleRate) || sampleRate <= 0 || !positiveInteger(bucketCount)) return null;
  const startFrame = integerFrame(startSec * sampleRate);
  // Subtraction at a large recording offset can lose a few ulps even when both
  // endpoints were integral frames. Judge duration against that endpoint scale.
  const durationFrames = integerFrame(durationSec * sampleRate, (startSec + durationSec) * sampleRate);
  if (startFrame === null || durationFrames === null || durationFrames <= 0
    || durationFrames % bucketCount !== 0 || !Number.isSafeInteger(startFrame + durationFrames)) return null;
  return { startFrame, endFrame: startFrame + durationFrames, framesPerBucket: durationFrames / bucketCount };
}

/**
 * Aligns an initial overview to recording frames without reducing resolution.
 * If an explicit display-resolution ceiling is supplied, an over-budget grid
 * may use wider whole-frame buckets that still satisfy that display ceiling.
 * A partial last bucket at EOF or excessive output size declines this optional
 * optimization; callers retain their existing full-window read in that case.
 */
export function planAlignedEnvelopeRequest(request: AlignedEnvelopeRequest): EnvelopeReadPlan | null {
  const { sampleRate, startSec, endSec, bucketCount } = request;
  const totalFrames = recordingFrames(request.recordingDurationSec, sampleRate);
  const maximumBuckets = request.maxBucketCount ?? Number.MAX_SAFE_INTEGER;
  const maximumBucketDuration = request.maximumBucketDurationSec;
  if (totalFrames === null || !validRange(startSec, endSec, request.recordingDurationSec)
    || !positiveInteger(bucketCount) || !positiveInteger(maximumBuckets)
    || (maximumBucketDuration !== undefined
      && (!Number.isFinite(maximumBucketDuration) || maximumBucketDuration <= 0))) return null;
  const framesPerBucket = Math.max(1, Math.floor((endSec - startSec) * sampleRate / bucketCount));
  const firstRequestedFrame = nearInteger(startSec * sampleRate);
  const lastRequestedFrame = nearInteger(endSec * sampleRate);
  const alignedBounds = (width: number) => ({
    start: Math.floor(firstRequestedFrame / width) * width,
    end: Math.ceil(lastRequestedFrame / width) * width,
  });
  const initial = alignedBounds(framesPerBucket);
  const alignedBuckets = (initial.end - initial.start) / framesPerBucket;
  if (initial.end > totalFrames || !positiveInteger(alignedBuckets)) return null;
  if (alignedBuckets <= maximumBuckets) {
    if (maximumBucketDuration !== undefined && framesPerBucket / sampleRate > maximumBucketDuration) return null;
    return readPlan(initial.start, initial.end, framesPerBucket, sampleRate);
  }
  if (maximumBucketDuration === undefined) return null;

  // Whole-frame rounding can add an edge bucket at a full cache cap. Try the
  // tight width first, then reserve one bin for both partially covered edges.
  // This is bounded arithmetic, not a search over potentially huge durations.
  const requestedFrames = lastRequestedFrame - firstRequestedFrame;
  const widths = [
    Math.max(framesPerBucket + 1, Math.ceil(requestedFrames / maximumBuckets)),
    Math.max(framesPerBucket + 1, maximumBuckets > 1
      ? Math.ceil(requestedFrames / (maximumBuckets - 1))
      : Math.ceil(lastRequestedFrame)),
  ];
  for (const width of widths) {
    if (!positiveInteger(width) || width / sampleRate > maximumBucketDuration) continue;
    const { start, end } = alignedBounds(width);
    const count = (end - start) / width;
    if (end <= totalFrames && positiveInteger(count) && count <= maximumBuckets) {
      return readPlan(start, end, width, sampleRate);
    }
  }
  return null;
}

/**
 * Reuses a substantially overlapping window and reads only newly exposed bins.
 * Coverage stays within two viewport widths and the caller's finest-level byte
 * budget. Irregular grids, finer zooms, incompatible EOF, or weak overlap fall
 * back to a normal read; the existing cache is never mutated.
 */
export function planEnvelopeExtension(request: EnvelopeExtensionRequest): EnvelopeExtensionPlan | null {
  const { base, sampleRate, startSec, endSec, requiredBucketDurationSec, maxBaseBytes } = request;
  const totalFrames = recordingFrames(request.recordingDurationSec, sampleRate);
  const count = envelopeBucketCount(base);
  const baseStartFrame = integerFrame(base.startSec * sampleRate);
  const framesPerBucket = integerFrame(base.bucketDurationSec * sampleRate);
  if (totalFrames === null || count === null || baseStartFrame === null
    || framesPerBucket === null || framesPerBucket <= 0 || baseStartFrame % framesPerBucket !== 0
    || !validRange(startSec, endSec, request.recordingDurationSec)
    || !Number.isFinite(requiredBucketDurationSec) || requiredBucketDurationSec <= 0
    || base.bucketDurationSec > requiredBucketDurationSec * 1.05
    || !Number.isFinite(maxBaseBytes) || maxBaseBytes <= 0) return null;
  const baseEndFrame = baseStartFrame + count * framesPerBucket;
  const requestedStartFrame = Math.floor(nearInteger(startSec * sampleRate) / framesPerBucket) * framesPerBucket;
  const requestedEndFrame = Math.ceil(nearInteger(endSec * sampleRate) / framesPerBucket) * framesPerBucket;
  if (!Number.isSafeInteger(baseEndFrame) || baseStartFrame < 0 || baseEndFrame > totalFrames
    || requestedEndFrame > totalFrames) return null;
  const requestedFrames = requestedEndFrame - requestedStartFrame;
  const overlap = Math.min(baseEndFrame, requestedEndFrame) - Math.max(baseStartFrame, requestedStartFrame);
  if (overlap <= 0 || overlap < requestedFrames / 2
    || (baseStartFrame <= requestedStartFrame && baseEndFrame >= requestedEndFrame)) return null;

  // Keep nearby history for small direction reversals, but never accumulate an
  // entire recording through repeated pans. Crop only on the original grid.
  const retainedMargin = Math.floor(requestedFrames / framesPerBucket / 2) * framesPerBucket;
  let retainedStartFrame = Math.max(baseStartFrame, requestedStartFrame - retainedMargin);
  let retainedEndFrame = Math.min(baseEndFrame, requestedEndFrame + retainedMargin);
  const bytesPerBucket = base.data.length * (base.variation ? 17 : 13);
  const maximumBuckets = Math.floor(maxBaseBytes / bytesPerBucket);
  const requestedBuckets = requestedFrames / framesPerBucket;
  if (!positiveInteger(requestedBuckets) || requestedBuckets > maximumBuckets) return null;

  // A full cache must still be able to pan: reserve room for the visible bins
  // first, then spend the remaining allowance on nearby history. Otherwise a
  // few extra retained bins would force a whole-window reread at the size cap.
  const extraBucketAllowance = maximumBuckets - requestedBuckets;
  const leftHistoryBuckets = Math.max(0, (requestedStartFrame - retainedStartFrame) / framesPerBucket);
  const rightHistoryBuckets = Math.max(0, (retainedEndFrame - requestedEndFrame) / framesPerBucket);
  if (leftHistoryBuckets + rightHistoryBuckets > extraBucketAllowance) {
    let keepLeft = Math.min(leftHistoryBuckets, Math.ceil(extraBucketAllowance / 2));
    const keepRight = Math.min(rightHistoryBuckets, extraBucketAllowance - keepLeft);
    keepLeft = Math.min(leftHistoryBuckets, extraBucketAllowance - keepRight);
    retainedStartFrame = Math.max(retainedStartFrame, requestedStartFrame - keepLeft * framesPerBucket);
    retainedEndFrame = Math.min(retainedEndFrame, requestedEndFrame + keepRight * framesPerBucket);
  }
  const combinedStartFrame = Math.min(retainedStartFrame, requestedStartFrame);
  const combinedEndFrame = Math.max(retainedEndFrame, requestedEndFrame);
  const combinedBuckets = (combinedEndFrame - combinedStartFrame) / framesPerBucket;
  if (!positiveInteger(combinedBuckets) || combinedBuckets * bytesPerBucket > maxBaseBytes) return null;

  const missing: EnvelopeReadPlan[] = [];
  if (requestedStartFrame < retainedStartFrame) {
    missing.push(readPlan(requestedStartFrame, retainedStartFrame, framesPerBucket, sampleRate));
  }
  if (requestedEndFrame > retainedEndFrame) {
    missing.push(readPlan(retainedEndFrame, requestedEndFrame, framesPerBucket, sampleRate));
  }
  const retainedBase = cropBuckets(base,
    (retainedStartFrame - baseStartFrame) / framesPerBucket,
    (retainedEndFrame - baseStartFrame) / framesPerBucket);
  return {
    ...readPlan(combinedStartFrame, combinedEndFrame, framesPerBucket, sampleRate),
    base: retainedBase,
    missing,
  };
}

/**
 * Concatenates complete adjacent envelopes without recalculating any values.
 * Mismatched channels, units, timing, array shapes, or variation availability
 * throw instead of leaving zero-filled holes that could resemble real signal.
 */
export function mergeAdjacentEnvelopeWindows(pieces: readonly EnvelopeWindowData[]): EnvelopeWindowData {
  if (!pieces.length) throw new Error("An envelope merge requires at least one complete window.");
  const ordered = [...pieces].sort((left, right) => left.startSec - right.startSec);
  const first = ordered[0];
  const counts = ordered.map((piece) => envelopeBucketCount(piece));
  if (counts.some((count) => count === null)) throw new Error("Envelope merge received inconsistent bucket metadata.");
  for (let index = 0; index < ordered.length; index += 1) {
    const piece = ordered[index];
    if (piece.channelIndices.length !== first.channelIndices.length
      || piece.channelIndices.some((value, position) => value !== first.channelIndices[position])
      || !sameStrings(piece.channelLabels, first.channelLabels)
      || !sameStrings(piece.channelUnits, first.channelUnits)
      || !sameNumbers(piece.sampleRates, first.sampleRates)
      || !nearlyEqual(piece.bucketDurationSec, first.bucketDurationSec)
      || Boolean(piece.variation) !== Boolean(first.variation)) {
      throw new Error("Envelope merge requires identical channels, units, and bucket resolution.");
    }
    if (index > 0) {
      const previous = ordered[index - 1];
      if (!nearlyEqual(piece.startSec, previous.startSec + previous.durationSec)) {
        throw new Error("Envelope merge requires adjacent windows without missing or overlapping buckets.");
      }
    }
  }
  if (ordered.length === 1) return first;
  const bucketCount = counts.reduce<number>((sum, count) => sum + (count ?? 0), 0);
  if (!positiveInteger(bucketCount)) throw new Error("Envelope merge bucket count exceeds the safe integer range.");
  const floats = (field: "data" | "minima" | "maxima" | "variation") => first.data.map((_, channel) => {
    const result = new Float32Array(bucketCount);
    let offset = 0;
    for (const piece of ordered) {
      const values = piece[field]![channel];
      result.set(values, offset);
      offset += values.length;
    }
    return result;
  });
  return {
    ...first,
    durationSec: bucketCount * first.bucketDurationSec,
    data: floats("data"),
    minima: floats("minima"),
    maxima: floats("maxima"),
    variation: first.variation ? floats("variation") : undefined,
    gaps: first.gaps.map((_, channel) => {
      const result = new Uint8Array(bucketCount);
      let offset = 0;
      for (const piece of ordered) {
        result.set(piece.gaps[channel], offset);
        offset += piece.gaps[channel].length;
      }
      return result;
    }),
  };
}

function readPlan(startFrame: number, endFrame: number, framesPerBucket: number, sampleRate: number): EnvelopeReadPlan {
  return {
    startSec: startFrame / sampleRate,
    durationSec: (endFrame - startFrame) / sampleRate,
    bucketCount: (endFrame - startFrame) / framesPerBucket,
  };
}

function cropBuckets(base: EnvelopeWindowData, first: number, end: number): EnvelopeWindowData {
  if (first === 0 && end === base.data[0].length) return base;
  const startSec = base.startSec + first * base.bucketDurationSec;
  return {
    ...base,
    startSec,
    durationSec: (end - first) * base.bucketDurationSec,
    channelStartSecs: base.channelStartSecs.map(() => startSec),
    // Planning may inspect several cache entries. Keep read-only views here;
    // the eventual merge performs the one owned copy for retained cache data.
    data: base.data.map((values) => values.subarray(first, end)),
    minima: base.minima.map((values) => values.subarray(first, end)),
    maxima: base.maxima.map((values) => values.subarray(first, end)),
    gaps: base.gaps.map((values) => values.subarray(first, end)),
    variation: base.variation?.map((values) => values.subarray(first, end)),
  };
}

function envelopeBucketCount(window: EnvelopeWindowData): number | null {
  const count = window.data[0]?.length;
  const channels = window.channelIndices.length;
  if (!positiveInteger(count) || channels === 0 || !(window.bucketDurationSec > 0)
    || !Number.isFinite(window.bucketDurationSec) || !Number.isFinite(window.startSec)
    || !nearlyEqual(window.durationSec, count * window.bucketDurationSec)
    || new Set(window.channelIndices).size !== channels
    || window.channelIndices.some((index) => !Number.isSafeInteger(index) || index < 0)) return null;
  const arrays = [window.data, window.minima, window.maxima, window.gaps];
  if (window.variation) arrays.push(window.variation);
  if (arrays.some((values) => values.length !== channels || values.some((row) => row.length !== count))
    || [window.sampleRates, window.channelStartSecs, window.channelLabels, window.channelUnits]
      .some((values) => values.length !== channels)
    || window.channelStartSecs.some((start) => !nearlyEqual(start, window.startSec))
    || window.sampleRates.some((rate) => !nearlyEqual(rate, 1 / window.bucketDurationSec))) return null;
  return count;
}

function recordingFrames(durationSec: number, sampleRate: number): number | null {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(durationSec) || durationSec <= 0) return null;
  const frames = integerFrame(durationSec * sampleRate);
  return frames !== null && frames > 0 ? frames : null;
}

function validRange(startSec: number, endSec: number, durationSec: number) {
  return Number.isFinite(startSec) && Number.isFinite(endSec)
    && startSec >= 0 && endSec > startSec && endSec <= durationSec;
}

function positiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function integerFrame(value: number, magnitude = value): number | null {
  const rounded = Math.round(value);
  const tolerance = Math.max(1, Math.abs(magnitude)) * Number.EPSILON * 32;
  return Number.isSafeInteger(rounded) && Math.abs(value - rounded) <= tolerance ? rounded : null;
}

function nearInteger(value: number) {
  return integerFrame(value) ?? value;
}

function nearlyEqual(left: number, right: number) {
  return Number.isFinite(left) && Number.isFinite(right)
    && Math.abs(left - right) <= Math.max(1, Math.abs(left), Math.abs(right)) * Number.EPSILON * 32;
}

function sameNumbers(left: readonly number[], right: readonly number[]) {
  return left.length === right.length && left.every((value, index) => nearlyEqual(value, right[index]));
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
