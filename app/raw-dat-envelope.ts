/**
 * Pure, bounded-memory envelope construction for sample-major, channel-
 * interleaved signed int16 little-endian DAT recordings. The worker and its
 * direct compatibility fallback share this implementation.
 */

import { buildEnvelopePyramid } from "./eeg-core.ts";
import type { EnvelopeWindowData } from "./eeg-core";
import { IncrementalSha256 } from "./source-integrity.ts";

export const DEFAULT_RAW_DAT_ENVELOPE_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * JavaScript typed arrays use the host byte order. Raw DAT samples are always
 * little-endian, so Int16Array is an exact zero-conversion decoder only on a
 * little-endian host. All currently supported browser CPUs take this fast
 * path; the DataView path below preserves correctness on big-endian hosts.
 */
export const RAW_DAT_HOST_IS_LITTLE_ENDIAN = (() => {
  const probe = new Uint16Array(1);
  probe[0] = 0x0102;
  return new Uint8Array(probe.buffer)[0] === 0x02;
})();

export type RawDatEnvelopeProgressPhase = "reading" | "decoding" | "complete";

export interface RawDatEnvelopeProgress {
  phase: RawDatEnvelopeProgressPhase;
  bytesRead: number;
  totalBytes: number;
  framesRead: number;
  totalFrames: number;
  samplesDecoded: number;
  chunksRead: number;
  elapsedMs: number;
  readMs: number;
  decodeMs: number;
  integrityMs: number;
}

export interface RawDatEnvelopeMetrics {
  backend: "worker" | "direct";
  decoder: "int16-array" | "data-view";
  bytesRead: number;
  totalBytes: number;
  framesRead: number;
  totalFrames: number;
  samplesDecoded: number;
  chunksRead: number;
  elapsedMs: number;
  readMs: number;
  decodeMs: number;
  integrityMs: number;
}

export interface RawDatEnvelopeIntegrityRequest {
  /** Compute exact SHA-256 over every byte, including incomplete trailing data. */
  sha256?: boolean;
}

export interface RawDatEnvelopeIntegrityResult {
  hash?: string;
}

export interface RawDatEnvelopeBuildRequest {
  blob: Blob;
  sampleRate: number;
  channelCount: number;
  channelLabels: readonly string[];
  channelUnits: readonly string[];
  /** Physical units per signed digital count, one value per source channel. */
  physicalScales: readonly number[];
  /** Physical offset after scaling, one value per source channel. */
  physicalOffsets: readonly number[];
  startSec: number;
  durationSec: number;
  bucketCount: number;
  channelIndices?: readonly number[];
  chunkSizeBytes?: number;
  integrity?: RawDatEnvelopeIntegrityRequest;
  /**
   * When set, build conservative full-coverage envelope levels down to this
   * approximate bucket count before returning from the worker.
   */
  pyramidMinimumBucketCount?: number;
}

export interface RawDatEnvelopeBuildResult {
  window: EnvelopeWindowData;
  /** Finest-to-coarsest levels, present only when a pyramid was requested. */
  pyramidLevels?: EnvelopeWindowData[];
  metrics: RawDatEnvelopeMetrics;
  integrity?: RawDatEnvelopeIntegrityResult;
}

export interface RawDatEnvelopeBuildHooks {
  signal?: AbortSignal;
  onProgress?: (progress: RawDatEnvelopeProgress) => void;
  backend?: "worker" | "direct";
  /** Retains the portable decoder for parity tests and unusual environments. */
  decoder?: "auto" | "portable-data-view";
}

