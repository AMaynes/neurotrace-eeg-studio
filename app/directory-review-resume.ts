/** CSV-backed folder progress. Catalogs retain small rows, never decoded waveforms. */
import type { DirectoryImportPlan, DirectoryRecording } from "./directory-import.ts";
import { mergeMatlabAnnotationRows, parseMatlabAnnotations, type MatlabAnnotationRow } from "./matlab-annotations-csv.ts";

export type ReviewEvent = { timeSec: number; label: string };
export type ReviewMetadata = { events: ReviewEvent[]; sampleRate?: number; channelCount?: number; durationSec?: number; warnings: string[] };
type ResumeCache = { rows: MatlabAnnotationRow[]; byRecording: Map<string, MatlabAnnotationRow[]>; files: Set<File>; warnings: string[] };
const caches = new WeakMap<DirectoryImportPlan, ResumeCache>();
const pathIndexes = new WeakMap<DirectoryImportPlan, { paths: Map<string, DirectoryRecording[]>; names: Map<string, DirectoryRecording[]> }>();
export function directoryReviewCache(plan: DirectoryImportPlan): ResumeCache {
  let cache = caches.get(plan);
  if (!cache) { cache = { rows: [], byRecording: new Map(), files: new Set(), warnings: [] }; caches.set(plan, cache); }
  return cache;
}
export const isReviewCsv = (file: File) => /_annotations\.csv$/i.test(file.name);
export const isReviewEvent = (label: string) => /sz|seizure|seiz|tonic|eeg onset/i.test(label);
const path = (value: string | number) => String(value).trim().replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
function append<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const values = map.get(key);
  if (values) values.push(value); else map.set(key, [value]);
}

/** Require a full relative-path suffix, or a unique bare filename. Never guess between siblings. */
export function matchReviewRecording(plan: DirectoryImportPlan, row: MatlabAnnotationRow): DirectoryRecording | undefined {
  let index = pathIndexes.get(plan);
  if (!index) {
    index = { paths: new Map(), names: new Map() };
    for (const recording of plan.recordings) {
      const file = plan.format === "mat-dat" ? recording.files.find(file => /\.mat$/i.test(file.name)) : recording.primary;
      if (!file) continue;
      const relative = path(file.webkitRelativePath || file.name), name = relative.split("/").at(-1)!;
      append(index.paths, relative, recording);
      append(index.names, name, recording);
    }
    pathIndexes.set(plan, index);
  }
  const saved = path(row.mat_path || `${row.data_dir ? `${row.data_dir}/` : ""}${row.dat_file}.${plan.format === "edf" ? "edf" : "mat"}`);
  const matches: DirectoryRecording[] = [];
  const parts = saved.split("/");
  for (let offset = 0; offset < parts.length; offset++) matches.push(...(index.paths.get(parts.slice(offset).join("/")) ?? []));
  if (!saved.includes("/") && !matches.length) matches.push(...(index.names.get(saved) ?? []));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Include decisions made since the last CSV save when continuing within this visit. */
export function addDirectoryReviewRows(plan: DirectoryImportPlan, rows: MatlabAnnotationRow[]) {
  const cache = directoryReviewCache(plan);
  cache.rows = mergeMatlabAnnotationRows([], [...cache.rows, ...rows].sort((a, b) => String(a.review_timestamp).localeCompare(String(b.review_timestamp))));
  cache.byRecording = new Map();
  for (const row of cache.rows) {
    const recording = matchReviewRecording(plan, row);
    if (recording) append(cache.byRecording, recording.id, row);
  }
  return cache;
}

/** Invalid files do not erase previously loaded reviews. Newest review timestamps win across CSVs. */
export async function loadDirectoryReviewCsvs(plan: DirectoryImportPlan, files: readonly File[], signal?: AbortSignal) {
  const cache = directoryReviewCache(plan);
  for (const file of files) {
    signal?.throwIfAborted();
    if (cache.files.has(file)) continue;
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("CSV exceeds the 8 MiB review limit.");
      const rows = parseMatlabAnnotations(await file.text(), { acceptedOnly: true });
      signal?.throwIfAborted();
      if (cache.rows.length + rows.length > 100_000) throw new Error("More than 100,000 saved reviews; choose a smaller review collection.");
      addDirectoryReviewRows(plan, rows);
      cache.files.add(file);
    } catch (error) {
      signal?.throwIfAborted();
      cache.warnings.push(`${file.name}: ${error instanceof Error ? error.message : "Could not read saved reviews."}`);
    }
  }
  return cache;
}

