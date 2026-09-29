import { validateMatlabSpectrogramRequest } from "./matlab-spectrogram.ts";
import type { MatlabSpectrogramRequest, MatlabSpectrogramResult } from "./matlab-spectrogram";
import type { MatlabSpectrogramWorkerRequest, MatlabSpectrogramWorkerResponse } from "./matlab-spectrogram-worker";

let nextRequestId = 1;
const abortReason = (signal?: AbortSignal) => signal?.reason ?? new DOMException("MATLAB spectrogram computation was aborted.", "AbortError");

/** Copies bounded input, transfers it, and never falls back onto the UI thread. */
export function computeMatlabSpectrogramOffThread(request: MatlabSpectrogramRequest, options: { signal?: AbortSignal } = {}): Promise<MatlabSpectrogramResult> {
  if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
  try { validateMatlabSpectrogramRequest(request); } catch (error) { return Promise.reject(error); }
  if (typeof Worker === "undefined") return Promise.reject(new Error("This browser does not provide module workers for MATLAB spectrogram computation."));
  let worker: Worker;
  try { worker = new Worker(new URL("./matlab-spectrogram-worker.ts", import.meta.url), { type: "module" }); }
  catch (error) { return Promise.reject(error); }
  const copyStart = performance.now();
  let data: (Float32Array | Float64Array)[];
  try { data = request.data.map((channel) => channel.slice()); }
  catch (error) { worker.terminate(); return Promise.reject(error); }
  const inputCopyMs = Math.max(0, performance.now() - copyStart);
  const requestId = nextRequestId;
  nextRequestId = nextRequestId >= Number.MAX_SAFE_INTEGER ? 1 : nextRequestId + 1;
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      callback();
    };
    const onAbort = () => finish(() => reject(abortReason(options.signal)));
    const fail = (name: string, message: string) => finish(() => {
      const error = new Error(message); error.name = name; reject(error);
    });
    worker.onmessage = ({ data: response }: MessageEvent<MatlabSpectrogramWorkerResponse>) => {
      if (response.requestId !== requestId) return;
      if (response.type === "error") { fail(response.name, response.message); return; }
      response.result.metrics.inputCopyMs = inputCopyMs;
      response.result.metrics.workerRoundTripMs = Math.max(0, performance.now() - started);
      finish(() => resolve(response.result));
    };
    worker.onerror = (event) => { event.preventDefault(); fail("WorkerError", event.message || "MATLAB spectrogram worker failed to load."); };
    worker.onmessageerror = () => fail("DataCloneError", "MATLAB spectrogram worker returned an unreadable response.");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) { onAbort(); return; }
    const message: MatlabSpectrogramWorkerRequest = { requestId, request: { ...request, data } };
    try { worker.postMessage(message, data.map((channel) => channel.buffer)); }
    catch (error) { finish(() => reject(error)); }
  });
}
