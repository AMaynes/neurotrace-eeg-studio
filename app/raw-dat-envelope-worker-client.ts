/** Browser client for cancellable, off-main-thread Raw DAT envelope building. */

import {
  buildRawDatEnvelopeWindow,
  type RawDatEnvelopeBuildRequest,
  type RawDatEnvelopeBuildResult,
  type RawDatEnvelopeProgress,
} from "./raw-dat-envelope.ts";
import type {
  RawDatEnvelopeWorkerRequest,
  RawDatEnvelopeWorkerResponse,
} from "./raw-dat-envelope-worker";

export interface RawDatEnvelopeWorkerOptions {
  signal?: AbortSignal;
  onProgress?: (progress: RawDatEnvelopeProgress) => void;
  /** Defaults to true for compatibility when module workers are unavailable. */
  fallbackToMainThread?: boolean;
}

let nextRequestId = 1;

function abortReason(signal: AbortSignal | undefined) {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("Raw DAT envelope construction was aborted");
  error.name = "AbortError";
  return error;
}

function namedError(name: string, message: string) {
  const error = new Error(message);
  error.name = name;
  return error;
}

function buildDirectly(
  request: RawDatEnvelopeBuildRequest,
  options: RawDatEnvelopeWorkerOptions,
) {
  return buildRawDatEnvelopeWindow(request, {
    backend: "direct",
    signal: options.signal,
    onProgress: options.onProgress,
  });
}

/**
 * Builds a bounded Raw DAT display envelope in a short-lived module worker.
 * Aborting terminates that worker immediately, even during a large decode loop.
 */
export function buildRawDatEnvelopeWindowOffThread(
  request: RawDatEnvelopeBuildRequest,
  options: RawDatEnvelopeWorkerOptions = {},
): Promise<RawDatEnvelopeBuildResult> {
  if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
  const allowFallback = options.fallbackToMainThread !== false;
  if (typeof Worker === "undefined") {
    return allowFallback
      ? buildDirectly(request, options)
      : Promise.reject(new Error("This browser does not provide module workers for Raw DAT envelope construction."));
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL("./raw-dat-envelope-worker.ts", import.meta.url), { type: "module" });
  } catch (error) {
    return allowFallback
      ? buildDirectly(request, options)
      : Promise.reject(error);
  }

  const requestId = nextRequestId;
  nextRequestId = nextRequestId >= Number.MAX_SAFE_INTEGER ? 1 : nextRequestId + 1;
  return new Promise<RawDatEnvelopeBuildResult>((resolve, reject) => {
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

    worker.onmessage = (event: MessageEvent<RawDatEnvelopeWorkerResponse>) => {
      const response = event.data;
      if (response.requestId !== requestId) return;
      if (response.type === "progress") {
        try {
          options.onProgress?.(response.progress);
        } catch {
          // Diagnostics must not invalidate a successful signal read.
        }
      } else if (response.type === "complete") {
        finish(() => resolve(response.result));
      } else {
        finish(() => reject(namedError(response.name, response.message)));
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fallbackToDirect(namedError("WorkerError", event.message || "Raw DAT envelope worker failed to load."));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const message: RawDatEnvelopeWorkerRequest = { type: "build", requestId, request };
    try {
      worker.postMessage(message);
    } catch (error) {
      fallbackToDirect(error);
    }
  });
}
