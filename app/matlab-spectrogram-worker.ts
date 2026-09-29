import { computeMatlabSpectrogram, matlabSpectrogramTransferList } from "./matlab-spectrogram.ts";
import type { MatlabSpectrogramRequest, MatlabSpectrogramResult } from "./matlab-spectrogram";

export interface MatlabSpectrogramWorkerRequest { requestId: number; request: MatlabSpectrogramRequest }
export type MatlabSpectrogramWorkerResponse =
  | { type: "complete"; requestId: number; result: MatlabSpectrogramResult }
  | { type: "error"; requestId: number; name: string; message: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<MatlabSpectrogramWorkerRequest>) => void) | null;
  postMessage(message: MatlabSpectrogramWorkerResponse, transfer?: Transferable[]): void;
};
// Each request owns this short-lived worker. The client cancels by terminating
// it, so even an in-progress FFT cannot hold up cancellation on the UI thread.
scope.onmessage = ({ data }) => {
  try {
    const result = computeMatlabSpectrogram(data.request);
    scope.postMessage({ type: "complete", requestId: data.requestId, result }, matlabSpectrogramTransferList(result));
  } catch (error) {
    scope.postMessage({ type: "error", requestId: data.requestId,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : "MATLAB spectrogram computation failed." });
  }
};
