import { filterMatlabDisplayChunk, type MatlabDisplaySamples } from "./matlab-display-processing";
import type { MatlabDisplayWorkerChunk } from "./matlab-display-worker-client";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; channels: MatlabDisplayWorkerChunk[] }>) => void) | null;
  postMessage(message: { id: number; data?: MatlabDisplaySamples[]; error?: string }, transfer?: Transferable[]): void;
};

scope.onmessage = (event) => {
  const { id, channels } = event.data;
  try {
    const data = channels.map((channel) => filterMatlabDisplayChunk(channel.data, channel.options));
    scope.postMessage({ id, data }, [...new Set(data.map((channel) => channel.buffer))]);
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : "MATLAB display filtering failed" });
  }
};

export {};
