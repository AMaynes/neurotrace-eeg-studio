/**
 * Shared per-folder label cache and bounded worker scheduler. Completed metadata
 * is reused in memory and IndexedDB; only explicit cancellation stops its reader.
 * File references remain local and no source samples or hashes enter this cache.
 */
import { directoryRecordingFiles, type DirectoryImportFormat, type DirectoryImportPlan, type DirectoryRecording } from "./directory-import.ts";
import { createEventLabelMatcher } from "./event-keywords.ts";
import type { DirectoryEventIndex, DirectoryEventRequest, DirectoryTimedEvent } from "./directory-event-index.ts";
import { readStoredDirectoryIndex, storeDirectoryIndex } from "./directory-event-storage.ts";
import type { DirectoryEventResponse } from "./directory-event-worker.ts";

export interface DirectoryEventCache {
  entries: Record<string, DirectoryEventIndex>;
  query: string;
}
const caches = new WeakMap<readonly DirectoryRecording[], DirectoryEventCache>();
const pendingScans = new WeakMap<DirectoryEventCache, Promise<void>>();

export function supportsDirectoryEventSearch(format: DirectoryImportFormat): boolean {
  return format !== "edf";
}

export function directoryEventCache(plan: DirectoryImportPlan): DirectoryEventCache {
  const namespace = plan.unfilteredRecordings ?? plan.recordings;
  let cache = caches.get(namespace);
  if (!cache) { cache = { entries: {}, query: "" }; caches.set(namespace, cache); }
  return cache;
}

/** Query persistence is confined to this catalog's in-memory store. */
export function setDirectoryEventQuery(plan: DirectoryImportPlan, query: string) {
  directoryEventCache(plan).query = query;
}

function eventRequest(plan: DirectoryImportPlan, recording: DirectoryRecording): DirectoryEventRequest {
  const file = plan.format === "mat-dat" ? recording.files.find((file) => /\.mat$/i.test(file.name)) : recording.primary;
  if (!file) throw new Error("Missing MAT event metadata.");
  return { format: plan.format, file,
    eventTables: directoryRecordingFiles(plan, recording).filter((file) => /(?:^|_)events\.tsv$/i.test(file.name)) };
}

/** One pending request per worker. Explicit folder filtering can check several files at once. */
async function performDirectoryScan(
  plan: DirectoryImportPlan,
  signal: AbortSignal,
  onUpdate: (id: string | null) => void,
  retry = false,
  filterImport = false,
) {
  if (signal.aborted) return;
  // EDF labels can require reading annotation records throughout the recording.
  // Do not start that work just to display a directory, including on retries.
  if (!filterImport && !supportsDirectoryEventSearch(plan.format)) { onUpdate(null); return; }
  const cache = directoryEventCache(plan);
  const pending = plan.recordings.filter((entry) => !cache.entries[entry.id] || (retry && cache.entries[entry.id].state !== "ready"));
  if (!pending.length) { onUpdate(null); return; }
  let next = 0;
  const runWorker = async () => {
    let worker: Worker | undefined;
    let failPending: ((error: Error) => void) | undefined;
    let fatal: Error | undefined;
    const abort = () => { worker?.terminate(); failPending?.(new Error("Directory search canceled.")); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (next < pending.length) {
        const entry = pending[next++];
        if (signal.aborted) break;
        onUpdate(entry.id);
        if (signal.aborted) break;
        try {
          const request = eventRequest(plan, entry);
          const stored = await readStoredDirectoryIndex(request).catch(() => undefined);
          if (signal.aborted) break;
          if (!stored && !worker && !fatal) {
            try { worker = new Worker(new URL("./directory-event-worker.ts", import.meta.url), { type: "module" }); }
            catch { fatal = new Error("Background label search is unavailable in this browser. Recordings can still be opened normally."); }
          }
          if (!stored && (fatal || !worker)) throw fatal;
          const result = stored ?? await new Promise<DirectoryEventIndex>((resolve, reject) => {
            failPending = reject;
            worker!.onmessage = (event: MessageEvent<DirectoryEventResponse>) => {
              if (event.data.id === entry.id) resolve(event.data.result);
            };
            worker!.onerror = (event) => {
              event.preventDefault();
              fatal = new Error("The background label reader failed. Retry the unchecked sessions.");
              reject(fatal);
            };
            worker!.onmessageerror = () => { fatal = new Error("The background label reader could not return its results."); reject(fatal); };
            worker!.postMessage({ id: entry.id, request });
          });
          if (!stored && result.state === "ready") void storeDirectoryIndex(request, result).catch(() => {});
          if (!signal.aborted) {
            // A failed retry must not discard already-discovered labels. A fully
            // successful check replaces them with the complete current result.
            const labels = result.state === "ready" ? result.labels
              : [...new Set([...(cache.entries[entry.id]?.labels ?? []), ...result.labels])];
            cache.entries[entry.id] = { ...result, labels, state: result.state !== "ready" && labels.length ? "partial" : result.state };
          }
        } catch (error) {
          if (!signal.aborted) cache.entries[entry.id] = { state: "error", labels: cache.entries[entry.id]?.labels ?? [], warnings: [error instanceof Error ? error.message : "Could not check event labels."] };
        } finally { failPending = undefined; }
      }
    } finally {
      signal.removeEventListener("abort", abort);
      worker?.terminate();
    }
  };
  const workerCount = filterImport ? Math.min(4, pending.length, Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1)) : 1;
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  if (!signal.aborted) onUpdate(null);
}

