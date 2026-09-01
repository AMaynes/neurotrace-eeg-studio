/** Duration-based time-grid spacing shared by absolute and event-relative views. */

const NICE_INTERVAL_MULTIPLES = [1, 2, 2.5, 5, 10] as const;
const DEFAULT_TARGET_GRID_LINES = 24;
const DEFAULT_MINIMUM_LABEL_GAP_PX = 12;

export interface AdaptiveTimeGridOptions {
  /** Event-relative review keeps sample-friendly one-second ticks when close in. */
  candidateRelative?: boolean;
  /** Approximate maximum grid intervals across a wide viewport. Defaults to 24. */
  targetGridLines?: number;
}

export interface TimeGridLineBudgetOptions {
  /** Minimum clear space between adjacent labels. Defaults to 12 CSS pixels. */
  minimumLabelGapPx?: number;
  /** Upper bound retained for very wide viewports. Defaults to 24. */
  maximumGridLines?: number;
}

/**
 * Limits grid density using the label width reported by the canvas so time
 * labels remain distinct across viewport sizes and display pixel ratios.
 */
export function timeGridLineBudget(
  viewportWidthPx: number,
  labelWidthPx: number,
  options: TimeGridLineBudgetOptions = {},
) {
  const requestedMaximum = options.maximumGridLines ?? DEFAULT_TARGET_GRID_LINES;
  const maximumGridLines = Number.isFinite(requestedMaximum)
    ? Math.max(2, Math.floor(requestedMaximum))
    : DEFAULT_TARGET_GRID_LINES;
  if (!Number.isFinite(viewportWidthPx) || viewportWidthPx <= 0
    || !Number.isFinite(labelWidthPx) || labelWidthPx < 0) {
    return maximumGridLines;
  }

  const requestedGap = options.minimumLabelGapPx ?? DEFAULT_MINIMUM_LABEL_GAP_PX;
  const minimumLabelGapPx = Number.isFinite(requestedGap)
    ? Math.max(0, requestedGap)
    : DEFAULT_MINIMUM_LABEL_GAP_PX;
  const requiredSpacingPx = Math.max(1, labelWidthPx + minimumLabelGapPx);
  return Math.max(2, Math.min(maximumGridLines, Math.floor(viewportWidthPx / requiredSpacingPx)));
}

/**
 * Returns a deterministic interval based only on viewport duration, so callers
 * can anchor the resulting grid at zero or at a candidate onset without ticks
 * shifting during horizontal pans.
 */
export function adaptiveTimeGridInterval(
  durationSec: number,
  options: AdaptiveTimeGridOptions = {},
) {
  if (options.candidateRelative && durationSec > 0 && durationSec <= 30) return 1;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 1;

  const requestedTarget = options.targetGridLines ?? DEFAULT_TARGET_GRID_LINES;
  const targetGridLines = Number.isFinite(requestedTarget)
    ? Math.max(2, Math.floor(requestedTarget))
    : DEFAULT_TARGET_GRID_LINES;
  const roughInterval = Math.max(Number.EPSILON, durationSec / targetGridLines);
  const magnitude = 10 ** Math.floor(Math.log10(roughInterval));
  for (const multiple of NICE_INTERVAL_MULTIPLES) {
    const interval = multiple * magnitude;
    if (interval >= roughInterval) return interval;
  }
  return 10 * magnitude;
}
