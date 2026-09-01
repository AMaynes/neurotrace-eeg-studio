/** File-backed HDF5 reader for MATLAB v7.3 recordings. */

import h5wasm, { Dataset, Group, Reference } from "h5wasm";
import {
  chooseMat73SignalDataset,
  mat73TransferList,
  type Mat73DatasetDescriptor,
  type Mat73EnvelopeResult,
  type Mat73OpenResult,
  type Mat73WindowResult,
  type Mat73WorkerRequest,
  type Mat73WorkerResponse,
} from "./mat73";

const MOUNT_PATH = "/neurotrace-mat73";
const NUMERIC_DTYPE = /^(?:[<>=|])?[bBhHiIlLqQefd]$/;
const MAX_CHANNELS = 65_536;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

let openedFile: InstanceType<typeof h5wasm.File> | null = null;
let signalDataset: Dataset | null = null;
let metadata: Mat73OpenResult | null = null;
let mounted = false;
let mountedFs: Awaited<typeof h5wasm.ready>["FS"] | null = null;

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<Mat73WorkerRequest>) => void) | null;
  postMessage(message: Mat73WorkerResponse, transfer?: Transferable[]): void;
};

function signalError(code: string, message: string) {
  const error = new Error(message) as Error & { code?: string };
  error.name = "SignalFileError";
  error.code = code;
  return error;
}

function elementCount(shape: readonly number[]) {
  return shape.reduce((product, dimension) => product * dimension, 1);
}

function datasetDescriptor(dataset: Dataset): Mat73DatasetDescriptor | null {
  const shape = dataset.shape;
  const dtype = typeof dataset.dtype === "string" ? dataset.dtype : "";
  if (!shape || !NUMERIC_DTYPE.test(dtype)) return null;
  return { path: dataset.path, shape: [...shape], dtype, elementCount: elementCount(shape) };
}

function collectDatasets(group: Group, output: Dataset[], depth = 0) {
  if (depth > 16) return;
  for (const key of group.keys()) {
    const entity = group.get(key);
    if (entity instanceof Dataset) output.push(entity);
    else if (entity instanceof Group && !entity.path.startsWith("/#")) {
      collectDatasets(entity, output, depth + 1);
    }
  }
}

function sampleRateScore(path: string) {
  const leaf = path.split("/").at(-1)?.replace(/[^a-z0-9]/gi, "").toLowerCase() ?? "";
  if (["fs", "srate", "samplerate", "samplingrate", "samplingfrequency"].includes(leaf)) return 100;
  if (leaf.includes("sample") && leaf.includes("rate")) return 90;
  if (leaf.includes("sampling") && leaf.includes("freq")) return 85;
  if (["frequency", "freq", "hz"].includes(leaf)) return 30;
  return 0;
}

