/** Browser client for cancellable exact EDF and Raw DAT sample-window reads. */

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

function abortReason(signal: AbortSignal | undefined) {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("Signal window decoding was aborted");
  error.name = "AbortError";
  return error;
}

function namedError(name: string, message: string, code?: string) {
  const error = new Error(message) as Error & { code?: string };
  error.name = name;
  if (code !== undefined) error.code = code;
  return error;
}

function buildDirectly(
  request: FileWindowBuildRequest,
  options: FileWindowWorkerOptions,
) {
  return buildFileWindow(request, {
    backend: "direct",
    signal: options.signal,
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
    const cleanup = () => {
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
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

export function buildEDFFileWindowOffThread(
  request: EDFFileWindowRequest,
  options?: FileWindowWorkerOptions,
) {
  return buildFileWindowOffThread(request, options);
}

export function buildRawDatFileWindowOffThread(
  request: RawDatFileWindowRequest,
  options?: FileWindowWorkerOptions,
) {
  return buildFileWindowOffThread(request, options);
}
