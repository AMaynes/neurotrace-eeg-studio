import type { MatlabSpectrogramInputPlan } from "./matlab-spectrogram-input.ts";
import type { MatlabSpectrogramResult } from "./matlab-spectrogram.ts";
import type { SpectrogramSampleReader } from "./full-window-spectrogram.ts";
import type { FullSpectrogramRequest, FullSpectrogramResponse } from "./full-window-spectrogram-worker.ts";

/** One worker for a whole view; raw reads and output stay bounded, cancellation is immediate. */
export function computeFullWindowSpectrogramOffThread(plan: MatlabSpectrogramInputPlan, readSamples: SpectrogramSampleReader,
  options: { signal?: AbortSignal; onProgress?: (completed: number, total: number) => void } = {}): Promise<MatlabSpectrogramResult> {
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  if (typeof Worker === "undefined") return Promise.reject(new Error("This browser does not provide module workers for spectrogram computation."));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./full-window-spectrogram-worker.ts", import.meta.url), { type: "module" });
    let settled = false, reading = false;
    const started = performance.now();
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate(); callback();
    };
    const onAbort = () => finish(() => reject(options.signal?.reason ?? new DOMException("Spectrogram view changed", "AbortError")));
    worker.onmessage = ({ data }: MessageEvent<FullSpectrogramResponse>) => {
      if (settled) return;
      if (data.type === "read") {
        if (reading || !Number.isSafeInteger(data.offset) || !Number.isSafeInteger(data.count)
          || data.offset < 0 || data.count < 1 || data.count > 65_536 || data.offset + data.count > plan.sampleCount) {
          finish(() => reject(new Error("Invalid spectrogram sample request."))); return;
        }
        reading = true;
        void Promise.resolve().then(() => settled ? [] : readSamples(data.offset, data.count)).then((samples) => {
          if (settled) return;
          reading = false;
          // readSamples owns these slices; never detach a source/cache array.
          const message: FullSpectrogramRequest = { type: "samples", id: data.id, data: samples };
          worker.postMessage(message, [...new Set(samples.map((values) => values.buffer))]);
        }).catch((error: unknown) => finish(() => reject(error)));
      } else if (data.type === "progress") {
        try { options.onProgress?.(data.completed, data.total); } catch { /* Diagnostics cannot invalidate results. */ }
      } else if (data.type === "complete") {
        data.result.metrics.workerRoundTripMs = performance.now() - started;
        finish(() => resolve(data.result));
      } else {
        const error = new Error(data.message); error.name = data.name;
        finish(() => reject(error));
      }
    };
    worker.onerror = (event) => { event.preventDefault(); finish(() => reject(new Error(event.message || "Spectrogram worker failed to load."))); };
    worker.onmessageerror = () => finish(() => reject(new Error("Spectrogram worker returned an unreadable result.")));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) { onAbort(); return; }
    try { worker.postMessage({ type: "start", plan } satisfies FullSpectrogramRequest); }
    catch (error) { finish(() => reject(error)); }
  });
}
