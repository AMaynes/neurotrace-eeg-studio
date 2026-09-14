/** Short-lived module worker for the viewer's spectrogram signal math. */

import { computeAverageSpectrogram, computeSpectrogram, spectrogramTransferList } from "./spectrogram-compute.ts";
import type {
  SpectrogramAverageComputeRequest,
  SpectrogramComputeRequest,
  SpectrogramComputeResult,
} from "./spectrogram-compute";

export type SpectrogramWorkerRequest =
  | { type: "compute"; requestId: number; request: SpectrogramComputeRequest }
  | { type: "compute-average"; requestId: number; request: SpectrogramAverageComputeRequest };

export type SpectrogramWorkerResponse =
  | { type: "complete"; requestId: number; result: SpectrogramComputeResult }
  | { type: "error"; requestId: number; name: string; message: string };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<SpectrogramWorkerRequest>) => void) | null;
  postMessage(message: SpectrogramWorkerResponse, transfer?: Transferable[]): void;
};

workerScope.onmessage = (event) => {
  const { requestId } = event.data;
  try {
    const result = event.data.type === "compute-average"
      ? computeAverageSpectrogram(event.data.request)
      : computeSpectrogram(event.data.request);
    workerScope.postMessage(
      { type: "complete", requestId, result },
      spectrogramTransferList(result),
    );
  } catch (error: unknown) {
    workerScope.postMessage({
      type: "error",
      requestId,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : "Spectrogram computation failed",
    });
  }
};

export {};
