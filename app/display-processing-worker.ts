/** Runs clinical display filtering and conditional decimation away from the UI thread. */

import {
  applyDisplayFilters,
  prepareClinicalDisplaySignals,
  type DisplayFilterSettings,
} from "./eeg-core";

type DisplayProcessingRequest = {
  data: Float32Array[];
  sampleRates: number[];
  filters: DisplayFilterSettings;
  pixelCount: number;
  sourceStartSampleIndices: number[];
};

type DisplayProcessingResponse =
  | {
    type: "complete";
    data: Float32Array[];
    sampleRates: number[];
    factors: number[];
    outputStartSampleIndices: number[];
  }
  | { type: "error"; message: string };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<DisplayProcessingRequest>) => void) | null;
  postMessage(message: DisplayProcessingResponse, transfer?: Transferable[]): void;
};

workerScope.onmessage = (event) => {
  try {
    const request = event.data;
    const filtered = request.filters.enabled
      ? applyDisplayFilters(request.data, request.sampleRates, request.filters)
      : request.data;
    const prepared = prepareClinicalDisplaySignals(
      filtered,
      request.sampleRates,
      request.pixelCount,
      request.sourceStartSampleIndices,
    );
    const response: DisplayProcessingResponse = {
      type: "complete",
      data: prepared.data,
      sampleRates: prepared.sampleRates,
      factors: prepared.factors,
      outputStartSampleIndices: prepared.outputStartSampleIndices,
    };
    workerScope.postMessage(response, prepared.data.map((channel) => channel.buffer));
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Signal processing failed",
    });
  }
};

export {};
