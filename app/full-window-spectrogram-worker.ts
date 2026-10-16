import { computeFullWindowSpectrogram } from "./full-window-spectrogram.ts";
import { matlabSpectrogramTransferList, type MatlabSpectrogramResult } from "./matlab-spectrogram.ts";
import type { MatlabSpectrogramInputPlan } from "./matlab-spectrogram-input.ts";

export type FullSpectrogramRequest = { type: "start"; plan: MatlabSpectrogramInputPlan }
  | { type: "samples"; id: number; data: (Float32Array | Float64Array)[] }
  | { type: "read-error"; id: number; message: string };
export type FullSpectrogramResponse = { type: "read"; id: number; offset: number; count: number }
  | { type: "progress"; completed: number; total: number }
  | { type: "complete"; result: MatlabSpectrogramResult }
  | { type: "error"; name: string; message: string };
const scope = self as unknown as {
  onmessage: (event: MessageEvent<FullSpectrogramRequest>) => void;
  postMessage(message: FullSpectrogramResponse, transfer?: Transferable[]): void;
};
let nextId = 0;
let pending: { id: number; resolve(data: (Float32Array | Float64Array)[]): void; reject(error: unknown): void } | null = null;
scope.onmessage = ({ data }) => {
  if (data.type !== "start") {
    if (pending?.id !== data.id) return;
    const read = pending; pending = null;
    if (data.type === "samples") read.resolve(data.data);
    else read.reject(new Error(data.message));
    return;
  }
  void computeFullWindowSpectrogram(data.plan, (offset, count) => new Promise((resolve, reject) => {
    pending = { id: ++nextId, resolve, reject };
    scope.postMessage({ type: "read", id: nextId, offset, count });
  }), (completed, total) => scope.postMessage({ type: "progress", completed, total }))
    .then((result) => scope.postMessage({ type: "complete", result }, matlabSpectrogramTransferList(result)))
    .catch((error: unknown) => scope.postMessage({ type: "error", name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : "Full-window spectrogram failed." }));
};
