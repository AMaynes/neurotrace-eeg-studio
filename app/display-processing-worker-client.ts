/** Browser client for cancellable clinical display processing in a worker. */

import {
  applyDisplayFilters,
  prepareClinicalDisplaySignals,
  type DisplayFilterSettings,
} from "./eeg-core";

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

export function processDisplaySignalsOffThread(
  request: DisplayProcessingRequest,
  options: { signal?: AbortSignal } = {},
): Promise<DisplayProcessingResult> {
  if (options.signal?.aborted) {
    return Promise.reject(options.signal.reason
      ?? new DOMException("Signal processing was superseded", "AbortError"));
  }
  if (typeof Worker === "undefined") return Promise.resolve(processDirectly(request));

  return new Promise<DisplayProcessingResult>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL("./display-processing-worker.ts", import.meta.url), { type: "module" });
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
    worker.onerror = (event) => finish(() => reject(new Error(event.message || "Signal processing worker failed")));
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.postMessage(request);
  });
}
