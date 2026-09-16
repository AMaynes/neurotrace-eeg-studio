/**
 * Separates an immediately useful wide-window preview from an overview whose
 * time resolution already satisfies the requested display. The caller owns
 * cache coverage, refinement, and cancellation; this policy never reads data.
 */

import { waveformOverviewColumnBudget } from "./waveform-geometry.ts";

const MINIMUM_ENVELOPE_WIDTH_PX = 64;
const MINIMUM_PREVIEW_DURATION_SEC = 60;

export interface RecordingOverviewDisplayRequest {
  recordingDurationSec: number;
  overviewBucketDurationSec: number;
  viewDurationSec: number;
  waveformWidthPx: number;
  /** Original sample rates of the currently enabled source channels. */
  sourceSampleRates: readonly number[];
  filtersEnabled: boolean;
  montage: string;
}

/**
 * "preview" requires a visible refining indication and a finer follow-up read.
 * "final" only describes sufficient time resolution: an incomplete index must
 * still show its unread portion as unknown. Close or sparse views, filters,
 * and derived montages never substitute this unfiltered recording overview.
 */
export type RecordingOverviewDisplayPolicy = "none" | "preview" | "final";

/**
 * Minute/hour windows may immediately show exact coarse extrema while finer
 * data loads. Requiring final resolution before showing anything would make
 * those windows wait for full-file verification and then reread their region.
 */
export function recordingOverviewDisplayPolicy({
  recordingDurationSec,
  overviewBucketDurationSec,
  viewDurationSec,
  waveformWidthPx,
  sourceSampleRates,
  filtersEnabled,
  montage,
}: RecordingOverviewDisplayRequest): RecordingOverviewDisplayPolicy {
  if (filtersEnabled || montage !== "referential"
    || ![recordingDurationSec, overviewBucketDurationSec, viewDurationSec, waveformWidthPx]
      .every((value) => Number.isFinite(value) && value > 0)
    || overviewBucketDurationSec > recordingDurationSec
    || waveformWidthPx < MINIMUM_ENVELOPE_WIDTH_PX
    || !sourceSampleRates.length
    || !sourceSampleRates.every((rate) => Number.isFinite(rate) && rate > 0)
    || !sourceSampleRates.some((rate) => rate * viewDurationSec > Math.max(2, waveformWidthPx * 1.5))) {
    return "none";
  }

  const requiredBucketDurationSec = viewDurationSec
    / waveformOverviewColumnBudget(viewDurationSec, waveformWidthPx);
  if (viewDurationSec >= recordingDurationSec - 1e-9
    || overviewBucketDurationSec <= requiredBucketDurationSec * 1.05) {
    return "final";
  }

  return viewDurationSec >= MINIMUM_PREVIEW_DURATION_SEC ? "preview" : "none";
}
