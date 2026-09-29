/**
 * A truthful, bounded navigator summary of an already-cached raw overview.
 * Uses one named source channel so voltage and raw-count channels are never
 * combined. No source reads, filtering, decoding, or waveform mutation occurs.
 */
import type { RecordingOverviewEntry } from "./recording-overview.ts";
import { RECORDING_OVERVIEW_TARGET_BUCKETS } from "./recording-overview.ts";

export const MAX_SESSION_OVERVIEW_BARS = 256;
const DEFAULT_BAR_COUNT = 110;

export interface SessionOverviewBar {
  startSec: number;
  endSec: number;
  /** Raw maximum minus minimum over this bin; null means not fully known. */
  peakToPeak: number | null;
  /** Linear fraction of scaleMax, not a clinical sensitivity or seizure score. */
  heightFraction: number | null;
  state: "ready" | "partial" | "gap" | "unread";
}

export interface SessionOverview {
  bars: SessionOverviewBar[];
  status: "ready" | "partial" | "loading" | "unavailable";
  channelIndex: number | null;
  channelLabel: string | null;
  channelUnit: string | null;
  scaleMax: number | null;
  /** End of the indexed prefix, which can itself contain recording gaps. */
  coverageEndSec: number;
  coverageFraction: number;
  complete: boolean;
  description: string;
}

export interface SessionOverviewOptions {
  durationSec: number;
  /** Prefer an explicit source EEG channel; omission uses the first index channel. */
  channelIndex?: number;
  barCount?: number;
  /** Distinguishes an index still being built from one unavailable/evicted. */
  loading?: boolean;
}

/**
 * Consume at most the recording index's 2,048 buckets from one channel and
 * produce at most 256 bars. Each bar owns complete source buckets; callers
 * should use startSec/endSec for widths rather than stretching unequal bins.
 * Partial/unread/gapped bins stay neutral, never manufactured zero activity.
 */
export function buildSessionOverview(
  entry: RecordingOverviewEntry | undefined,
  { durationSec, channelIndex, barCount = DEFAULT_BAR_COUNT, loading = false }: SessionOverviewOptions,
): SessionOverview {
  const duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const requestedCount = Number.isFinite(barCount)
    ? Math.max(1, Math.min(MAX_SESSION_OVERVIEW_BARS, Math.floor(barCount)))
    : DEFAULT_BAR_COUNT;
  const result: SessionOverview = {
    bars: Array.from({ length: duration > 0 ? requestedCount : 0 }, (_, index) => ({
      startSec: duration * index / requestedCount,
      endSec: duration * (index + 1) / requestedCount,
      peakToPeak: null,
      heightFraction: null,
      state: "unread",
    })),
    status: loading ? "loading" : "unavailable",
    channelIndex: null,
    channelLabel: null,
    channelUnit: null,
    scaleMax: null,
    coverageEndSec: 0,
    coverageFraction: 0,
    complete: false,
    description: loading ? "Overview loading — unread intervals are blank." : "Overview unavailable — timeline navigation remains available.",
  };
  if (!entry || !duration) return result;
  const window = entry.window;
  const position = channelIndex === undefined ? 0 : window.channelIndices.indexOf(channelIndex);
  const step = window.bucketDurationSec;
  const tolerance = Math.max(1, duration) * Number.EPSILON * 64;
  if (position < 0 || position >= window.channelIndices.length
    || window.startSec !== 0 || !Number.isFinite(step) || step <= 0
    || !Number.isFinite(entry.totalDurationSec) || Math.abs(entry.totalDurationSec - duration) > tolerance
    || !Number.isFinite(window.durationSec) || window.durationSec <= 0 || window.durationSec > duration + tolerance) return result;

  const minima = window.minima[position];
  const maxima = window.maxima[position];
  const gaps = window.gaps[position];
  const sourceCount = minima?.length ?? 0;
  const fullCount = Math.ceil(duration / step - 1e-9);
  if (!sourceCount || !Number.isSafeInteger(fullCount) || fullCount < 1
    || fullCount > RECORDING_OVERVIEW_TARGET_BUCKETS || sourceCount > fullCount
    || maxima?.length !== sourceCount || gaps?.length !== sourceCount
    || Math.abs(sourceCount * step - window.durationSec) > tolerance) return result;

  const count = Math.min(requestedCount, fullCount);
  result.channelIndex = window.channelIndices[position];
  result.channelLabel = window.channelLabels[position];
  result.channelUnit = window.channelUnits[position];
  result.coverageEndSec = Math.min(duration, window.durationSec);
  result.coverageFraction = result.coverageEndSec / duration;
  result.complete = entry.complete && result.coverageEndSec >= duration - tolerance;
  result.bars = Array.from({ length: count }, (_, index) => {
    const first = Math.floor(index * fullCount / count);
    const end = Math.floor((index + 1) * fullCount / count);
    const bar: SessionOverviewBar = {
      startSec: first * step,
      endSec: Math.min(duration, end * step),
      peakToPeak: null,
      heightFraction: null,
      state: first >= sourceCount ? "unread" : end > sourceCount ? "partial" : "ready",
    };
    if (bar.state !== "ready") return bar;
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (let bucket = first; bucket < end; bucket += 1) {
      if (gaps[bucket] || !Number.isFinite(minima[bucket]) || !Number.isFinite(maxima[bucket])
        || minima[bucket] > maxima[bucket]) {
        bar.state = "gap";
        return bar;
      }
      minimum = Math.min(minimum, minima[bucket]);
      maximum = Math.max(maximum, maxima[bucket]);
    }
    bar.peakToPeak = maximum - minimum;
    return bar;
  });
  const known = result.bars.filter((bar) => bar.state === "ready");
  result.scaleMax = known.length ? Math.max(...known.map((bar) => bar.peakToPeak!)) : null;
  for (const bar of known) {
    bar.heightFraction = result.scaleMax! > 0 ? bar.peakToPeak! / result.scaleMax! : 0;
  }
  const missing = result.bars.some((bar) => bar.state !== "ready");
  result.status = result.complete ? known.length ? missing ? "partial" : "ready" : "unavailable" : "partial";
  const scale = result.scaleMax === null ? "no complete signal bins yet"
    : `scaled to ${Number(result.scaleMax.toPrecision(4))} ${result.channelUnit} maximum`;
  const progress = result.complete ? "" : ` ${Math.floor(result.coverageFraction * 100)}% indexed.`;
  result.description = `Raw peak-to-peak · ${result.channelLabel} · ${scale}.${progress}${missing ? " Unread or gapped intervals are blank." : ""}`;
  return result;
}
