/** Browser client for cancellable clinical display processing in a worker. */

import {
  applyDisplayFilters,
  clinicalDecimationFactor,
  prepareClinicalDisplaySignals,
  type DisplayFilterSettings,
} from "./eeg-core.ts";

export type DisplayProcessingRequest = {
  data: Float32Array[];
  sampleRates: number[];
  filters: DisplayFilterSettings;
  pixelCount: number;
  sourceStartSampleIndices: number[];
};

export type DisplayProcessingResult = {
  data: Float32Array[];
  sampleRates: number[];
  factors: Array<1 | 2>;
  outputStartSampleIndices: number[];
};

type WorkerResponse =
  | ({ type: "complete" } & DisplayProcessingResult)
  | { type: "error"; message: string };

function processDirectly(request: DisplayProcessingRequest): DisplayProcessingResult {
  const filtered = request.filters.enabled
    ? applyDisplayFilters(request.data, request.sampleRates, request.filters)
    : request.data;
  const prepared = prepareClinicalDisplaySignals(
    filtered,
    request.sampleRates,
    request.pixelCount,
    request.sourceStartSampleIndices,
  );
  return {
    data: prepared.data,
    sampleRates: prepared.sampleRates,
    factors: prepared.factors,
    outputStartSampleIndices: prepared.outputStartSampleIndices,
  };
}

/**
 * Detects the common raw/referential case where display preparation would be
 * an identity operation. Returned channels are zero-copy full-range views over
 * the caller's buffers; downstream display code treats them as read-only.
 */
function noOpDisplayResult(request: DisplayProcessingRequest): DisplayProcessingResult | null {
  if (request.filters.enabled
    || request.data.length !== request.sampleRates.length
    || request.data.length !== request.sourceStartSampleIndices.length) {
    return null;
  }
  const allFactorsAreOne = request.data.every((channel, index) =>
    clinicalDecimationFactor(
      request.sampleRates[index],
      channel.length,
      request.pixelCount,
    ) === 1);
  if (!allFactorsAreOne) return null;

  // Reuse the authoritative preparation path for source-index validation and
  // timing semantics. Factor-1 traces retain their input arrays unchanged.
  const prepared = prepareClinicalDisplaySignals(
    request.data,
    request.sampleRates,
    request.pixelCount,
    request.sourceStartSampleIndices,
  );
  return {
    // Separate typed-array views avoid implying ownership of the caller's view
    // objects without copying or detaching their potentially large buffers.
    data: prepared.data.map((channel) => channel.subarray(0)),
    sampleRates: prepared.sampleRates,
    factors: prepared.factors,
    outputStartSampleIndices: prepared.outputStartSampleIndices,
  };
}

export function processDisplaySignalsOffThread(
  request: DisplayProcessingRequest,
  options: { signal?: AbortSignal; fallbackToMainThread?: boolean } = {},
): Promise<DisplayProcessingResult> {
  if (options.signal?.aborted) {
    return Promise.reject(options.signal.reason
      ?? new DOMException("Signal processing was superseded", "AbortError"));
  }
  try {
    const noOpResult = noOpDisplayResult(request);
    if (noOpResult) return Promise.resolve(noOpResult);
  } catch (error) {
    return Promise.reject(error);
  }
  const allowFallback = options.fallbackToMainThread !== false;
  if (typeof Worker === "undefined") return allowFallback
    ? Promise.resolve().then(() => processDirectly(request))
    : Promise.reject(new Error("This browser does not provide module workers for signal processing."));

  let worker: Worker;
  try {
    worker = new Worker(new URL("./display-processing-worker.ts", import.meta.url), { type: "module" });
  } catch (error) {
    return allowFallback
      ? Promise.resolve().then(() => processDirectly(request))
      : Promise.reject(error);
  }

  return new Promise<DisplayProcessingResult>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      callback();
    };
    const onAbort = () => finish(() => {
      if (options.signal?.reason !== undefined) reject(options.signal.reason);
      else {
        const error = new Error("Signal processing was superseded");
        error.name = "AbortError";
        reject(error);
      }
    });
    const fallbackToDirect = (workerError?: unknown) => finish(() => {
      if (!allowFallback) {
        reject(workerError instanceof Error ? workerError : new Error("Signal processing worker failed."));
        return;
      }
      if (options.signal?.aborted) {
        if (options.signal.reason !== undefined) reject(options.signal.reason);
        else {
          const error = new Error("Signal processing was superseded");
          error.name = "AbortError";
          reject(error);
        }
        return;
      }
      Promise.resolve()
        .then(() => processDirectly(request))
        .then(resolve, reject);
    });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response.type === "complete") {
        finish(() => resolve({
          data: response.data,
          sampleRates: response.sampleRates,
          factors: response.factors,
          outputStartSampleIndices: response.outputStartSampleIndices,
        }));
      } else {
        finish(() => reject(new Error(response.message)));
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fallbackToDirect(new Error(event.message || "Signal processing worker failed."));
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // processingData is commonly a small subarray backed by a much larger
    // read-ahead buffer. Copy only the visible slice, then transfer it, so
    // structured cloning never duplicates the entire cache allocation.
    const workerData = request.data.map((channel) => channel.slice());
    const workerRequest = { ...request, data: workerData };
    try {
      worker.postMessage(workerRequest, [...new Set(workerData.map((channel) => channel.buffer))]);
    } catch (error) {
      fallbackToDirect(error);
    }
  });
}
