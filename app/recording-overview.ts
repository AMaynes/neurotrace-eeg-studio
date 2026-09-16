/**
 * Compact, all-channel recording overviews have a separate lifetime from the
 * detailed-window LRU. Zooming into a trace must never evict its whole-file
 * index. The caller owns background construction and must never mutate a
 * published snapshot; incomplete entries contain only the fully scanned prefix.
 * No recording data is persisted or sent to a remote service by this module.
 */

import type { EnvelopeWindowData, RecordingMeta, SignalSource } from "./eeg-core";

export const RECORDING_OVERVIEW_TARGET_BUCKETS = 2048;
export const RECORDING_OVERVIEW_ENTRY_BYTES = 16 * 1024 * 1024;
export const RECORDING_OVERVIEW_CACHE_BYTES = 64 * 1024 * 1024;
const ENVELOPE_BYTES_PER_BUCKET = 17;

export interface RecordingOverviewPlan {
  startSec: 0;
  durationSec: number;
  bucketCount: number;
  channelIndices: number[];
}

export interface RecordingOverviewEntry {
  /** Immutable after publication; incomplete entries contain no unread tail. */
  window: EnvelopeWindowData;
  totalDurationSec: number;
  complete: boolean;
  byteLength: number;
}

/**
 * Plans a single compact pass over every channel. Resolution is limited by the
 * entry budget rather than recording duration, so an hours-long file does not
 * allocate an hours-long raw signal. Invalid or impractically large channel
 * metadata declines the optional index instead of breaking ordinary loading.
 */
export function recordingOverviewPlan(meta: RecordingMeta): RecordingOverviewPlan | null {
  if (!validRecordingMeta(meta)) return null;
  const budgetBuckets = Math.floor(RECORDING_OVERVIEW_ENTRY_BYTES
    / (meta.channelCount * ENVELOPE_BYTES_PER_BUCKET));
  if (budgetBuckets < 1) return null;
  const maximumSourceRate = meta.sampleRates.reduce((highest, rate) => Math.max(highest, rate), 0);
  // More buckets than source samples would manufacture empty gaps in short or
  // low-rate recordings instead of adding useful overview resolution.
  const usefulBuckets = Math.max(1, Math.ceil(meta.durationSec * maximumSourceRate));
  return {
    startSec: 0,
    durationSec: meta.durationSec,
    bucketCount: Math.min(RECORDING_OVERVIEW_TARGET_BUCKETS, budgetBuckets, usefulBuckets),
    channelIndices: Array.from({ length: meta.channelCount }, (_, index) => index),
  };
}

/**
 * Source identity, not file name or import metadata, determines reuse. Entries
 * are bounded independently of detailed-window caches. The most recently used
 * source is protected while older recording indexes are evicted first.
 */
export class RecordingOverviewCache {
  private readonly entries = new Map<SignalSource, RecordingOverviewEntry>();
  private retainedBytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes = RECORDING_OVERVIEW_CACHE_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("Recording overview cache requires a positive byte budget.");
    }
    this.maxBytes = maxBytes;
  }

  get byteLength(): number { return this.retainedBytes; }
  get size(): number { return this.entries.size; }

  get(source: SignalSource): RecordingOverviewEntry | undefined {
    let entry = this.entries.get(source);
    if (entry) {
      const window = currentChannelLabels(source.meta, entry.window);
      if (window !== entry.window) entry = { ...entry, window };
      this.entries.delete(source);
      this.entries.set(source, entry);
    }
    return entry;
  }

  /**
   * Publishes only shape-checked all-channel prefixes or complete indexes.
   * A stale shorter prefix cannot replace newer coverage, and an incomplete
   * snapshot cannot replace a complete index. Rejection leaves the old cache
   * untouched; callers may continue ordinary loading after a false result.
   */
  put(source: SignalSource, window: EnvelopeWindowData, options: { complete: boolean }): boolean {
    const byteLength = validatedOverviewBytes(source.meta, window, options.complete);
    if (byteLength === null || byteLength > this.maxBytes) return false;
    const previous = this.entries.get(source);
    if (previous && ((!options.complete && previous.complete)
      || window.durationSec + timeTolerance(previous.window.durationSec) < previous.window.durationSec)) return false;

    if (previous) {
      this.retainedBytes -= previous.byteLength;
      this.entries.delete(source);
    }
    this.entries.set(source, {
      window: currentChannelLabels(source.meta, window),
      totalDurationSec: source.meta.durationSec,
      complete: options.complete,
      byteLength,
    });
    this.retainedBytes += byteLength;
    while (this.retainedBytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.retainedBytes -= oldest[1].byteLength;
    }
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.retainedBytes = 0;
  }
}

