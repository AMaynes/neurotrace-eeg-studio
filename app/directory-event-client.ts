/**
 * Per-catalog, memory-only label cache and a sequential worker scheduler. Closing
 * the directory dialog aborts outstanding work; reopening reuses completed scans.
 * File references remain local and no source samples or hashes enter this cache.
 */
import { directoryRecordingFiles, type DirectoryImportFormat, type DirectoryImportPlan } from "./directory-import.ts";
import type { DirectoryEventIndex, DirectoryEventRequest } from "./directory-event-index.ts";
import type { DirectoryEventResponse } from "./directory-event-worker.ts";

export interface DirectoryEventCache {
  entries: Record<string, DirectoryEventIndex>;
  query: string;
}
const caches = new WeakMap<DirectoryImportPlan, DirectoryEventCache>();

export function supportsDirectoryEventSearch(format: DirectoryImportFormat): boolean {
  return format !== "edf";
}

export function directoryEventCache(plan: DirectoryImportPlan): DirectoryEventCache {
  let cache = caches.get(plan);
  if (!cache) { cache = { entries: {}, query: "" }; caches.set(plan, cache); }
  return cache;
}

/** Query persistence is confined to this catalog's in-memory store. */
export function setDirectoryEventQuery(plan: DirectoryImportPlan, query: string) {
  directoryEventCache(plan).query = query;
}

/** Starts one worker, with one pending request. No main-thread decoding fallback. */
export async function scanDirectoryEvents(plan: DirectoryImportPlan, signal: AbortSignal, onUpdate: (id: string | null) => void, retry = false) {
  if (signal.aborted) return;
  // EDF labels can require reading annotation records throughout the recording.
  // Do not start that work just to display a directory, including on retries.
  if (!supportsDirectoryEventSearch(plan.format)) { onUpdate(null); return; }
  const cache = directoryEventCache(plan);
  const pending = plan.recordings.filter((entry) => !cache.entries[entry.id] || (retry && cache.entries[entry.id].state !== "ready"));
  if (!pending.length) { onUpdate(null); return; }
  let worker: Worker | undefined;
  let failPending: ((error: Error) => void) | undefined;
  let fatal: Error | undefined;
  const abort = () => { worker?.terminate(); failPending?.(new Error("Directory search canceled.")); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    try { worker = new Worker(new URL("./directory-event-worker.ts", import.meta.url), { type: "module" }); }
    catch { fatal = new Error("Background label search is unavailable in this browser. Recordings can still be opened normally."); }
    for (const entry of pending) {
      if (signal.aborted) break;
      onUpdate(entry.id);
      if (signal.aborted) break;
      try {
        if (fatal || !worker) throw fatal;
        const file = plan.format === "mat-dat" ? entry.files.find((file) => /\.mat$/i.test(file.name)) : entry.primary;
        if (!file) throw new Error("Missing MAT event metadata.");
        const request: DirectoryEventRequest = { format: plan.format, file,
          eventTables: directoryRecordingFiles(plan, entry).filter((file) => /(?:^|_)events\.tsv$/i.test(file.name)) };
        const result = await new Promise<DirectoryEventIndex>((resolve, reject) => {
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
    if (!signal.aborted) onUpdate(null);
  }
}
