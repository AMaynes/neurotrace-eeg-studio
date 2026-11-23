/** Preserve fixed recording references; legacy callers can still request a visible-window center. */
import { robustTraceBaseline } from "./waveform-geometry.ts";

type TraceCenterWindow = {
  data: (Float32Array | Float64Array)[];
  traceBaselines: number[];
  recordingAnchored?: boolean;
  startSecs: number[];
  sampleRates: number[];
  envelopes: ({ startSec: number; bucketDurationSec: number; gaps: Uint8Array } | null)[];
  viewStart?: number;
  viewDuration?: number;
};

/**
 * Run once when a prepared window is published, never during canvas painting or
 * vertical scrolling. Recording-aligned references are authoritative and never
 * follow the viewport. Legacy reference helpers use the visible-row median.
 * Both the trace and its clipping ribbon use these same immutable offsets.
 */
export function centerDisplayWindow<T extends TraceCenterWindow>(display: T): T {
  // Recording-aligned builders supply fixed references; never replace them with a viewport median.
  if (display.recordingAnchored && display.traceBaselines.length === display.data.length && display.traceBaselines.every(Number.isFinite)) return display;
  const start = display.viewStart ?? Number.NaN;
  const end = start + (display.viewDuration ?? Number.NaN);
  const traceBaselines = display.data.map((values, row) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
    const envelope = display.envelopes[row];
    const dataStart = envelope?.startSec ?? display.startSecs[row];
    const interval = envelope?.bucketDurationSec ?? 1 / display.sampleRates[row];
    if (!Number.isFinite(dataStart) || !Number.isFinite(interval) || interval <= 0) return 0;
    // Include overlapping overview buckets, but not offscreen exact samples.
    const from = Math.max(0, envelope ? Math.floor((start - dataStart) / interval) : Math.ceil((start - dataStart) / interval - 1e-9));
    const to = Math.min(values.length, Math.ceil((end - dataStart) / interval - 1e-9));
    if (to <= from) return 0;
    const visible = values.subarray(from, to);
    return robustTraceBaseline(envelope ? visible.filter((_, index) => !envelope.gaps[from + index]) : visible);
  });
  return { ...display, traceBaselines };
}