/** True only for scanned coverage, optionally at a requested display resolution. */
export function recordingOverviewCovers(
  entry: RecordingOverviewEntry,
  startSec: number,
  endSec: number,
  requiredBucketDurationSec?: number,
): boolean {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec) return false;
  if (requiredBucketDurationSec !== undefined
    && (!Number.isFinite(requiredBucketDurationSec) || requiredBucketDurationSec <= 0
      || entry.window.bucketDurationSec > requiredBucketDurationSec * 1.05)) return false;
  return startSec >= entry.window.startSec
    && endSec <= entry.window.startSec + entry.window.durationSec + timeTolerance(endSec);
}

/**
 * Crops on the original time grid and adds explicitly unknown bins for the
 * unread portion of an in-progress index. Only scanned values are copied;
 * there is no resampling or invented zero signal. Returned arrays are private
 * to the view, so drawing/preparation cannot mutate the published snapshot.
 */
export function recordingOverviewDisplayWindow(
  entry: RecordingOverviewEntry,
  startSec: number,
  durationSec: number,
  channelIndices: readonly number[],
): EnvelopeWindowData {
  if (!Number.isFinite(startSec) || startSec < 0 || startSec >= entry.totalDurationSec
    || !Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("Recording overview display requires a valid recording interval.");
  }
  const source = entry.window;
  const positions = new Map(source.channelIndices.map((channel, position) => [channel, position]));
  const seen = new Set<number>();
  const requestedPositions = channelIndices.map((channel) => {
    const position = positions.get(channel);
    if (position === undefined || seen.has(channel)) {
      throw new Error("Recording overview display requires unique indexed channels.");
    }
    seen.add(channel);
    return position;
  });
  const step = source.bucketDurationSec;
  const first = Math.max(0, Math.floor(startSec / step + 1e-9) - 1);
  const end = Math.min(
    Math.ceil(entry.totalDurationSec / step - 1e-9),
    Math.ceil(Math.min(entry.totalDurationSec, startSec + durationSec) / step - 1e-9) + 1,
  );
  const count = end - first;
  const alignedStart = first * step;
  const data: Float32Array[] = [];
  const minima: Float32Array[] = [];
  const maxima: Float32Array[] = [];
  const gaps: Uint8Array[] = [];
  const variation: Float32Array[] | undefined = source.variation ? [] : undefined;

  for (const position of requestedPositions) {
    const copyValues = (values: Float32Array) => {
      const output = new Float32Array(count).fill(Number.NaN);
      output.set(values.subarray(first, end));
      return output;
    };
    data.push(copyValues(source.data[position]));
    minima.push(copyValues(source.minima[position]));
    maxima.push(copyValues(source.maxima[position]));
    const channelGaps = new Uint8Array(count).fill(1);
    channelGaps.set(source.gaps[position].subarray(first, end));
    gaps.push(channelGaps);
    if (variation && source.variation) {
      const channelVariation = new Float32Array(count);
      channelVariation.set(source.variation[position].subarray(first, end));
      variation.push(channelVariation);
    }
  }
  return {
    startSec: alignedStart,
    durationSec: count * step,
    bucketDurationSec: step,
    channelIndices: [...channelIndices],
    channelLabels: requestedPositions.map((position) => source.channelLabels[position]),
    channelUnits: requestedPositions.map((position) => source.channelUnits[position]),
    channelStartSecs: requestedPositions.map(() => alignedStart),
    sampleRates: requestedPositions.map((position) => source.sampleRates[position]),
    data,
    minima,
    maxima,
    gaps,
    variation,
  };
}