function scalarNumber(dataset: Dataset): number | undefined {
  const value = dataset.value;
  const first = ArrayBuffer.isView(value)
    ? (value as unknown as ArrayLike<number | bigint>)[0]
    : Array.isArray(value)
      ? value[0]
      : value;
  const number = typeof first === "bigint" ? Number(first) : first;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

function chooseSampleRate(datasets: readonly Dataset[]) {
  const candidates = datasets
    .map((dataset) => ({ dataset, descriptor: datasetDescriptor(dataset), score: sampleRateScore(dataset.path) }))
    .filter((candidate) => candidate.descriptor?.elementCount === 1 && candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.dataset.path.localeCompare(right.dataset.path));
  for (const candidate of candidates) {
    const value = scalarNumber(candidate.dataset);
    if (value !== undefined && value > 0 && value <= 1_000_000) {
      return { value, source: candidate.dataset.path };
    }
  }
  return { value: 256, source: "assumed" };
}

function decodeCharacterCodes(value: unknown): string {
  const values = ArrayBuffer.isView(value)
    ? Array.from(value as unknown as ArrayLike<number | bigint>)
    : Array.isArray(value) ? value : [];
  return values.map((entry) => {
    const codePoint = typeof entry === "bigint" ? Number(entry) : Number(entry);
    return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : "";
  }).join("").replace(/[\0\s]+$/g, "").trim();
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function labelsFromReferenceDataset(file: InstanceType<typeof h5wasm.File>, dataset: Dataset) {
  const values = dataset.value;
  const references = Array.isArray(values) ? values.filter((value): value is Reference => value instanceof Reference) : [];
  return references.flatMap((reference) => {
    const target = file.dereference(reference) as unknown;
    if (!(target instanceof Dataset)) return [];
    const strings = stringValues(target.value).map((value) => value.trim()).filter(Boolean);
    if (strings.length) return strings;
    const decoded = decodeCharacterCodes(target.value);
    return decoded ? [decoded] : [];
  });
}

function chooseChannelLabels(
  file: InstanceType<typeof h5wasm.File>,
  datasets: readonly Dataset[],
  channelCount: number,
) {
  const candidates = datasets
    .filter((dataset) => {
      const leaf = dataset.path.split("/").at(-1)?.replace(/[^a-z0-9]/gi, "").toLowerCase() ?? "";
      return ["channels", "channellabels", "channelnames", "labels"].includes(leaf);
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const dataset of candidates) {
    const labels = dataset.dtype === "Reference"
      ? labelsFromReferenceDataset(file, dataset)
      : stringValues(dataset.value).map((value) => value.trim()).filter(Boolean);
    if (labels.length === channelCount) return labels;
  }
  return Array.from({ length: channelCount }, (_, index) => `CH${String(index + 1).padStart(3, "0")}`);
}

async function openMatFile(file: File): Promise<Mat73OpenResult> {
  if (openedFile) throw signalError("INVALID_HEADER", "A MATLAB v7.3 file is already open in this worker.");
  const { FS } = await h5wasm.ready;
  mountedFs = FS;
  FS.mkdir(MOUNT_PATH);
  FS.mount(FS.filesystems.WORKERFS, { files: [file] }, MOUNT_PATH);
  mounted = true;
  openedFile = new h5wasm.File(`${MOUNT_PATH}/${file.name}`, "r");
  const datasets: Dataset[] = [];
  collectDatasets(openedFile, datasets);
  const descriptors = datasets.flatMap((dataset) => {
    const descriptor = datasetDescriptor(dataset);
    return descriptor ? [descriptor] : [];
  });
  const selected = chooseMat73SignalDataset(descriptors);
  if (!selected) {
    throw signalError(
      "NO_SIGNAL_MATRIX",
      "No two-dimensional numeric signal matrix was found in this MATLAB v7.3 file.",
    );
  }
  signalDataset = datasets.find((dataset) => dataset.path === selected.path) ?? null;
  if (!signalDataset) throw signalError("NO_SIGNAL_MATRIX", "The selected MATLAB v7.3 signal matrix could not be opened.");
  const sampleAxis = (selected.shape[1] > selected.shape[0] ? 1 : 0) as 0 | 1;
  const channelAxis = sampleAxis === 0 ? 1 : 0;
  const sampleCount = selected.shape[sampleAxis];
  const channelCount = selected.shape[channelAxis];
  if (!(sampleCount > 0) || !(channelCount > 0) || channelCount > MAX_CHANNELS) {
    throw signalError(
      "NO_SIGNAL_MATRIX",
      `MATLAB v7.3 matrix "${selected.path}" does not map to a viable EEG channel × time layout.`,
    );
  }
  const foundRate = chooseSampleRate(datasets);
  const warnings: string[] = [
    "MATLAB v7.3 does not define a standard physical signal scale; values are displayed in arbitrary units.",
  ];
  if (foundRate.source === "assumed") {
    warnings.push("No scalar Fs/sample_rate dataset was found; display timing assumes 256 Hz.");
  }
  const viableCount = descriptors.filter((descriptor) => descriptor.shape.length === 2 && descriptor.elementCount > 1).length;
  if (viableCount > 1) {
    warnings.push(`Selected largest numeric matrix "${selected.path}" (${selected.shape.join("×")}) from ${viableCount} viable datasets.`);
  }
  metadata = {
    matrixPath: selected.path,
    matrixShape: selected.shape,
    sampleAxis,
    sampleCount,
    channelCount,
    sampleRate: foundRate.value,
    sampleRateSource: foundRate.source,
    channelLabels: chooseChannelLabels(openedFile, datasets, channelCount),
    warnings,
  };
  return metadata;
}

function requireOpen() {
  if (!openedFile || !signalDataset || !metadata) {
    throw signalError("INVALID_HEADER", "The MATLAB v7.3 source is not open.");
  }
  return { file: openedFile, dataset: signalDataset, metadata };
}

function numericValues(value: unknown): ArrayLike<number | bigint> {
  if (ArrayBuffer.isView(value)) return value as unknown as ArrayLike<number | bigint>;
  if (Array.isArray(value)) return value as ArrayLike<number | bigint>;
  throw signalError("INVALID_HEADER", "The MATLAB v7.3 signal slice did not decode to numeric values.");
}

function validateRead(firstSample: number, endSample: number, channelIndices: readonly number[]) {
  const { metadata: openMetadata } = requireOpen();
  if (!Number.isInteger(firstSample) || !Number.isInteger(endSample)
    || firstSample < 0 || endSample < firstSample || endSample > openMetadata.sampleCount) {
    throw signalError("INVALID_WINDOW", "The MATLAB v7.3 sample window is outside the signal matrix.");
  }
  const seen = new Set<number>();
  for (const channel of channelIndices) {
    if (!Number.isInteger(channel) || channel < 0 || channel >= openMetadata.channelCount || seen.has(channel)) {
      throw signalError("INVALID_WINDOW", `MATLAB v7.3 channel index ${String(channel)} is invalid or duplicated.`);
    }
    seen.add(channel);
  }
}

function readWindow(firstSample: number, endSample: number, channelIndices: number[]): Mat73WindowResult {
  validateRead(firstSample, endSample, channelIndices);
  const { dataset, metadata: openMetadata } = requireOpen();
  const sampleCount = endSample - firstSample;
  const outputs = channelIndices.map(() => new Float32Array(sampleCount));
  if (!sampleCount || !channelIndices.length) return { data: outputs, firstSample };
  const minimumChannel = Math.min(...channelIndices);
  const maximumChannel = Math.max(...channelIndices);
  const channelSpan = maximumChannel - minimumChannel + 1;
  const ranges: Parameters<Dataset["slice"]>[0] = openMetadata.sampleAxis === 0
    ? [[firstSample, endSample], [minimumChannel, maximumChannel + 1]]
    : [[minimumChannel, maximumChannel + 1], [firstSample, endSample]];
  const values = numericValues(dataset.slice(ranges));
  channelIndices.forEach((channelIndex, outputIndex) => {
    const channelOffset = channelIndex - minimumChannel;
    const output = outputs[outputIndex];
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const sourceIndex = openMetadata.sampleAxis === 0
        ? sample * channelSpan + channelOffset
        : channelOffset * sampleCount + sample;
      output[sample] = Number(values[sourceIndex]);
    }
  });
  return { data: outputs, firstSample };
}

function readEnvelope(request: Extract<Mat73WorkerRequest, { type: "envelope" }>): Mat73EnvelopeResult {
  validateRead(request.firstSample, request.endSample, request.channelIndices);
  if (!Number.isInteger(request.bucketCount) || request.bucketCount <= 0 || request.bucketCount > 1_000_000) {
    throw signalError("INVALID_WINDOW", "MATLAB v7.3 envelope bucket count is invalid.");
  }
  const { dataset, metadata: openMetadata } = requireOpen();
  const minima = request.channelIndices.map(() => new Float32Array(request.bucketCount).fill(Number.POSITIVE_INFINITY));
  const maxima = request.channelIndices.map(() => new Float32Array(request.bucketCount).fill(Number.NEGATIVE_INFINITY));
  const gaps = request.channelIndices.map(() => new Uint8Array(request.bucketCount).fill(1));
  const data = request.channelIndices.map(() => new Float32Array(request.bucketCount));
  const sampleCount = request.endSample - request.firstSample;
  if (!sampleCount || !request.channelIndices.length) {
    minima.forEach((channel) => channel.fill(0));
    maxima.forEach((channel) => channel.fill(0));
    return {
      data,
      minima,
      maxima,
      gaps,
      firstSample: request.firstSample,
      bucketDurationSec: request.durationSec / request.bucketCount,
    };
  }
  const minimumChannel = Math.min(...request.channelIndices);
  const maximumChannel = Math.max(...request.channelIndices);
  const channelSpan = maximumChannel - minimumChannel + 1;
  const samplesPerChunk = Math.max(1, Math.floor(READ_CHUNK_BYTES / (channelSpan * 8)));
  for (let chunkStart = request.firstSample; chunkStart < request.endSample; chunkStart += samplesPerChunk) {
    const chunkEnd = Math.min(request.endSample, chunkStart + samplesPerChunk);
    const chunkSamples = chunkEnd - chunkStart;
    const ranges: Parameters<Dataset["slice"]>[0] = openMetadata.sampleAxis === 0
      ? [[chunkStart, chunkEnd], [minimumChannel, maximumChannel + 1]]
      : [[minimumChannel, maximumChannel + 1], [chunkStart, chunkEnd]];
    const values = numericValues(dataset.slice(ranges));
    for (let localSample = 0; localSample < chunkSamples; localSample += 1) {
      const absoluteSample = chunkStart + localSample;
      const sampleTime = absoluteSample / openMetadata.sampleRate;
      const bucket = Math.max(0, Math.min(
        request.bucketCount - 1,
        Math.floor(((sampleTime - request.startSec) / request.durationSec) * request.bucketCount),
      ));
      request.channelIndices.forEach((channelIndex, outputIndex) => {
        const channelOffset = channelIndex - minimumChannel;
        const sourceIndex = openMetadata.sampleAxis === 0
          ? localSample * channelSpan + channelOffset
          : channelOffset * chunkSamples + localSample;
        const value = Number(values[sourceIndex]);
        if (!Number.isFinite(value)) return;
        if (value < minima[outputIndex][bucket]) minima[outputIndex][bucket] = value;
        if (value > maxima[outputIndex][bucket]) maxima[outputIndex][bucket] = value;
        gaps[outputIndex][bucket] = 0;
      });
    }
  }
  data.forEach((channel, channelIndex) => {
    for (let bucket = 0; bucket < request.bucketCount; bucket += 1) {
      if (gaps[channelIndex][bucket]) {
        minima[channelIndex][bucket] = 0;
        maxima[channelIndex][bucket] = 0;
      } else {
        channel[bucket] = (minima[channelIndex][bucket] + maxima[channelIndex][bucket]) / 2;
      }
    }
  });
  return {
    data,
    minima,
    maxima,
    gaps,
    firstSample: request.firstSample,
    bucketDurationSec: request.durationSec / request.bucketCount,
  };
}

function closeFile() {
  openedFile?.close();
  openedFile = null;
  signalDataset = null;
  metadata = null;
  if (mounted) {
    mountedFs?.unmount(MOUNT_PATH);
    mountedFs?.rmdir(MOUNT_PATH);
    mounted = false;
    mountedFs = null;
  }
}

workerScope.onmessage = (event) => {
  const request = event.data;
  try {
    if (request.type === "open") {
      void openMatFile(request.file).then(
        (result) => workerScope.postMessage({ type: "opened", requestId: request.requestId, result }),
        (error: unknown) => postError(request.requestId, error),
      );
      return;
    }
    if (request.type === "window") {
      const result = readWindow(request.firstSample, request.endSample, request.channelIndices);
      workerScope.postMessage({ type: "window", requestId: request.requestId, result }, mat73TransferList(result));
    } else if (request.type === "envelope") {
      const result = readEnvelope(request);
      workerScope.postMessage({ type: "envelope", requestId: request.requestId, result }, mat73TransferList(result));
    } else {
      closeFile();
      workerScope.postMessage({ type: "closed", requestId: request.requestId });
    }
  } catch (error) {
    postError(request.requestId, error);
  }
};

function postError(requestId: number, error: unknown) {
  workerScope.postMessage({
    type: "error",
    requestId,
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : "MATLAB v7.3 file read failed.",
    code: error instanceof Error && "code" in error
      ? String((error as Error & { code?: unknown }).code)
      : undefined,
  });
}

export {};
