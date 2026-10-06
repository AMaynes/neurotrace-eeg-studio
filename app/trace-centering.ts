/** Manual, display-only channel centers. Never modifies samples or automatic baseline caches. */
import { robustTraceBaseline } from "./waveform-geometry.ts";

export type TraceCenters = Readonly<Record<string, number>>;

type TraceCenterWindow = {
  baselineSettingsKey?: string;
  data: (Float32Array | Float64Array)[];
  labels: string[];
  sourceIndices: number[][];
  units: string[];
  traceBaselines: number[];
  startSecs: number[];
  sampleRates: number[];
  envelopes: ({ startSec: number; bucketDurationSec: number; gaps: Uint8Array } | null)[];
};

/** Identity excludes time, gain, row position, and enabled-channel ordering. */
export function traceCenterKey(settingsKey: string, label: string, sourceIndices: number[], unit: string): string {
  return JSON.stringify([settingsKey, label, sourceIndices, unit]);
}

function rowKey(display: TraceCenterWindow, row: number): string | null {
  return display.baselineSettingsKey === undefined ? null : traceCenterKey(
    display.baselineSettingsKey, display.labels[row] ?? "", display.sourceIndices[row] ?? [], display.units[row] ?? "",
  );
}

/** One baseline for both the trace and its overflow ribbon; fallback remains stable while panning. */
export function displayedTraceCenter(display: TraceCenterWindow, row: number, centers: TraceCenters): number {
  const key = rowKey(display, row);
  return (key === null ? undefined : centers[key]) ?? display.traceBaselines[row] ?? robustTraceBaseline(display.data[row]);
}

/**
 * Estimate the visible median from already-prepared display samples (bucket means
 * in an overview). Ignore padding, gaps, and non-finite data. Immutable maps make
 * recentering reversible without saving sample arrays or changing the recording.
 */
export function recenteredTraceCenters(display: TraceCenterWindow, current: TraceCenters, start: number, duration: number): TraceCenters {
  if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) return current;
  let next: Record<string, number> | undefined;
  display.data.forEach((values, row) => {
    const key = rowKey(display, row);
    if (key === null) return;
    const envelope = display.envelopes[row];
    const dataStart = envelope?.startSec ?? display.startSecs[row];
    const interval = envelope?.bucketDurationSec ?? 1 / display.sampleRates[row];
    if (!Number.isFinite(dataStart) || !Number.isFinite(interval) || interval <= 0) return;
    // Overview buckets overlapping the viewport contribute their representative
    // means; exact traces contribute only samples inside [start, end).
    const from = Math.max(0, envelope ? Math.floor((start - dataStart) / interval) : Math.ceil((start - dataStart) / interval - 1e-9));
    const to = Math.min(values.length, Math.ceil((start + duration - dataStart) / interval - 1e-9));
    if (to <= from) return;
    let visible = values.subarray(from, to);
    if (envelope) visible = visible.filter((_, index) => !envelope.gaps[from + index]);
    if (!visible.some(Number.isFinite)) return;
    const center = robustTraceBaseline(visible);
    if (center === displayedTraceCenter(display, row, current)) return;
    next ??= { ...current };
    next[key] = center;
  });
  return next ?? current;
}

/** Compare values, not object identity, so redundant recentering preserves redo. */
export function sameTraceCenters(a: TraceCenters = {}, b: TraceCenters = {}): boolean {
  if (a === b) return true;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** Accept only finite centers under generated row identities from saved workspaces. */
export function normalizeTraceCenters(value: unknown): TraceCenters {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: [string, number][] = [];
  for (const [key, center] of Object.entries(value)) {
    if (entries.length >= 4096) break;
    if (key.length > 8192 || typeof center !== "number" || !Number.isFinite(center)) continue;
    try {
      const identity: unknown = JSON.parse(key);
      if (!Array.isArray(identity) || identity.length !== 4 || typeof identity[0] !== "string"
        || typeof identity[1] !== "string" || typeof identity[3] !== "string" || !Array.isArray(identity[2])
        || !identity[2].every((index: unknown) => typeof index === "number" && Number.isInteger(index) && index >= 0)) continue;
      entries.push([key, center]);
    } catch { /* Unknown row identities cannot affect rendering. */ }
  }
  return Object.fromEntries(entries);
}
