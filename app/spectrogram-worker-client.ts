/*
Purpose: Cancellable browser client for off-main-thread spectrogram computation.
File Dependencies: app/spectrogram-compute.ts, app/spectrogram-worker.ts.
*/


import type {
  SpectrogramAverageComputeRequest,
  SpectrogramAverageSignalRequest,
  SpectrogramComputeRequest,
  SpectrogramComputeResult,
} from "./spectrogram-compute";
import type { SpectrogramWorkerRequest, SpectrogramWorkerResponse } from "./spectrogram-worker";

export interface SpectrogramWorkerOptions {
  signal?: AbortSignal;
}

let nextRequestId = 1;

/** Returns monotonic milliseconds when available, otherwise wall-clock milliseconds. */
function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Returns the supplied cancellation reason or the operation-specific AbortError. */
function abortReason(signal: AbortSignal | undefined) {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("Spectrogram computation was aborted");
  error.name = "AbortError";
  return error;
}

/** Creates an Error with the supplied name and message. */
function namedError(name: string, message: string) {
  const error = new Error(message);
  error.name = name;
  return error;
}

/**
 * Copies the visible input once, transfers that copy to a short-lived worker,
 * and transfers the worker's Float64 output back. Worker absence/failure is
 * surfaced to the caller; this intentionally has no large main-thread fallback.
 */
export function computeSpectrogramOffThread(
  request: SpectrogramComputeRequest,
  options: SpectrogramWorkerOptions = {},
): Promise<SpectrogramComputeResult> {
  return runSpectrogramWorker("compute", [{ ...request, dataStart: request.dataStart ?? 0 }], options);
}

/** Calculates each channel independently, then averages power in the worker. */
export function computeAverageSpectrogramOffThread(
  request: SpectrogramAverageComputeRequest,
  options: SpectrogramWorkerOptions = {},
): Promise<SpectrogramComputeResult> {
  return runSpectrogramWorker("compute-average", request.signals, options);
}

/** Runs the spectrogram worker. */
function runSpectrogramWorker(
  type: SpectrogramWorkerRequest["type"],
  requests: SpectrogramAverageSignalRequest[],
  options: SpectrogramWorkerOptions,
): Promise<SpectrogramComputeResult> {
  if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
  if (!requests.length) return Promise.reject(new RangeError("Spectrogram input must contain at least one signal."));
  if (typeof Worker === "undefined") {
    return Promise.reject(new Error("This browser does not provide module workers for spectrogram computation."));
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL("./spectrogram-worker.ts", import.meta.url), { type: "module" });
  } catch (error) {
    return Promise.reject(error);
  }

  const copyStartedAt = nowMs();
  let inputCopies: SpectrogramAverageSignalRequest[];
  try {
    inputCopies = requests.map((request) => ({
      data: request.data.slice(),
      dataStart: request.dataStart,
      sampleRate: request.sampleRate,
    }));
  } catch (error) {
    worker.terminate();
    return Promise.reject(error);
  }
  const inputCopyMs = Math.max(0, nowMs() - copyStartedAt);
  const roundTripStartedAt = nowMs();
  const requestId = nextRequestId;
  nextRequestId = nextRequestId >= Number.MAX_SAFE_INTEGER ? 1 : nextRequestId + 1;

  return new Promise<SpectrogramComputeResult>((resolve, reject) => {
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
    /** Cancels the active operation and propagates its cancellation reason. */
    const onAbort = () => finish(() => reject(abortReason(options.signal)));

    worker.onmessage = (event: MessageEvent<SpectrogramWorkerResponse>) => {
      const response = event.data;
      if (response.requestId !== requestId) return;
      if (response.type === "complete") {
        response.result.metrics.inputCopyMs = inputCopyMs;
        response.result.metrics.workerRoundTripMs = Math.max(0, nowMs() - roundTripStartedAt);
        finish(() => resolve(response.result));
      } else {
        finish(() => reject(namedError(response.name, response.message)));
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(() => reject(namedError("WorkerError", event.message || "Spectrogram worker failed to load.")));
    };
    worker.onmessageerror = () => {
      finish(() => reject(namedError("DataCloneError", "Spectrogram worker returned an unreadable response.")));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const message: SpectrogramWorkerRequest = type === "compute-average"
      ? { type, requestId, request: { signals: inputCopies } }
      : {
        type,
        requestId,
        request: inputCopies[0],
      };
    try {
      worker.postMessage(message, inputCopies.map((request) => request.data.buffer));
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
