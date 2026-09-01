/** Browser client for cancellable, off-main-thread EDF envelope construction. */

import type {
  EDFEnvelopeBuildRequest,
  EDFEnvelopeBuildResult,
  EDFEnvelopeProgress,
} from "./edf-envelope";
import type {
  EDFEnvelopeWorkerRequest,
  EDFEnvelopeWorkerResponse,
} from "./edf-envelope-worker";

export interface EDFEnvelopeWorkerOptions {
  signal?: AbortSignal;
  onProgress?: (progress: EDFEnvelopeProgress) => void;
  /** Defaults to true for compatibility when module workers are unavailable. */
  fallbackToMainThread?: boolean;
}

let nextRequestId = 1;

function abortReason(signal: AbortSignal | undefined) {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("EDF envelope construction was aborted");
  error.name = "AbortError";
  return error;
}

function namedError(name: string, message: string) {
  const error = new Error(message);
  error.name = name;
  return error;
}

async function buildDirectly(
  request: EDFEnvelopeBuildRequest,
  options: EDFEnvelopeWorkerOptions,
) {
  // Keep the fallback implementation out of the main module graph. This lets
  // eeg-core import this client without forming a runtime cycle through the
  // worker's optional EDF+ annotation parser.
  const { executeEDFEnvelopeBuild } = await import("./edf-envelope-integrity.ts");
  return executeEDFEnvelopeBuild(request, {
    backend: "direct",
    signal: options.signal,
    onProgress: (progress) => {
      try {
        options.onProgress?.(progress);
      } catch {
        // Diagnostics must not invalidate an otherwise successful signal read.
      }
    },
  });
}

/**
 * Builds a display envelope in a short-lived module worker. Aborting terminates
 * the worker immediately, including while it is decoding a large record chunk.
 *
 * When `request.integrity` is set, SHA-256 and/or EDF+ TAL extraction share the
 * same sequential source reads and are returned on `result.integrity`.
 */
export function buildEDFEnvelopeWindowOffThread(
  request: EDFEnvelopeBuildRequest,
  options: EDFEnvelopeWorkerOptions = {},
): Promise<EDFEnvelopeBuildResult> {
  if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
  const allowFallback = options.fallbackToMainThread !== false;
  if (typeof Worker === "undefined") {
    return allowFallback
      ? buildDirectly(request, options)
      : Promise.reject(new Error("This browser does not provide module workers for EDF envelope construction."));
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL("./edf-envelope-worker.ts", import.meta.url), { type: "module" });
  } catch (error) {
    return allowFallback
      ? buildDirectly(request, options)
      : Promise.reject(error);
  }

  const requestId = nextRequestId;
  nextRequestId = nextRequestId >= Number.MAX_SAFE_INTEGER ? 1 : nextRequestId + 1;
  return new Promise<EDFEnvelopeBuildResult>((resolve, reject) => {
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

    worker.onmessage = (event: MessageEvent<EDFEnvelopeWorkerResponse>) => {
      const response = event.data;
      if (response.requestId !== requestId) return;
      if (response.type === "progress") {
        try {
          options.onProgress?.(response.progress);
        } catch {
          // Diagnostics must not invalidate an otherwise successful signal read.
        }
      } else if (response.type === "complete") {
        finish(() => resolve(response.result));
      } else {
        finish(() => reject(namedError(response.name, response.message)));
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fallbackToDirect(namedError("WorkerError", event.message || "EDF envelope worker failed to load."));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const message: EDFEnvelopeWorkerRequest = { type: "build", requestId, request };
    try {
      worker.postMessage(message);
    } catch (error) {
      fallbackToDirect(error);
    }
  });
}