/** Check acquisition identity and absolute/relative times before accepting CSV decisions. */
export function reviewRowMatches(row: MatlabAnnotationRow, event: ReviewEvent, meta: Omit<ReviewMetadata, "events" | "warnings">) {
  const original = Number(row.event_time_original_sec), start = Number(row.onset_time_adjusted_sec), end = Number(row.offset_time_adjusted_sec);
  return Number(row.accepted) === 1 && original.toFixed(6) === event.timeSec.toFixed(6)
    && Number.isFinite(new Date(String(row.review_timestamp).replace(" ", "T")).getTime())
    && original >= 0 && start >= 0 && end > start
    && (meta.durationSec === undefined || (original < meta.durationSec && end <= meta.durationSec + 1e-9))
    && (meta.sampleRate === undefined || Number(row.sampling_rate) === meta.sampleRate)
    && (meta.channelCount === undefined || Number(row.n_channels) === meta.channelCount)
    && Math.abs((start - original) - Number(row.onset_offset_sec)) <= 1e-8
    && Math.abs((end - original) - Number(row.offset_offset_sec)) <= 1e-8;
}

/** Avoid scanning every saved row for every event in large review collections. */
export function indexReviewRows(rows: MatlabAnnotationRow[]) {
  const index = new Map<string, MatlabAnnotationRow[]>();
  for (const row of rows) {
    const key = Number(row.event_time_original_sec).toFixed(6);
    append(index, key, row);
  }
  return index;
}

/** Sequential metadata checks stop at the first unfinished event and reuse one cancellable worker. */
export async function findNextDirectoryReview(plan: DirectoryImportPlan, signal: AbortSignal, onProgress: (path: string) => void,
  read?: (plan: DirectoryImportPlan, recording: DirectoryRecording, signal: AbortSignal) => Promise<ReviewMetadata>): Promise<{ recording: DirectoryRecording; timeSec: number } | undefined> {
  signal.throwIfAborted();
  const reader = read ? undefined : createReviewMetadataReader(signal);
  const readMetadata = read ?? reader!.read;
  const cache = directoryReviewCache(plan);
  try {
    for (const recording of plan.recordings) {
      signal.throwIfAborted();
      onProgress(recording.relativePath);
      const metadata = await readMetadata(plan, recording, signal);
      signal.throwIfAborted();
      if (metadata.warnings.length) throw new Error(`${recording.relativePath}: ${metadata.warnings[0]} Open this recording to check it; resume did not skip it.`);
      if (plan.format === "mat-dat" && metadata.channelCount !== undefined && metadata.channelCount < 100) continue;
      const rows = indexReviewRows(cache.byRecording.get(recording.id) ?? []);
      const next = metadata.events.find(event => isReviewEvent(event.label) && event.timeSec >= 0
        && (metadata.durationSec === undefined || event.timeSec < metadata.durationSec)
        && !(rows.get(event.timeSec.toFixed(6)) ?? []).some(row => reviewRowMatches(row, event, metadata)));
      if (next) return { recording, timeSec: next.timeSec };
    }
  } finally { reader?.dispose(); }
}

function createReviewMetadataReader(signal: AbortSignal) {
  const worker = new Worker(new URL("./directory-review-worker.ts", import.meta.url), { type: "module" });
  let failPending: ((error: unknown) => void) | undefined;
  const dispose = () => { signal.removeEventListener("abort", abort); worker.terminate(); };
  const abort = () => { dispose(); failPending?.(signal.reason ?? new DOMException("Resume canceled", "AbortError")); };
  signal.addEventListener("abort", abort, { once: true });
  const read = (plan: DirectoryImportPlan, recording: DirectoryRecording): Promise<ReviewMetadata> => {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      failPending = reject;
      worker.onmessage = (event: MessageEvent<{ metadata?: ReviewMetadata; error?: string }>) => {
        failPending = undefined;
        if (event.data.metadata) resolve(event.data.metadata); else reject(new Error(event.data.error || "Could not check saved review progress."));
      };
      worker.onerror = (event) => { event.preventDefault(); reject(new Error("The background resume reader failed.")); };
      worker.onmessageerror = () => { reject(new Error("The background resume reader could not return metadata.")); };
      const file = plan.format === "mat-dat" ? recording.files.find(file => /\.mat$/i.test(file.name)) : recording.primary;
      worker.postMessage({ format: plan.format, file, datBytes: plan.format === "mat-dat" ? recording.primary.size : undefined });
    });
  };
  return { read, dispose };
}
