/** Duration-based time-grid spacing shared by absolute and event-relative views. */

const NICE_INTERVAL_MULTIPLES = [1, 2, 2.5, 5, 10] as const;

export interface AdaptiveTimeGridOptions {
  /** Event-relative review keeps sample-friendly one-second ticks when close in. */
  candidateRelative?: boolean;
  /** Approximate maximum grid intervals across a wide viewport. Defaults to 24. */
  targetGridLines?: number;
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

  const requestedTarget = options.targetGridLines ?? 24;
  const targetGridLines = Number.isFinite(requestedTarget)
    ? Math.max(2, Math.floor(requestedTarget))
    : 24;
  const roughInterval = Math.max(Number.EPSILON, durationSec / targetGridLines);
  const magnitude = 10 ** Math.floor(Math.log10(roughInterval));
  for (const multiple of NICE_INTERVAL_MULTIPLES) {
    const interval = multiple * magnitude;
    if (interval >= roughInterval) return interval;
  }
  return 10 * magnitude;
}
