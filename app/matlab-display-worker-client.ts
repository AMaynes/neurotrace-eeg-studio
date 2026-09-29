import { filterMatlabDisplayChunk, type MatlabDisplayChunkOptions, type MatlabDisplaySamples } from "./matlab-display-processing.ts";

export interface MatlabDisplayWorkerChunk {
  data: MatlabDisplaySamples;
  options: MatlabDisplayChunkOptions;
}

export interface MatlabDisplayWorkerClient {
  process(channels: readonly MatlabDisplayWorkerChunk[]): Promise<MatlabDisplaySamples[]>;
  close(): void;
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("MATLAB display processing was cancelled", "AbortError");
}

/** One reusable, terminable worker per streamed view; never transfer source/cache buffers. */
export function createMatlabDisplayWorkerClient(
  options: { signal?: AbortSignal; fallbackToMainThread?: boolean } = {},
): MatlabDisplayWorkerClient {
  let closed = false;
  let closeReason: unknown;
  let worker: Worker | null = null;
  let constructionError: unknown;
  if (!options.signal?.aborted && typeof Worker !== "undefined") {
    try {
      worker = new Worker(new URL("./matlab-display-worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      constructionError = error;
    }
  }
  if (constructionError && options.fallbackToMainThread === false) throw constructionError;
  if (!worker && options.fallbackToMainThread === false && !options.signal?.aborted) {
    throw new Error("This browser does not provide module workers for MATLAB display processing.");
  }
  let requestId = 0;
  const pending = new Map<number, { resolve: (data: MatlabDisplaySamples[]) => void; reject: (reason: unknown) => void }>();
  const close = (reason: unknown = abortReason(options.signal)) => {
    if (closed) return;
    closed = true;
    closeReason = reason;
    options.signal?.removeEventListener("abort", onAbort);
    worker?.terminate();
    for (const request of pending.values()) request.reject(reason);
    pending.clear();
  };
  const onAbort = () => close(abortReason(options.signal));
  if (worker) {
    worker.onmessage = (event: MessageEvent<{ id: number; data?: MatlabDisplaySamples[]; error?: string }>) => {
      const request = pending.get(event.data.id);
      if (!request) return;
      pending.delete(event.data.id);
      if (event.data.error !== undefined) request.reject(new Error(event.data.error));
      else if (event.data.data) request.resolve(event.data.data);
      else request.reject(new Error("MATLAB display worker returned no data."));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      close(new Error(event.message || "MATLAB display worker failed."));
    };
    worker.onmessageerror = () => {
      close(new Error("MATLAB display worker could not deserialize its result."));
    };
  }
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  return {
    close: () => close(),
    process(channels) {
      // Module loading can fail while the first file read is still in flight.
      // Preserve that failure for a later process() instead of reporting an
      // AbortError, which the viewer correctly ignores for superseded views.
      if (closed) return Promise.reject(closeReason);
      if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
      if (!worker) return Promise.resolve().then(() => {
        if (closed) throw closeReason;
        if (options.signal?.aborted) throw abortReason(options.signal);
        return channels.map((channel) => filterMatlabDisplayChunk(channel.data, channel.options));
      });
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        // Each input is a bounded source slice; copy only that slice, never a
        // read-ahead owner's full backing allocation and never detach it.
        try {
          const copied = channels.map((channel) => ({ ...channel, data: channel.data.slice() }));
          worker!.postMessage({ id, channels: copied }, copied.map((channel) => channel.data.buffer));
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
  };
}
