/*
Purpose: Browser client for cancellable exact EDF and Raw DAT sample-window reads.
File Dependencies: app/file-window-worker.ts, app/file-window.ts.
*/


import {
  buildFileWindow,
  type EDFFileWindowRequest,
  type FileWindowBuildRequest,
  type FileWindowBuildResult,
  type FileWindowProgress,
  type RawDatFileWindowRequest,
} from "./file-window.ts";
import type {
  FileWindowWorkerRequest,
  FileWindowWorkerResponse,
} from "./file-window-worker";

export interface FileWindowWorkerOptions {
  signal?: AbortSignal;
  onProgress?: (progress: FileWindowProgress) => void;
  /** Defaults to true for compatibility when module workers are unavailable. */
  fallbackToMainThread?: boolean;
}

let nextRequestId = 1;

/** Returns the supplied cancellation reason or the operation-specific AbortError. */
function abortReason(signal: AbortSignal | undefined) {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("Signal window decoding was aborted");
  error.name = "AbortError";
  return error;
}

/** Creates an Error with the supplied name and message. */
function namedError(name: string, message: string, code?: string) {
  const error = new Error(message) as Error & { code?: string };
  error.name = name;
  if (code !== undefined) error.code = code;
  return error;
}

/** Decodes the requested window on the calling thread with the same cancellation contract. */
function buildDirectly(
  request: FileWindowBuildRequest,
  options: FileWindowWorkerOptions,
) {
  return buildFileWindow(request, {
    backend: "direct",
    signal: options.signal,
    /** Forwards progress without letting a diagnostics callback invalidate the source read. */
    onProgress: (progress) => {
      try {
        options.onProgress?.(progress);
      } catch {
        // Diagnostics must not invalidate a successful source read.
      }
    },
  });
}

/**
 * Decodes a requested sample window in a short-lived unified module worker.
 * Aborting terminates the worker immediately, including during a large loop.
 */
export function buildFileWindowOffThread(
  request: FileWindowBuildRequest,
  options: FileWindowWorkerOptions = {},
): Promise<FileWindowBuildResult> {
  if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
  const allowFallback = options.fallbackToMainThread !== false;
  if (typeof Worker === "undefined") {
    return allowFallback
      ? buildDirectly(request, options)
      : Promise.reject(new Error("This browser does not provide module workers for signal window decoding."));
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL("./file-window-worker.ts", import.meta.url), { type: "module" });
  } catch (error) {
    return allowFallback
      ? buildDirectly(request, options)
      : Promise.reject(error);
  }

  const requestId = nextRequestId;
  nextRequestId = nextRequestId >= Number.MAX_SAFE_INTEGER ? 1 : nextRequestId + 1;
  return new Promise<FileWindowBuildResult>((resolve, reject) => {
    let settled = false;
    /** Releases listeners and worker resources owned by the current operation. */
    const cleanup = () => {
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    /** Settles the operation once and releases its associated resources. */
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    /** Releases the worker and retries through the permitted direct implementation. */
    const fallbackToDirect = (workerError: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!allowFallback) {
        reject(workerError);
        return;
      }
      void buildDirectly(request, options).then(resolve, reject);
    };
    /** Cancels the active operation and propagates its cancellation reason. */
    const onAbort = () => finish(() => reject(abortReason(options.signal)));

    worker.onmessage = (event: MessageEvent<FileWindowWorkerResponse>) => {
      const response = event.data;
      if (response.requestId !== requestId) return;
      if (response.type === "progress") {
        try {
          options.onProgress?.(response.progress);
        } catch {
          // Diagnostics must not invalidate a successful source read.
        }
      } else if (response.type === "complete") {
        finish(() => resolve(response.result));
      } else {
        finish(() => reject(namedError(response.name, response.message, response.code)));
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fallbackToDirect(namedError(
        "WorkerError",
        event.message || "Signal window worker failed to load.",
      ));
    };
    worker.onmessageerror = () => {
      fallbackToDirect(namedError(
        "DataCloneError",
        "Signal window worker could not deserialize its request or response.",
      ));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const message: FileWindowWorkerRequest = { type: "build", requestId, request };
    try {
      worker.postMessage(message);
    } catch (error) {
      fallbackToDirect(error);
    }
  });
}

/** Dispatches an EDF window through the shared worker decoder. */
export function buildEDFFileWindowOffThread(
  request: EDFFileWindowRequest,
  options?: FileWindowWorkerOptions,
) {
  return buildFileWindowOffThread(request, options);
}

/** Dispatches a DAT window through the shared worker decoder. */
export function buildRawDatFileWindowOffThread(
  request: RawDatFileWindowRequest,
  options?: FileWindowWorkerOptions,
) {
  return buildFileWindowOffThread(request, options);
}