type ChannelAccumulator = {
  sourceIndex: number;
  byteOffset: number;
  scale: number;
  offset: number;
  data: Float32Array;
  minima: Float32Array;
  maxima: Float32Array;
  gaps: Uint8Array;
  variation: Float32Array;
  counts: Uint32Array;
  previousBucket: number;
  previousValue: number;
};

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function abortReason(signal: AbortSignal) {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("Raw DAT envelope construction was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw abortReason(signal);
}

function validatePositiveSafeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer.`);
  }
}

function validateCalibration(request: RawDatEnvelopeBuildRequest) {
  const exactLengthFields: Array<[string, readonly unknown[]]> = [
    ["Raw DAT channel labels", request.channelLabels],
    ["Raw DAT channel units", request.channelUnits],
    ["Raw DAT physical scales", request.physicalScales],
    ["Raw DAT physical offsets", request.physicalOffsets],
  ];
  for (const [field, values] of exactLengthFields) {
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

function selectedChannelIndices(request: RawDatEnvelopeBuildRequest) {
  const indices = request.channelIndices
    ? Array.from(request.channelIndices)
    : Array.from({ length: request.channelCount }, (_, index) => index);
  const seen = new Set<number>();
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= request.channelCount) {
      throw new RangeError(`Raw DAT channel index ${String(index)} is outside 0–${request.channelCount - 1}.`);
    }
    if (seen.has(index)) throw new RangeError(`Raw DAT channel index ${index} was requested more than once.`);
    seen.add(index);
  }
  return indices;
}

function makeAccumulator(
  sourceIndex: number,
  request: RawDatEnvelopeBuildRequest,
): ChannelAccumulator {
  const minima = new Float32Array(request.bucketCount);
  const maxima = new Float32Array(request.bucketCount);
  const data = new Float32Array(request.bucketCount);
  minima.fill(Number.POSITIVE_INFINITY);
  maxima.fill(Number.NEGATIVE_INFINITY);
  data.fill(Number.NaN);
  return {
    sourceIndex,
    byteOffset: sourceIndex * 2,
    scale: request.physicalScales[sourceIndex],
    offset: request.physicalOffsets[sourceIndex],
    data,
    minima,
    maxima,
    gaps: new Uint8Array(request.bucketCount),
    variation: new Float32Array(request.bucketCount),
    counts: new Uint32Array(request.bucketCount),
    previousBucket: -1,
    previousValue: Number.NaN,
  };
}

function finishAccumulator(accumulator: ChannelAccumulator, signal?: AbortSignal) {
  for (let bucket = 0; bucket < accumulator.data.length; bucket += 1) {
    if ((bucket & 0xfff) === 0) throwIfAborted(signal);
    const minimum = accumulator.minima[bucket];
    const maximum = accumulator.maxima[bucket];
    if (minimum === Number.POSITIVE_INFINITY || maximum === Number.NEGATIVE_INFINITY) {
      // Oversampling the index creates empty time bins between valid frames;
      // those bins are neutral and must not masquerade as recording loss.
      accumulator.minima[bucket] = Number.NaN;
      accumulator.maxima[bucket] = Number.NaN;
    } else if (accumulator.gaps[bucket]) accumulator.data[bucket] = Number.NaN;
  }
}

function addChannelEnvelopeSample(accumulator: ChannelAccumulator, bucket: number, value: number) {
  if (!Number.isFinite(value)) {
    accumulator.gaps[bucket] = 1;
    accumulator.previousBucket = -1;
    accumulator.previousValue = Number.NaN;
    return;
  }
  if (accumulator.previousBucket === bucket && Number.isFinite(accumulator.previousValue)) {
    accumulator.variation[bucket] += Math.abs(value - accumulator.previousValue);
  }
  accumulator.previousBucket = bucket;
  accumulator.previousValue = value;
  const count = accumulator.counts[bucket] + 1;
  accumulator.counts[bucket] = count;
  accumulator.data[bucket] = count === 1
    ? value
    : accumulator.data[bucket] + (value - accumulator.data[bucket]) / count;
  if (value < accumulator.minima[bucket]) accumulator.minima[bucket] = value;
  if (value > accumulator.maxima[bucket]) accumulator.maxima[bucket] = value;
}

function progress(
  phase: RawDatEnvelopeProgressPhase,
  metrics: RawDatEnvelopeMetrics,
  startedAt: number,
): RawDatEnvelopeProgress {
  return {
    phase,
    bytesRead: metrics.bytesRead,
    totalBytes: metrics.totalBytes,
    framesRead: metrics.framesRead,
    totalFrames: metrics.totalFrames,
    samplesDecoded: metrics.samplesDecoded,
    chunksRead: metrics.chunksRead,
    elapsedMs: nowMs() - startedAt,
    readMs: metrics.readMs,
    decodeMs: metrics.decodeMs,
    integrityMs: metrics.integrityMs,
  };
}

/** Builds one exact min/max envelope while retaining only bucket-sized output. */
export async function buildRawDatEnvelopeWindow(
  request: RawDatEnvelopeBuildRequest,
  hooks: RawDatEnvelopeBuildHooks = {},
): Promise<RawDatEnvelopeBuildResult> {
  validatePositiveSafeInteger(request.channelCount, "Raw DAT channel count");
  validatePositiveSafeInteger(request.bucketCount, "Raw DAT envelope bucket count");
  if (request.pyramidMinimumBucketCount !== undefined) {
    validatePositiveSafeInteger(
      request.pyramidMinimumBucketCount,
      "Raw DAT envelope pyramid minimum bucket count",
    );
  }
  const chunkSizeBytes = request.chunkSizeBytes ?? DEFAULT_RAW_DAT_ENVELOPE_CHUNK_BYTES;
  validatePositiveSafeInteger(chunkSizeBytes, "Raw DAT envelope chunk size");
  if (!(request.sampleRate > 0) || !Number.isFinite(request.sampleRate)) {
    throw new RangeError("Raw DAT sample rate must be positive and finite.");
  }
  if (!Number.isFinite(request.startSec)
    || !Number.isFinite(request.durationSec)
    || request.durationSec < 0) {
    throw new RangeError("Raw DAT envelope range must use finite seconds and a non-negative duration.");
  }
  validateCalibration(request);
  const indices = selectedChannelIndices(request);
  throwIfAborted(hooks.signal);

  const bytesPerFrame = request.channelCount * Int16Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(bytesPerFrame) || bytesPerFrame <= 0) {
    throw new RangeError("Raw DAT frame size exceeds the safe integer range.");
  }
  const totalSourceFrames = Math.floor(request.blob.size / bytesPerFrame);
  const recordingDurationSec = totalSourceFrames / request.sampleRate;
  const startSec = Math.min(Math.max(0, request.startSec), recordingDurationSec);
  const endSec = Math.min(
    recordingDurationSec,
    Math.max(startSec, request.startSec + request.durationSec),
  );
  const durationSec = Math.max(0, endSec - startSec);
  const firstFrame = Math.floor(startSec * request.sampleRate);
  const endFrame = Math.min(totalSourceFrames, Math.ceil(endSec * request.sampleRate));
  const frameCount = Math.max(0, endFrame - firstFrame);
  const accumulators = indices.map((index) => makeAccumulator(index, request));
  const wantsHash = request.integrity?.sha256 === true;
  const sha256 = wantsHash ? new IncrementalSha256() : null;
  const plannedFrameCount = wantsHash
    ? totalSourceFrames
    : accumulators.length
      ? frameCount
      : 0;
  const startedAt = nowMs();
  const useNativeInt16Decoder = RAW_DAT_HOST_IS_LITTLE_ENDIAN
    && hooks.decoder !== "portable-data-view";
  const metrics: RawDatEnvelopeMetrics = {
    backend: hooks.backend ?? "direct",
    decoder: useNativeInt16Decoder ? "int16-array" : "data-view",
    bytesRead: 0,
    totalBytes: wantsHash ? request.blob.size : plannedFrameCount * bytesPerFrame,
    framesRead: 0,
    totalFrames: plannedFrameCount,
    samplesDecoded: 0,
    chunksRead: 0,
    elapsedMs: 0,
    readMs: 0,
    decodeMs: 0,
    integrityMs: 0,
  };

  const completeFrameBytes = totalSourceFrames * bytesPerFrame;
  const requestedByteStart = firstFrame * bytesPerFrame;
  const requestedByteEnd = endFrame * bytesPerFrame;
  const readChunk = async (byteStart: number, byteEnd: number) => {
    throwIfAborted(hooks.signal);
    const readStartedAt = nowMs();
    const buffer = await request.blob.slice(byteStart, byteEnd).arrayBuffer();
    metrics.readMs += nowMs() - readStartedAt;
    throwIfAborted(hooks.signal);
    if (buffer.byteLength !== byteEnd - byteStart) {
      throw new Error(`Raw DAT source ended while reading bytes ${byteStart}–${byteEnd}.`);
    }
    if (sha256) {
      const integrityStartedAt = nowMs();
      sha256.update(new Uint8Array(buffer));
      metrics.integrityMs += nowMs() - integrityStartedAt;
    }
    metrics.bytesRead += buffer.byteLength;
    metrics.chunksRead += 1;
    if (wantsHash) {
      metrics.framesRead = Math.min(
        totalSourceFrames,
        Math.floor(Math.min(byteEnd, completeFrameBytes) / bytesPerFrame),
      );
    }
    hooks.onProgress?.(progress("reading", metrics, startedAt));
    return buffer;
  };
  const readOpaqueSpan = async (byteStart: number, byteEnd: number) => {
    for (let offset = byteStart; offset < byteEnd; offset += chunkSizeBytes) {
      await readChunk(offset, Math.min(byteEnd, offset + chunkSizeBytes));
    }
  };

  if (wantsHash) await readOpaqueSpan(0, requestedByteStart);

  const decodeRequestedFrames = frameCount > 0 && accumulators.length > 0;
  if (decodeRequestedFrames) {
    const framesPerChunk = Math.max(1, Math.floor(chunkSizeBytes / bytesPerFrame));
    const bucketScale = request.bucketCount / (durationSec * request.sampleRate);
    const requestStartFrame = startSec * request.sampleRate;
    for (let chunkStartFrame = firstFrame; chunkStartFrame < endFrame; chunkStartFrame += framesPerChunk) {
      throwIfAborted(hooks.signal);
      const chunkEndFrame = Math.min(endFrame, chunkStartFrame + framesPerChunk);
      const byteStart = chunkStartFrame * bytesPerFrame;
      const byteEnd = chunkEndFrame * bytesPerFrame;
      const buffer = await readChunk(byteStart, byteEnd);

      const decodeStartedAt = nowMs();
      if (useNativeInt16Decoder) {
        // arrayBuffer() returns a zero-offset buffer and every decoded span is
        // frame-aligned, so this view is always Int16-aligned.
        const samples = new Int16Array(buffer);
        for (let frame = chunkStartFrame; frame < chunkEndFrame; frame += 1) {
          if (((frame - chunkStartFrame) & 0x3fff) === 0) throwIfAborted(hooks.signal);
          let bucket = Math.floor((frame - requestStartFrame) * bucketScale);
          if (bucket < 0) bucket = 0;
          else if (bucket >= request.bucketCount) bucket = request.bucketCount - 1;
          const frameSampleOffset = (frame - chunkStartFrame) * request.channelCount;
          for (let outputIndex = 0; outputIndex < accumulators.length; outputIndex += 1) {
            const accumulator = accumulators[outputIndex];
            const digital = samples[frameSampleOffset + accumulator.sourceIndex];
            const value = digital * accumulator.scale + accumulator.offset;
            addChannelEnvelopeSample(accumulator, bucket, value);
          }
        }
      } else {
        // Raw DAT is defined as little-endian. DataView's explicit byte order
        // keeps results exact if JavaScript ever runs on a big-endian host.
        const view = new DataView(buffer);
        for (let frame = chunkStartFrame; frame < chunkEndFrame; frame += 1) {
          if (((frame - chunkStartFrame) & 0x3fff) === 0) throwIfAborted(hooks.signal);
          let bucket = Math.floor((frame - requestStartFrame) * bucketScale);
          if (bucket < 0) bucket = 0;
          else if (bucket >= request.bucketCount) bucket = request.bucketCount - 1;
          const frameByteOffset = (frame - chunkStartFrame) * bytesPerFrame;
          for (let outputIndex = 0; outputIndex < accumulators.length; outputIndex += 1) {
            const accumulator = accumulators[outputIndex];
            const digital = view.getInt16(frameByteOffset + accumulator.byteOffset, true);
            const value = digital * accumulator.scale + accumulator.offset;
            addChannelEnvelopeSample(accumulator, bucket, value);
          }
        }
      }
      metrics.decodeMs += nowMs() - decodeStartedAt;
      const decodedFrames = chunkEndFrame - chunkStartFrame;
      if (!wantsHash) metrics.framesRead += decodedFrames;
      metrics.samplesDecoded += decodedFrames * accumulators.length;
      hooks.onProgress?.(progress("decoding", metrics, startedAt));
    }
  } else if (wantsHash) {
    await readOpaqueSpan(requestedByteStart, requestedByteEnd);
  }

  if (wantsHash) await readOpaqueSpan(requestedByteEnd, request.blob.size);

  const finalizeStartedAt = nowMs();
  for (const accumulator of accumulators) finishAccumulator(accumulator, hooks.signal);
  metrics.decodeMs += nowMs() - finalizeStartedAt;
  let integrity: RawDatEnvelopeIntegrityResult | undefined;
  if (sha256) {
    const integrityStartedAt = nowMs();
    integrity = { hash: sha256.hexDigest() };
    metrics.integrityMs += nowMs() - integrityStartedAt;
  }
  const effectiveRate = durationSec > 0 ? request.bucketCount / durationSec : 0;
  const window: EnvelopeWindowData = {
    data: accumulators.map((entry) => entry.data),
    minima: accumulators.map((entry) => entry.minima),
    maxima: accumulators.map((entry) => entry.maxima),
    gaps: accumulators.map((entry) => entry.gaps),
    variation: accumulators.map((entry) => entry.variation),
    bucketDurationSec: durationSec > 0 ? durationSec / request.bucketCount : 0,
    sampleRates: accumulators.map(() => effectiveRate),
    channelStartSecs: accumulators.map(() => startSec),
    startSec,
    durationSec,
    channelIndices: indices,
    channelLabels: indices.map((index) => request.channelLabels[index]),
    channelUnits: indices.map((index) => request.channelUnits[index]),
  };
  let pyramidLevels: EnvelopeWindowData[] | undefined;
  if (request.pyramidMinimumBucketCount !== undefined) {
    const pyramidStartedAt = nowMs();
    pyramidLevels = buildEnvelopePyramid(window, request.pyramidMinimumBucketCount);
    metrics.decodeMs += nowMs() - pyramidStartedAt;
  }
  metrics.elapsedMs = nowMs() - startedAt;
  hooks.onProgress?.(progress("complete", metrics, startedAt));
  return pyramidLevels
    ? { window, pyramidLevels, metrics, integrity }
    : { window, metrics, integrity };
}

/** Transfer every retained signal buffer exactly once when leaving a worker. */
export function rawDatEnvelopeTransferList(result: RawDatEnvelopeBuildResult): ArrayBuffer[] {
  const windows = result.pyramidLevels ?? [result.window];
  const buffers = windows.flatMap((window) => [
    ...window.data.map((channel) => channel.buffer),
    ...window.minima.map((channel) => channel.buffer),
    ...window.maxima.map((channel) => channel.buffer),
    ...window.gaps.map((channel) => channel.buffer),
    ...(window.variation ?? []).map((channel) => channel.buffer),
  ]).map((buffer) => buffer as ArrayBuffer);
  return [...new Set(buffers)];
}
