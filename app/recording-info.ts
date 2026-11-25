/*
Purpose: Formats recording metadata and performance measurements without changing their values.
File Dependencies: app/eeg-core.ts.
*/


import type { RecordingMeta } from "./eeg-core.ts";

/** Formats the source clock in UTC without applying the browser timezone. */
export function formatSessionStart(date?: Date) {
  if (!date) return "Not provided";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} source clock`;
}

/** Formats finite byte counts using binary units and reports unavailable measurements explicitly. */
export function formatByteCount(bytes: number | null | undefined) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "Unavailable";
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

/** Formats positive byte throughput and shows an em dash when no rate is available. */
export function formatByteRate(bytesPerSecond: number | null | undefined) {
  if (bytesPerSecond === null || bytesPerSecond === undefined || !(bytesPerSecond > 0)) return "—";
  return `${formatByteCount(bytesPerSecond)}/s`;
}

/** Formats elapsed milliseconds with precision appropriate to the displayed duration. */
export function formatMetricDuration(durationMs: number | null | undefined) {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs)) return "Unavailable";
  if (durationMs < 1) return `${durationMs.toFixed(2)} ms`;
  if (durationMs < 1_000) return `${durationMs.toFixed(durationMs < 10 ? 1 : 0)} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(2)} s`;
  return `${(durationMs / 60_000).toFixed(1)} min`;
}

/** Describes the access strategy used by each supported recording format. */
export function sourceReadProfile(format: RecordingMeta["format"], hasRecording: boolean) {
  if (!hasRecording) {
    return {
      origin: "No recording loaded",
      access: "Waiting for a local file",
      detail: "Signal reads begin after an EDF, MAT, or MAT + DAT recording is selected.",
    };
  }
  if (format === "edf" || format === "edf+") {
    return {
      origin: "Local browser file",
      access: "Worker-indexed EDF record slices",
      detail: "A background task builds the full-session overview; finer uncached views read only bounded record slices.",
    };
  }
  if (format === "raw-int16-le") {
    return {
      origin: "Local browser file",
      access: "Worker-indexed DAT frame slices",
      detail: "A background task builds the full-session overview; finer uncached views read only bounded frame slices.",
    };
  }
  if (format === "mat-v5") {
    return {
      origin: "Local browser file",
      access: "Decoded signal matrix in memory",
      detail: "The selected MATLAB matrix is decoded once, then visible windows are read from browser memory.",
    };
  }
  if (format === "mat-v7.3") {
    return {
      origin: "Local browser file",
      access: "Worker-backed HDF5 dataset slices",
      detail: "The large MATLAB signal matrix stays on disk; only requested time and channel slices are decoded.",
    };
  }
  return {
    origin: "Generated in this browser",
    access: "Deterministic synthetic signal",
    detail: "Demo samples are generated for the requested window without reading a recording file.",
  };
}

/** Estimates retained MAT v5 sample storage from channel rates and recording duration. */
export function estimatedDecodedSourceBytes(meta: RecordingMeta) {
  if (meta.format !== "mat-v5") return 0;
  return meta.sampleRates.reduce((sum, sampleRate) => sum + Math.ceil(meta.durationSec * sampleRate) * Float32Array.BYTES_PER_ELEMENT, 0);
}
