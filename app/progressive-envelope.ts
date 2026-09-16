/**
 * Publishes independent, exact prefixes while a sequential overview is built.
 * The source arrays remain owned by the builder; snapshots can be transferred
 * to the UI without detaching or exposing the live accumulation buffers.
 */

import type { EnvelopeWindowData } from "./eeg-core";

function defaultNowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Copies only completed buckets on the source's final grid. Unread future
 * buckets are absent, not represented by a zero value or an invented gap.
 */
function completedEnvelopePrefix(window: EnvelopeWindowData, bucketCount: number): EnvelopeWindowData {
  const data = window.data.map((channel) => channel.slice(0, bucketCount));
  const minima = window.minima.map((channel) => channel.slice(0, bucketCount));
  const maxima = window.maxima.map((channel) => channel.slice(0, bucketCount));
  const gaps = window.gaps.map((channel) => channel.slice(0, bucketCount));
  for (let channel = 0; channel < data.length; channel += 1) {
    for (let bucket = 0; bucket < bucketCount; bucket += 1) {
      if (minima[channel][bucket] === Number.POSITIVE_INFINITY
        || maxima[channel][bucket] === Number.NEGATIVE_INFINITY) {
        minima[channel][bucket] = Number.NaN;
        maxima[channel][bucket] = Number.NaN;
      }
      if (gaps[channel][bucket]) data[channel][bucket] = Number.NaN;
    }
  }
  return {
    ...window,
    data,
    minima,
    maxima,
    gaps,
    variation: window.variation?.map((channel) => channel.slice(0, bucketCount)),
    sampleRates: [...window.sampleRates],
    channelStartSecs: [...window.channelStartSecs],
    channelIndices: [...window.channelIndices],
    channelLabels: [...window.channelLabels],
    channelUnits: [...window.channelUnits],
    durationSec: bucketCount * window.bucketDurationSec,
  };
}

/**
 * Returns a throttled publisher for a builder's live arrays. Call it only with
 * the number of buckets complete for every selected channel; a partially
 * filled current bucket must not be published. Omit the interval to disable.
 * The first prefix and the completed window bypass the time throttle.
 */
export function createProgressiveEnvelopePublisher(
  window: EnvelopeWindowData,
  intervalMs: number | undefined,
  onOverview: ((window: EnvelopeWindowData) => void) | undefined,
  nowMs: () => number = defaultNowMs,
): (completedBucketCount: number) => void {
  if (intervalMs !== undefined && (!(intervalMs > 0) || !Number.isFinite(intervalMs))) {
    throw new RangeError("Overview publication interval must be positive and finite.");
  }
  const totalBuckets = window.data[0]?.length ?? 0;
  if (intervalMs === undefined || !onOverview || !totalBuckets) return () => {};
  let publishedBuckets = 0;
  let publishedAt = Number.NEGATIVE_INFINITY;
  return (completedBucketCount) => {
    const completed = Math.max(0, Math.min(totalBuckets, Math.floor(completedBucketCount)));
    if (!Number.isFinite(completed) || completed <= publishedBuckets) return;
    const timestamp = nowMs();
    if (completed < totalBuckets && timestamp - publishedAt < intervalMs) return;
    const snapshot = completedEnvelopePrefix(window, completed);
    publishedBuckets = completed;
    publishedAt = timestamp;
    try {
      onOverview(snapshot);
    } catch {
      // A preview consumer must not invalidate the exact final signal read.
    }
  };
}

/** Collects only independently owned snapshot buffers for a worker transfer. */
export function envelopeOverviewTransferList(window: EnvelopeWindowData): ArrayBuffer[] {
  return [...new Set([
    ...window.data,
    ...window.minima,
    ...window.maxima,
    ...window.gaps,
    ...(window.variation ?? []),
  ].map((channel) => channel.buffer as ArrayBuffer))];
}
