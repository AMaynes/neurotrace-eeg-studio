/** Shared contracts and deterministic dataset selection for MATLAB v7.3 workers. */

export interface Mat73DatasetDescriptor {
  path: string;
  shape: number[];
  dtype: string;
  elementCount: number;
}

export interface Mat73OpenResult {
  matrixPath: string;
  matrixShape: number[];
  sampleAxis: 0 | 1;
  sampleCount: number;
  channelCount: number;
  sampleRate: number;
  sampleRateSource: string;
  channelLabels: string[];
  warnings: string[];
}

export interface Mat73WindowResult {
  data: Float32Array[];
  firstSample: number;
}

export interface Mat73EnvelopeResult extends Mat73WindowResult {
  minima: Float32Array[];
  maxima: Float32Array[];
  gaps: Uint8Array[];
  bucketDurationSec: number;
}

export type Mat73WorkerRequest =
  | { type: "open"; requestId: number; file: File }
  | {
    type: "window";
    requestId: number;
    firstSample: number;
    endSample: number;
    channelIndices: number[];
  }
  | {
    type: "envelope";
    requestId: number;
    firstSample: number;
    endSample: number;
    startSec: number;
    durationSec: number;
    bucketCount: number;
    channelIndices: number[];
  }
  | { type: "close"; requestId: number };

export type Mat73WorkerResponse =
  | { type: "opened"; requestId: number; result: Mat73OpenResult }
  | { type: "window"; requestId: number; result: Mat73WindowResult }
  | { type: "envelope"; requestId: number; result: Mat73EnvelopeResult }
  | { type: "closed"; requestId: number }
  | {
    type: "error";
    requestId: number;
    name: string;
    message: string;
    code?: string;
  };

function signalNameScore(path: string): number {
  const leaf = path.split("/").at(-1)?.replace(/[^a-z0-9]/gi, "").toLowerCase() ?? "";
  if (["data", "eeg", "signal", "signals", "samples", "recording"].includes(leaf)) return 100;
  if (leaf.includes("eeg") || leaf.includes("signal")) return 70;
  return 0;
}

/** Selects the largest two-dimensional numeric dataset, matching MAT v5 behavior. */
export function chooseMat73SignalDataset(
  datasets: readonly Mat73DatasetDescriptor[],
): Mat73DatasetDescriptor | undefined {
  return datasets
    .filter((dataset) => !dataset.path.startsWith("/#"))
    .filter((dataset) => dataset.shape.length === 2 && dataset.elementCount > 1)
    .sort((left, right) =>
      right.elementCount - left.elementCount
      || signalNameScore(right.path) - signalNameScore(left.path)
      || left.path.localeCompare(right.path))[0];
}

export function mat73TransferList(result: Mat73WindowResult | Mat73EnvelopeResult): Transferable[] {
  const buffers: Transferable[] = result.data.map((channel) => channel.buffer as ArrayBuffer);
  if ("minima" in result) {
    buffers.push(
      ...result.minima.map((channel) => channel.buffer as ArrayBuffer),
      ...result.maxima.map((channel) => channel.buffer as ArrayBuffer),
      ...result.gaps.map((channel) => channel.buffer as ArrayBuffer),
    );
  }
  return buffers;
}