/** Shape validation stays O(channels); raw signal values are not rescanned here. */
function validatedOverviewBytes(meta: RecordingMeta, window: EnvelopeWindowData, complete: boolean): number | null {
  if (!validRecordingMeta(meta) || typeof complete !== "boolean"
    || window.startSec !== 0 || !Number.isFinite(window.durationSec) || window.durationSec <= 0
    || window.durationSec > meta.durationSec + timeTolerance(meta.durationSec)
    || (complete && Math.abs(window.durationSec - meta.durationSec) > timeTolerance(meta.durationSec))
    || !Number.isFinite(window.bucketDurationSec) || window.bucketDurationSec <= 0) return null;
  const channels = meta.channelCount;
  const metadataArrays = [window.channelIndices, window.channelLabels, window.channelUnits,
    window.channelStartSecs, window.sampleRates];
  const sampleArrays = [window.data, window.minima, window.maxima, window.gaps];
  if (window.variation !== undefined) sampleArrays.push(window.variation);
  if (metadataArrays.some((array) => !Array.isArray(array) || array.length !== channels)
    || sampleArrays.some((array) => !Array.isArray(array) || array.length !== channels)) return null;
  const buckets = window.data[0]?.length;
  if (!Number.isSafeInteger(buckets) || buckets < 1
    || Math.abs(buckets * window.bucketDurationSec - window.durationSec) > timeTolerance(window.durationSec)) return null;

  // Count retained backing buffers rather than view lengths: a tiny subarray
  // of a large detail window must not silently pin that entire allocation.
  const retainedBuffers = new Set<ArrayBufferLike>();
  let bytes = 0;
  for (let channel = 0; channel < channels; channel += 1) {
    if (window.channelIndices[channel] !== channel
      || typeof window.channelLabels[channel] !== "string"
      || window.channelUnits[channel] !== meta.channelUnits[channel]
      || window.channelStartSecs[channel] !== 0
      || !Number.isFinite(window.sampleRates[channel])
      || Math.abs(window.sampleRates[channel] * window.bucketDurationSec - 1) > 1e-9) return null;
    for (const arrays of sampleArrays) {
      const values = arrays[channel];
      const expectedType = arrays === window.gaps ? Uint8Array : Float32Array;
      if (!(values instanceof expectedType) || values.length !== buckets) return null;
      if (!retainedBuffers.has(values.buffer)) {
        retainedBuffers.add(values.buffer);
        bytes += values.buffer.byteLength;
        if (bytes > RECORDING_OVERVIEW_ENTRY_BYTES) return null;
      }
    }
  }
  return bytes;
}

/**
 * BIDS sidecars may rename channels before or after a worker reads its original
 * header. Source indices are the identity; use current display names without
 * mutating the worker snapshot or touching physical units and signal arrays.
 */
function currentChannelLabels(meta: RecordingMeta, window: EnvelopeWindowData): EnvelopeWindowData {
  const labels = window.channelIndices.map((index) => meta.channelLabels[index]);
  if (labels.every((label, index) => label === window.channelLabels[index])) return window;
  return { ...window, channelLabels: labels };
}

function validRecordingMeta(meta: RecordingMeta): boolean {
  return Number.isFinite(meta.durationSec) && meta.durationSec > 0
    && Number.isSafeInteger(meta.channelCount) && meta.channelCount > 0
    && Array.isArray(meta.channelLabels) && meta.channelLabels.length === meta.channelCount
    && meta.channelLabels.every((label) => typeof label === "string")
    && Array.isArray(meta.channelUnits) && meta.channelUnits.length === meta.channelCount
    && meta.channelUnits.every((unit) => typeof unit === "string")
    && Array.isArray(meta.sampleRates) && meta.sampleRates.length === meta.channelCount
    && meta.sampleRates.every((rate) => Number.isFinite(rate) && rate > 0);
}

function timeTolerance(seconds: number): number {
  return Math.max(1, Math.abs(seconds)) * Number.EPSILON * 32;
}