/** Share an in-flight folder index so filter changes never duplicate reads. */
export async function scanDirectoryEvents(
  plan: DirectoryImportPlan, signal: AbortSignal, onUpdate: (id: string | null) => void, retry = false, filterImport = false,
) {
  if (signal.aborted) return;
  const cache = directoryEventCache(plan);
  const pending = pendingScans.get(cache);
  if (pending) {
    await pending;
    if (!signal.aborted) onUpdate(null);
    return;
  }
  const task = performDirectoryScan(plan, signal, onUpdate, retry, filterImport);
  pendingScans.set(cache, task);
  try { await task; }
  finally { if (pendingScans.get(cache) === task) pendingScans.delete(cache); }
}

/** Preserve source order and companion files, and reuse metadata for the loaded subset. */
export function filterDirectoryPlan(plan: DirectoryImportPlan, query: string): DirectoryImportPlan {
  const matches = createEventLabelMatcher(query);
  const { entries } = directoryEventCache(plan);
  const recordings = plan.recordings.filter((entry) => matches(entries[entry.id]?.labels ?? []));
  const filtered = { ...plan, recordings, eventKeywordFilter: query, unfilteredRecordings: plan.unfilteredRecordings ?? plan.recordings };
  const cache = directoryEventCache(filtered);
  for (const { id } of recordings) {
    if (entries[id]) cache.entries[id] = entries[id];
  }
  return filtered;
}

export function nextTimedEvent<T extends DirectoryTimedEvent>(events: readonly T[], query: string, after = -Infinity): T | undefined {
  const matches = createEventLabelMatcher(query);
  let first: T | undefined;
  for (const event of events) {
    if (!Number.isFinite(event.timeSec) || event.timeSec < 0 || event.timeSec <= after || !matches([event.label])) continue;
    if (!first || event.timeSec < first.timeSec) first = event;
  }
  return first;
}

/** Read later recordings in folder order. Only the destination recording is opened. */
export async function findNextDirectoryEvent(
  plan: DirectoryImportPlan,
  afterId: string,
  query: string,
  signal: AbortSignal,
  knownEvents: (recording: DirectoryRecording) => readonly DirectoryTimedEvent[] | undefined,
  onProgress: (path: string) => void,
  excludedLabels: readonly string[] = [],
): Promise<{ target?: { recording: DirectoryRecording; event: DirectoryTimedEvent }; incomplete: number }> {
  const sourceRecordings = plan.unfilteredRecordings ?? plan.recordings;
  const start = sourceRecordings.findIndex(({ id }) => id === afterId);
  if (start < 0) return { incomplete: 0 };
  const included = new Set(plan.recordings.map(({ id }) => id));
  const { entries } = directoryEventCache(plan);
  const matches = createEventLabelMatcher(query);
  let worker: Worker | undefined;
  let rejectRead: ((reason: unknown) => void) | undefined;
  let incomplete = 0;
  const abort = () => {
    worker?.terminate();
    rejectRead?.(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (let index = start + 1; index < sourceRecordings.length; index++) {
      signal.throwIfAborted();
      const recording = sourceRecordings[index];
      if (!included.has(recording.id)) continue;
      const known = knownEvents(recording);
      if (known) {
        const event = nextTimedEvent(known, query);
        if (event) return { target: { recording, event }, incomplete };
        continue;
      }
      const cached = entries[recording.id];
      if (query.trim() && cached?.state === "ready" && !matches(cached.labels)) continue;
      onProgress(recording.relativePath);
      signal.throwIfAborted();
      const request = { ...eventRequest(plan, recording), eventQuery: query, excludedLabels,
        datBytes: plan.format === "mat-dat" ? recording.primary.size : undefined };
      const reader = worker ??= new Worker(new URL("./directory-event-worker.ts", import.meta.url), { type: "module" });
      const result = await new Promise<DirectoryEventIndex>((resolve, reject) => {
        rejectRead = reject;
        reader.onmessage = (message: MessageEvent<DirectoryEventResponse>) => {
          if (message.data.id === recording.id) resolve(message.data.result);
        };
        reader.onerror = (error) => { error.preventDefault(); reject(new Error("The background event reader stopped.")); };
        reader.onmessageerror = () => reject(new Error("Could not read event search results."));
        reader.postMessage({ id: recording.id, request });
      });
      rejectRead = undefined;
      signal.throwIfAborted();
      if (result.state !== "ready") incomplete++;
      if (result.firstEvent) return { target: { recording, event: result.firstEvent }, incomplete };
    }
    return { incomplete };
  } finally {
    signal.removeEventListener("abort", abort);
    worker?.terminate();
  }
}
