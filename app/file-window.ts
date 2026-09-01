/**
 * Exact, bounded-chunk decoding for file-backed signal windows. The same pure
 * implementation is used by the module worker and its compatibility fallback.
 * Only the requested output samples are retained; source chunks are released
 * as the next chunk is read.
 */

import type { EDFHeader, EDFSignalHeader, WindowData } from "./eeg-core";

export const DEFAULT_FILE_WINDOW_CHUNK_BYTES = 8 * 1024 * 1024;

export type FileWindowFormat = "edf" | "raw-dat";
export type FileWindowProgressPhase = "reading" | "decoding" | "complete";
export type FileWindowDecoder = "int16-array" | "data-view";

interface FileWindowRequestBase {
  blob: Blob;
  startSec: number;
  durationSec: number;
  channelIndices?: readonly number[];
  chunkSizeBytes?: number;
}

export interface EDFFileWindowRequest extends FileWindowRequestBase {
  format: "edf";
  header: EDFHeader;
}

export interface RawDatFileWindowRequest extends FileWindowRequestBase {
  format: "raw-dat";
  sampleRate: number;
  channelCount: number;
  channelLabels: readonly string[];
  channelUnits: readonly string[];
  physicalScales: readonly number[];
  physicalOffsets: readonly number[];
}

export type FileWindowBuildRequest = EDFFileWindowRequest | RawDatFileWindowRequest;

export interface FileWindowProgress {
  phase: FileWindowProgressPhase;
  format: FileWindowFormat;
  bytesRead: number;
  totalBytes: number;
  samplesDecoded: number;
  totalSamples: number;
  chunksRead: number;
  elapsedMs: number;
  readMs: number;
  decodeMs: number;
}

export interface FileWindowMetrics extends Omit<FileWindowProgress, "phase"> {
  backend: "worker" | "direct";
  decoder: FileWindowDecoder;
}

export interface FileWindowBuildResult {
  window: WindowData;
  metrics: FileWindowMetrics;
}

export interface FileWindowBuildHooks {
  signal?: AbortSignal;
  onProgress?: (progress: FileWindowProgress) => void;
  backend?: "worker" | "direct";
  /** Test-only portability override for Raw DAT and EDF little-endian reads. */
  decoder?: "automatic" | "portable-data-view";
}

interface NormalizedWindow {
  startSec: number;
  endSec: number;
  durationSec: number;
  channelIndices: number[];
}

interface OutputChannel {
  sourceIndex: number;
  label: string;
  unit: string;
  sampleRate: number;
  firstSample: number;
  endSample: number;
  scale: number;
  offset: number;
  unitScale: number;
  data: Float32Array;
}

