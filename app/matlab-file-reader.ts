/** One file-decoding worker per MATLAB display view, reused across bounded reads. */
import { EDFSource, RawDatSource, type SignalSource, type WindowData } from "./eeg-core.ts";
import type { FileWindowBuildRequest, FileWindowMetrics, FileWindowProgress } from "./file-window.ts";
import type { FileWindowWorkerRequest, FileWindowWorkerResponse } from "./file-window-worker.ts";

export interface MatlabFileReaderOptions {
  signal?: AbortSignal;
  onProgress?: (progress: FileWindowProgress) => void;
  onComplete?: (metrics: FileWindowMetrics) => void;
}

export interface MatlabFileReader {
  readWindow(startSec: number, durationSec: number, channelIndices?: readonly number[], options?: MatlabFileReaderOptions): Promise<WindowData>;
  dispose(): void;
}

interface PendingRead {
  id: number;
  startSec: number;
  durationSec: number;
  channelIndices?: readonly number[];
  options: MatlabFileReaderOptions;
  removeAbort(): void;
  resolve(value: WindowData): void;
  reject(error: unknown): void;
}

function aborted(reason?: unknown) {
  return reason ?? new DOMException("MATLAB source read was canceled", "AbortError");
}

function safelyNotify<T>(callback: ((value: T) => void) | undefined, value: T) {
  try { callback?.(value); } catch { /* Diagnostics cannot invalidate decoded samples. */ }
}

/**
 * A reader is scoped to one view. All requests are serialized, including MAT
 * source reads. Aborting any read closes this reader and rejects its queue;
 * callers create a new reader for the next view. EDF/DAT never fall back to a
 * synchronous main-thread decoder if worker setup or execution fails.
 */
export function createMatlabFileReader(source: SignalSource, options: MatlabFileReaderOptions = {}): MatlabFileReader {
  const controller = new AbortController();
  const queue: PendingRead[] = [];
  let active: PendingRead | null = null;
  let worker: Worker | null = null;
  let closed = false;
  let closeReason: unknown;
  let nextId = 1;
  const fileSource = source instanceof EDFSource || source instanceof RawDatSource;

  const close = (reason: unknown = aborted()) => {
    if (closed) return;
    closed = true;
    closeReason = reason;
    options.signal?.removeEventListener("abort", onViewAbort);
    controller.abort(reason);
    worker?.terminate();
    worker = null;
    const pending = active ? [active, ...queue] : [...queue];
    active = null;
    queue.length = 0;
    pending.forEach((item) => { item.removeAbort(); item.reject(reason); });
  };
  const onViewAbort = () => close(aborted(options.signal?.reason));

  const finish = (item: PendingRead, result?: WindowData, error?: unknown) => {
    if (closed || active !== item) return;
    active = null;
    item.removeAbort();
    if (error !== undefined) item.reject(error);
    else item.resolve(result!);
    pump();
  };

  const ensureWorker = () => {
    if (worker) return worker;
    if (typeof Worker === "undefined") throw new Error("This browser does not provide module workers for MATLAB source reads.");
    worker = new Worker(new URL("./file-window-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<FileWindowWorkerResponse>) => {
      const response = event.data;
      const item = active;
      if (closed || !item || response.requestId !== item.id) return;
      if (response.type === "progress") {
        safelyNotify(options.onProgress, response.progress);
        safelyNotify(item.options.onProgress, response.progress);
      } else if (response.type === "complete") {
        safelyNotify(options.onComplete, response.result.metrics);
        safelyNotify(item.options.onComplete, response.result.metrics);
        finish(item, response.result.window);
      } else {
        const error = new Error(response.message) as Error & { code?: string };
        error.name = response.name;
        if (response.code !== undefined) error.code = response.code;
        finish(item, undefined, error);
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      close(new Error(event.message || "MATLAB source worker failed to load."));
    };
    worker.onmessageerror = () => close(new Error("MATLAB source worker could not deserialize its request or response."));
    return worker;
  };

  function pump() {
    if (closed || active || !queue.length) return;
    const item = queue.shift()!;
    active = item;
    if (fileSource) {
      try {
        const target = ensureWorker();
        const base = { startSec: item.startSec, durationSec: item.durationSec, channelIndices: item.channelIndices };
        const request: FileWindowBuildRequest = source instanceof EDFSource
          ? { ...base, format: "edf", blob: source.sourceBlob, header: source.header }
          : { ...base, format: "raw-dat", ...(source as RawDatSource).envelopeWorkerSource };
        const message: FileWindowWorkerRequest = { type: "build", requestId: item.id, request };
        target.postMessage(message);
      } catch (error) { close(error); }
    } else {
      // MAT v7.3 owns its persistent HDF5 worker; in-memory MAT/demo retain their
      // source API. Do not route either through an EDF/DAT compatibility decoder.
      void Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return source.getWindow(item.startSec, item.durationSec, item.channelIndices, { signal: controller.signal });
      }).then((result) => finish(item, result), (error: unknown) => finish(item, undefined, error));
    }
  }

  options.signal?.addEventListener("abort", onViewAbort, { once: true });
  if (options.signal?.aborted) onViewAbort();

  return {
    readWindow(startSec, durationSec, channelIndices, readOptions = {}) {
      if (closed) return Promise.reject(closeReason);
      if (readOptions.signal?.aborted) {
        close(aborted(readOptions.signal.reason));
        return Promise.reject(closeReason);
      }
      return new Promise<WindowData>((resolve, reject) => {
        const onReadAbort = () => close(aborted(readOptions.signal?.reason));
        const item: PendingRead = {
          id: nextId++, startSec, durationSec, channelIndices: channelIndices ? [...channelIndices] : undefined,
          options: readOptions, resolve, reject,
          removeAbort: () => readOptions.signal?.removeEventListener("abort", onReadAbort),
        };
        readOptions.signal?.addEventListener("abort", onReadAbort, { once: true });
        queue.push(item);
        pump();
      });
    },
    dispose: () => close(),
  };
}
