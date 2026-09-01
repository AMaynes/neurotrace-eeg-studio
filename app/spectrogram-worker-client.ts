/** Cancellable browser client for off-main-thread spectrogram computation. */

import type { SpectrogramComputeRequest, SpectrogramComputeResult } from "./spectrogram-compute";
import type { SpectrogramWorkerRequest, SpectrogramWorkerResponse } from "./spectrogram-worker";

export interface SpectrogramWorkerOptions {
  signal?: AbortSignal;
}

let nextRequestId = 1;

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function abortReason(signal: AbortSignal | undefined) {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("Spectrogram computation was aborted");
  error.name = "AbortError";
  return error;
}

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
  if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
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
  let inputCopy: Float32Array;
  try {
    inputCopy = request.data.slice();
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

    const message: SpectrogramWorkerRequest = {
      type: "compute",
      requestId,
      request: { data: inputCopy, sampleRate: request.sampleRate },
    };
    try {
      worker.postMessage(message, [inputCopy.buffer]);
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