export const FILE_WINDOW_HOST_IS_LITTLE_ENDIAN =
  new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function abortReason(signal: AbortSignal) {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("Signal window decoding was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw abortReason(signal);
}

function invalidWindow(message: string): Error & { code: "INVALID_WINDOW" } {
  const error = new Error(message) as Error & { code: "INVALID_WINDOW" };
  error.name = "SignalFileError";
  error.code = "INVALID_WINDOW";
  return error;
}

function validatePositiveSafeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer.`);
  }
}

function normalizeWindow(
  recordingDurationSec: number,
  channelCount: number,
  startSec: number,
  durationSec: number,
  requestedChannels: readonly number[] | undefined,
): NormalizedWindow {
  if (!Number.isFinite(startSec) || !Number.isFinite(durationSec) || durationSec < 0) {
    throw invalidWindow(
      "The requested signal window must use finite seconds and a non-negative duration.",
    );
  }
  const start = Math.min(Math.max(0, startSec), recordingDurationSec);
  const end = Math.min(recordingDurationSec, Math.max(start, startSec + durationSec));
  const channelIndices = requestedChannels
    ? Array.from(requestedChannels)
    : Array.from({ length: channelCount }, (_, index) => index);
  const seen = new Set<number>();
  for (const index of channelIndices) {
    if (!Number.isInteger(index) || index < 0 || index >= channelCount) {
      throw invalidWindow(
        `Channel index ${String(index)} is outside 0–${Math.max(0, channelCount - 1)}.`,
      );
    }
    if (seen.has(index)) {
      throw invalidWindow(`Channel index ${index} was requested more than once.`);
    }
    seen.add(index);
  }
  return {
    startSec: start,
    endSec: end,
    durationSec: Math.max(0, end - start),
    channelIndices,
  };
}

function normalizedPhysicalDimension(dimension: string) {
  const preserved = dimension.trim() || "a.u.";
  const canonical = preserved
    .normalize("NFKC")
    .replace(/[\u00b5\u03bc]/g, "u")
    .replace(/\s+/g, "")
    .toLowerCase();
  const scale = canonical === "v"
    ? 1_000_000
    : canonical === "mv"
      ? 1_000
      : canonical === "uv"
        ? 1
        : canonical === "nv"
          ? 0.001
          : undefined;
  return scale === undefined
    ? { unit: preserved, scale: 1 }
    : { unit: "µV", scale };
}

function progressFromMetrics(
  phase: FileWindowProgressPhase,
  metrics: FileWindowMetrics,
): FileWindowProgress {
  return {
    phase,
    format: metrics.format,
    bytesRead: metrics.bytesRead,
    totalBytes: metrics.totalBytes,
    samplesDecoded: metrics.samplesDecoded,
    totalSamples: metrics.totalSamples,
    chunksRead: metrics.chunksRead,
    elapsedMs: metrics.elapsedMs,
    readMs: metrics.readMs,
    decodeMs: metrics.decodeMs,
  };
}

function emitProgress(
  phase: FileWindowProgressPhase,
  metrics: FileWindowMetrics,
  startedAt: number,
  onProgress: ((progress: FileWindowProgress) => void) | undefined,
) {
  metrics.elapsedMs = nowMs() - startedAt;
  onProgress?.(progressFromMetrics(phase, metrics));
}

function makeResult(
  request: NormalizedWindow,
  channels: readonly OutputChannel[],
  metrics: FileWindowMetrics,
): FileWindowBuildResult {
  return {
    window: {
      data: channels.map((channel) => channel.data),
      sampleRates: channels.map((channel) => channel.sampleRate),
      channelStartSecs: channels.map((channel) => channel.firstSample / channel.sampleRate),
      startSec: request.startSec,
      durationSec: request.durationSec,
      channelIndices: [...request.channelIndices],
      channelLabels: channels.map((channel) => channel.label),
      channelUnits: channels.map((channel) => channel.unit),
    },
    metrics,
  };
}

function makeMetrics(
  format: FileWindowFormat,
  totalBytes: number,
  totalSamples: number,
  decoder: FileWindowDecoder,
  backend: "worker" | "direct" | undefined,
): FileWindowMetrics {
  return {
    backend: backend ?? "direct",
    decoder,
    format,
    bytesRead: 0,
    totalBytes,
    samplesDecoded: 0,
    totalSamples,
    chunksRead: 0,
    elapsedMs: 0,
    readMs: 0,
    decodeMs: 0,
  };
}

function edfOutputChannel(signal: EDFSignalHeader, sourceIndex: number, window: NormalizedWindow) {
  const firstSample = Math.floor(window.startSec * signal.sampleRate);
  const endSample = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.ceil(window.endSec * signal.sampleRate),
  );
  const digitalSpan = signal.digitalMaximum - signal.digitalMinimum;
  const physicalSpan = signal.physicalMaximum - signal.physicalMinimum;
  const usePhysicalScaling = digitalSpan !== 0
    && physicalSpan !== 0
    && Number.isFinite(physicalSpan);
  const scale = usePhysicalScaling ? physicalSpan / digitalSpan : 1;
  const offset = usePhysicalScaling
    ? signal.physicalMinimum - signal.digitalMinimum * scale
    : 0;
  const normalizedUnit = normalizedPhysicalDimension(signal.physicalDimension);
  return {
    sourceIndex,
    label: signal.label,
    unit: usePhysicalScaling ? normalizedUnit.unit : "count",
    sampleRate: signal.sampleRate,
    firstSample,
    endSample,
    scale,
    offset,
    unitScale: usePhysicalScaling ? normalizedUnit.scale : 1,
    data: new Float32Array(Math.max(0, endSample - firstSample)),
  } satisfies OutputChannel;
}

/** Exact EDF sample-window decode matching `EDFSource.getWindow`. */
export async function buildEDFFileWindow(
  request: EDFFileWindowRequest,
  hooks: FileWindowBuildHooks = {},
): Promise<FileWindowBuildResult> {
  const chunkSizeBytes = request.chunkSizeBytes ?? DEFAULT_FILE_WINDOW_CHUNK_BYTES;
  validatePositiveSafeInteger(chunkSizeBytes, "EDF window chunk size");
  throwIfAborted(hooks.signal);
  const displaySignals = request.header.signals.filter((signal) => !signal.isAnnotation);
  const recordingDurationSec = request.header.dataRecordCount
    * request.header.dataRecordDurationSec;
  const window = normalizeWindow(
    recordingDurationSec,
    displaySignals.length,
    request.startSec,
    request.durationSec,
    request.channelIndices,
  );
  const channels = window.channelIndices.map((sourceIndex) => {
    const signal = displaySignals[sourceIndex];
    const channel = edfOutputChannel(signal, sourceIndex, window);
    channel.endSample = Math.min(
      request.header.dataRecordCount * signal.samplesPerRecord,
      channel.endSample,
    );
    if (channel.data.length !== channel.endSample - channel.firstSample) {
      channel.data = new Float32Array(Math.max(0, channel.endSample - channel.firstSample));
    }
    return channel;
  });
  const hasWork = window.durationSec > 0 && channels.length > 0;
  const firstRecord = hasWork
    ? Math.floor(window.startSec / request.header.dataRecordDurationSec)
    : 0;
  const lastRecordExclusive = hasWork
    ? Math.min(
      request.header.dataRecordCount,
      Math.ceil(window.endSec / request.header.dataRecordDurationSec),
    )
    : 0;
  const totalBytes = Math.max(0, lastRecordExclusive - firstRecord)
    * request.header.bytesPerDataRecord;
  const totalSamples = channels.reduce((sum, channel) => sum + channel.data.length, 0);
  const useNativeDecoder = FILE_WINDOW_HOST_IS_LITTLE_ENDIAN
    && hooks.decoder !== "portable-data-view";
  const metrics = makeMetrics(
    "edf",
    totalBytes,
    totalSamples,
    useNativeDecoder ? "int16-array" : "data-view",
    hooks.backend,
  );
  const startedAt = nowMs();
  if (!hasWork || lastRecordExclusive <= firstRecord) {
    emitProgress("complete", metrics, startedAt, hooks.onProgress);
    return makeResult(window, channels, metrics);
  }

  const recordsPerChunk = Math.max(
    1,
    Math.floor(chunkSizeBytes / request.header.bytesPerDataRecord),
  );
  for (
    let chunkRecord = firstRecord;
    chunkRecord < lastRecordExclusive;
    chunkRecord += recordsPerChunk
  ) {
    throwIfAborted(hooks.signal);
    const chunkEndRecord = Math.min(lastRecordExclusive, chunkRecord + recordsPerChunk);
    const byteStart = request.header.headerBytes
      + chunkRecord * request.header.bytesPerDataRecord;
    const byteEnd = request.header.headerBytes
      + chunkEndRecord * request.header.bytesPerDataRecord;
    const readStartedAt = nowMs();
    const buffer = await request.blob.slice(byteStart, byteEnd).arrayBuffer();
    metrics.readMs += nowMs() - readStartedAt;
    throwIfAborted(hooks.signal);
    if (buffer.byteLength !== byteEnd - byteStart) {
      throw new Error(`EDF source ended while reading bytes ${byteStart}–${byteEnd}.`);
    }
    metrics.bytesRead += buffer.byteLength;
    metrics.chunksRead += 1;
    emitProgress("reading", metrics, startedAt, hooks.onProgress);

    const decodeStartedAt = nowMs();
    const nativeSamples = useNativeDecoder ? new Int16Array(buffer) : null;
    const portableView = useNativeDecoder ? null : new DataView(buffer);
    for (let record = chunkRecord; record < chunkEndRecord; record += 1) {
      if (((record - chunkRecord) & 0xff) === 0) throwIfAborted(hooks.signal);
      const localRecordByte = (record - chunkRecord) * request.header.bytesPerDataRecord;
      for (const channel of channels) {
        const signal = displaySignals[channel.sourceIndex];
        const recordFirstSample = record * signal.samplesPerRecord;
        const copyFirst = Math.max(channel.firstSample, recordFirstSample);
        const copyEnd = Math.min(
          channel.endSample,
          recordFirstSample + signal.samplesPerRecord,
        );
        for (let sample = copyFirst; sample < copyEnd; sample += 1) {
          if (((sample - copyFirst) & 0x3fff) === 0) throwIfAborted(hooks.signal);
          const inRecord = sample - recordFirstSample;
          const localByte = localRecordByte + signal.byteOffsetInRecord + inRecord * 2;
          const digital = nativeSamples
            ? nativeSamples[localByte >>> 1]
            : portableView!.getInt16(localByte, true);
          channel.data[sample - channel.firstSample] =
            (digital * channel.scale + channel.offset) * channel.unitScale;
        }
        metrics.samplesDecoded += copyEnd - copyFirst;
      }
    }
    metrics.decodeMs += nowMs() - decodeStartedAt;
    emitProgress("decoding", metrics, startedAt, hooks.onProgress);
  }
  emitProgress("complete", metrics, startedAt, hooks.onProgress);
  return makeResult(window, channels, metrics);
}

function validateRawDatRequest(request: RawDatFileWindowRequest) {
  validatePositiveSafeInteger(request.channelCount, "Raw DAT channel count");
  if (!(request.sampleRate > 0) || !Number.isFinite(request.sampleRate)) {
    throw new RangeError("Raw DAT sample rate must be positive and finite.");
  }
  const exactFields: Array<[string, readonly unknown[]]> = [
    ["Raw DAT channel labels", request.channelLabels],
    ["Raw DAT channel units", request.channelUnits],
    ["Raw DAT physical scales", request.physicalScales],
    ["Raw DAT physical offsets", request.physicalOffsets],
  ];
  for (const [field, values] of exactFields) {
    if (values.length !== request.channelCount) {
      throw new RangeError(`${field} must contain exactly ${request.channelCount} values.`);
    }
  }
  if (request.physicalScales.some((value) => !Number.isFinite(value) || !(value > 0))) {
    throw new RangeError("Raw DAT physical scales must contain only positive finite values.");
  }
  if (request.physicalOffsets.some((value) => !Number.isFinite(value))) {
    throw new RangeError("Raw DAT physical offsets must contain only finite values.");
  }
}

/** Exact headerless signed-int16 window decode matching `RawDatSource.getWindow`. */
export async function buildRawDatFileWindow(
  request: RawDatFileWindowRequest,
  hooks: FileWindowBuildHooks = {},
): Promise<FileWindowBuildResult> {
  validateRawDatRequest(request);
  const chunkSizeBytes = request.chunkSizeBytes ?? DEFAULT_FILE_WINDOW_CHUNK_BYTES;
  validatePositiveSafeInteger(chunkSizeBytes, "Raw DAT window chunk size");
  throwIfAborted(hooks.signal);
  const bytesPerFrame = request.channelCount * Int16Array.BYTES_PER_ELEMENT;
  const totalFrames = Math.floor(request.blob.size / bytesPerFrame);
  const recordingDurationSec = totalFrames / request.sampleRate;
  const window = normalizeWindow(
    recordingDurationSec,
    request.channelCount,
    request.startSec,
    request.durationSec,
    request.channelIndices,
  );
  const firstFrame = Math.floor(window.startSec * request.sampleRate);
  const endFrame = Math.min(totalFrames, Math.ceil(window.endSec * request.sampleRate));
  const frameCount = Math.max(0, endFrame - firstFrame);
  const channels = window.channelIndices.map((sourceIndex): OutputChannel => ({
    sourceIndex,
    label: request.channelLabels[sourceIndex],
    unit: request.channelUnits[sourceIndex],
    sampleRate: request.sampleRate,
    firstSample: firstFrame,
    endSample: endFrame,
    scale: request.physicalScales[sourceIndex],
    offset: request.physicalOffsets[sourceIndex],
    unitScale: 1,
    data: new Float32Array(frameCount),
  }));
  const hasWork = frameCount > 0 && channels.length > 0;
  const totalBytes = hasWork ? frameCount * bytesPerFrame : 0;
  const totalSamples = hasWork ? frameCount * channels.length : 0;
  const useNativeDecoder = FILE_WINDOW_HOST_IS_LITTLE_ENDIAN
    && hooks.decoder !== "portable-data-view";
  const metrics = makeMetrics(
    "raw-dat",
    totalBytes,
    totalSamples,
    useNativeDecoder ? "int16-array" : "data-view",
    hooks.backend,
  );
  const startedAt = nowMs();
  if (!hasWork) {
    emitProgress("complete", metrics, startedAt, hooks.onProgress);
    return makeResult(window, channels, metrics);
  }

  const framesPerChunk = Math.max(1, Math.floor(chunkSizeBytes / bytesPerFrame));
  for (let chunkStart = firstFrame; chunkStart < endFrame; chunkStart += framesPerChunk) {
    throwIfAborted(hooks.signal);
    const chunkEnd = Math.min(endFrame, chunkStart + framesPerChunk);
    const byteStart = chunkStart * bytesPerFrame;
    const byteEnd = chunkEnd * bytesPerFrame;
    const readStartedAt = nowMs();
    const buffer = await request.blob.slice(byteStart, byteEnd).arrayBuffer();
    metrics.readMs += nowMs() - readStartedAt;
    throwIfAborted(hooks.signal);
    if (buffer.byteLength !== byteEnd - byteStart) {
      throw new Error(`Raw DAT source ended while reading bytes ${byteStart}–${byteEnd}.`);
    }
    metrics.bytesRead += buffer.byteLength;
    metrics.chunksRead += 1;
    emitProgress("reading", metrics, startedAt, hooks.onProgress);

    const decodeStartedAt = nowMs();
    const nativeSamples = useNativeDecoder ? new Int16Array(buffer) : null;
    const portableView = useNativeDecoder ? null : new DataView(buffer);
    for (let frame = chunkStart; frame < chunkEnd; frame += 1) {
      if (((frame - chunkStart) & 0x3fff) === 0) throwIfAborted(hooks.signal);
      const localFrame = frame - chunkStart;
      const localFrameSample = localFrame * request.channelCount;
      const localFrameByte = localFrame * bytesPerFrame;
      for (const channel of channels) {
        const digital = nativeSamples
          ? nativeSamples[localFrameSample + channel.sourceIndex]
          : portableView!.getInt16(localFrameByte + channel.sourceIndex * 2, true);
        channel.data[frame - firstFrame] = digital * channel.scale + channel.offset;
      }
    }
    metrics.samplesDecoded += (chunkEnd - chunkStart) * channels.length;
    metrics.decodeMs += nowMs() - decodeStartedAt;
    emitProgress("decoding", metrics, startedAt, hooks.onProgress);
  }
  emitProgress("complete", metrics, startedAt, hooks.onProgress);
  return makeResult(window, channels, metrics);
}

/** Unified entry point used by the worker for both file-backed source types. */
export function buildFileWindow(
  request: FileWindowBuildRequest,
  hooks: FileWindowBuildHooks = {},
) {
  return request.format === "edf"
    ? buildEDFFileWindow(request, hooks)
    : buildRawDatFileWindow(request, hooks);
}

/** Transfer every channel output exactly once when returning from a worker. */
export function fileWindowTransferList(result: FileWindowBuildResult): ArrayBuffer[] {
  return result.window.data.map((channel) => channel.buffer as ArrayBuffer);
}
