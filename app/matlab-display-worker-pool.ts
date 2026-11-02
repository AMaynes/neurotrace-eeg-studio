import { createMatlabDisplayWorkerClient, type MatlabDisplayWorkerChunk } from "./matlab-display-worker-client.ts";

/** Channels are independent during FIR processing. Each channel keeps its exact sum order. */
export function matlabDisplayWorkerCount(channelCount: number, hardwareConcurrency = typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency) {
  const cores = Number.isFinite(hardwareConcurrency) ? hardwareConcurrency : 2;
  return Math.max(1, Math.min(4, Math.floor(cores / 2), Math.floor(channelCount / 8)));
}

export function createMatlabDisplayWorkerPool(options: { signal?: AbortSignal; fallbackToMainThread?: boolean; workerCount?: number; channelCount: number }) {
  if (options.workerCount !== undefined && (!Number.isSafeInteger(options.workerCount) || options.workerCount < 1)) {
    throw new Error("MATLAB worker count must be a positive integer.");
  }
  const count = Math.max(1, Math.min(4, Math.floor(options.workerCount ?? matlabDisplayWorkerCount(options.channelCount))));
  const clients: ReturnType<typeof createMatlabDisplayWorkerClient>[] = [];
  let closed = false;
  const close = () => { closed = true; clients.forEach((client) => client.close()); };
  try {
    for (let index = 0; index < count; index++) clients.push(createMatlabDisplayWorkerClient(options));
  } catch (error) { close(); throw error; }
  return {
    close,
    async process(channels: readonly MatlabDisplayWorkerChunk[]) {
      if (closed) throw new DOMException("MATLAB processing pool closed", "AbortError");
      const batchSize = Math.ceil(channels.length / clients.length);
      try {
        const results = await Promise.all(clients.map((client, index) => {
          const batch = channels.slice(index * batchSize, (index + 1) * batchSize);
          return batch.length ? client.process(batch) : Promise.resolve([]);
        }));
        return results.flat();
      } catch (error) { close(); throw error; }
    },
  };
}
