/**
 * Pure, bounded-memory EDF envelope construction shared by the worker and its
 * direct fallback. File reads remain record-aligned while the retained output
 * is limited to one min/max/midpoint/gap tuple per requested display bucket.
 */

import { buildEnvelopePyramid } from "./eeg-core.ts";
import type {
  EDFHeader,
  EDFSignalHeader,
  EnvelopeWindowData,
  SourceEvent,
} from "./eeg-core";

export const DEFAULT_EDF_ENVELOPE_CHUNK_BYTES = 4 * 1024 * 1024;

export type EDFEnvelopeProgressPhase = "reading" | "decoding" | "complete";

export interface EDFEnvelopeProgress {
  phase: EDFEnvelopeProgressPhase;
  bytesRead: number;
  totalBytes: number;
  recordsRead: number;
  totalRecords: number;
  samplesDecoded: number;
  chunksRead: number;
  elapsedMs: number;
  readMs: number;
  decodeMs: number;
  integrityMs: number;
}

export interface EDFEnvelopeMetrics {
  backend: "worker" | "direct";
  bytesRead: number;
  totalBytes: number;
  recordsRead: number;
  totalRecords: number;
  samplesDecoded: number;
  chunksRead: number;
  elapsedMs: number;
  readMs: number;
  decodeMs: number;
  integrityMs: number;
}

export interface EDFEnvelopeIntegrityRequest {
  /** Compute an exact SHA-256 over every byte, including header and trailing bytes. */
  sha256?: boolean;
  /** Extract and de-duplicate EDF+ TAL annotations during the record pass. */
  edfAnnotations?: boolean;
}

export interface EDFEnvelopeIntegrityResult {
  hash?: string;
  edfAnnotations?: {
    events: SourceEvent[];
    warnings: string[];
  };
}

export interface EDFEnvelopeBuildRequest {
  blob: Blob;
  header: EDFHeader;
  startSec: number;
  durationSec: number;
  bucketCount: number;
  /** Indices refer to display signals (annotation channels are excluded). */
  channelIndices?: readonly number[];
  chunkSizeBytes?: number;
  integrity?: EDFEnvelopeIntegrityRequest;
  /**
   * When set, build conservative full-coverage envelope levels down to this
   * approximate bucket count before returning from the worker. The first
   * returned level is the exact `window`; later levels are progressively
   * coarser and retain exact extrema/gap coverage.
   */
  pyramidMinimumBucketCount?: number;
}

export interface EDFEnvelopeBuildResult {
  window: EnvelopeWindowData;
  /** Finest-to-coarsest levels, present only when a pyramid was requested. */
  pyramidLevels?: EnvelopeWindowData[];
  metrics: EDFEnvelopeMetrics;
  integrity?: EDFEnvelopeIntegrityResult;
}

export type EDFEnvelopeChunkSection = "prefix" | "records" | "suffix";

/**
 * A borrowed view over one just-read source chunk. Consumers must finish with
 * `bytes` before the hook resolves; the builder does not retain the buffer.
 */
export interface EDFEnvelopeSourceChunk {
  bytes: Uint8Array;
  byteStart: number;
  byteEnd: number;
  section: EDFEnvelopeChunkSection;
  firstRecord?: number;
  recordCount?: number;
}

export interface EDFEnvelopeBuildHooks {
  signal?: AbortSignal;
  onProgress?: (progress: EDFEnvelopeProgress) => void;
  /** Allows hashing/indexing to piggyback on the exact same sequential reads. */
  onSourceChunk?: (chunk: EDFEnvelopeSourceChunk) => void | Promise<void>;
  /** Read every declared EDF record even if the display window is smaller. */
  scanAllRecords?: boolean;
  /** Read header and trailing bytes too. Implies `scanAllRecords`. */
  scanWholeBlob?: boolean;
  backend?: "worker" | "direct";
}

type EnvelopeAccumulator = {
  minima: Float32Array;
  maxima: Float32Array;
  gaps: Uint8Array;
  data: Float32Array;
  variation: Float32Array;
  previousBucket: number;
  previousValue: number;
};

type SelectedSignal = {
  signal: EDFSignalHeader;
  firstSample: number;
  endSample: number;
  requestStartSample: number;
  bucketScale: number;
  scale: number;
  offset: number;
  unitScale: number;
  unit: string;
  accumulator: EnvelopeAccumulator;
};

const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function abortError(signal: AbortSignal) {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("EDF envelope construction was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw abortError(signal);
}

function validatePositiveInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer.`);
  }
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

function makeAccumulator(bucketCount: number): EnvelopeAccumulator {
  const minima = new Float32Array(bucketCount);
  const maxima = new Float32Array(bucketCount);
  const data = new Float32Array(bucketCount);
  minima.fill(Number.POSITIVE_INFINITY);
  maxima.fill(Number.NEGATIVE_INFINITY);
  data.fill(Number.NaN);
  return {
    minima,
    maxima,
    gaps: new Uint8Array(bucketCount),
    data,
    variation: new Float32Array(bucketCount),
    previousBucket: -1,
    previousValue: Number.NaN,
  };
}

function finishAccumulator(accumulator: EnvelopeAccumulator, signal?: AbortSignal) {
  for (let bucket = 0; bucket < accumulator.data.length; bucket += 1) {
    if ((bucket & 0xfff) === 0) throwIfAborted(signal);
    const minimum = accumulator.minima[bucket];
    const maximum = accumulator.maxima[bucket];
    if (minimum === Number.POSITIVE_INFINITY || maximum === Number.NEGATIVE_INFINITY) {
      // A bucket finer than the source cadence can legitimately contain no
      // sample. Keep it neutral; only decoded non-finite values mark gaps.
      accumulator.minima[bucket] = Number.NaN;
      accumulator.maxima[bucket] = Number.NaN;
    } else {
      accumulator.data[bucket] = (minimum + maximum) / 2;
    }
  }
}

function selectedDisplaySignals(
  header: EDFHeader,
  channelIndices: readonly number[] | undefined,
  startSec: number,
  endSec: number,
  bucketCount: number,
) {
  const displaySignals = header.signals.filter((signal) => !signal.isAnnotation);
  const indices = channelIndices
    ? Array.from(channelIndices)
    : displaySignals.map((_, index) => index);
  const seen = new Set<number>();
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= displaySignals.length) {
      throw new RangeError(`EDF display channel index ${String(index)} is outside 0–${Math.max(0, displaySignals.length - 1)}.`);
    }
    if (seen.has(index)) throw new RangeError(`EDF display channel index ${index} was requested more than once.`);
    seen.add(index);
  }
  const selected: SelectedSignal[] = indices.map((index) => {
    const signal = displaySignals[index];
    const digitalSpan = signal.digitalMaximum - signal.digitalMinimum;
    const physicalSpan = signal.physicalMaximum - signal.physicalMinimum;
    const usePhysicalScaling = digitalSpan !== 0
      && physicalSpan !== 0
      && Number.isFinite(physicalSpan);
    const scale = usePhysicalScaling ? physicalSpan / digitalSpan : 1;
    const offset = usePhysicalScaling
      ? signal.physicalMinimum - signal.digitalMinimum * scale
      : 0;
    const normalization = normalizedPhysicalDimension(signal.physicalDimension);
    return {
      signal,
      firstSample: Math.floor(startSec * signal.sampleRate),
      endSample: Math.min(
        header.dataRecordCount * signal.samplesPerRecord,
        Math.ceil(endSec * signal.sampleRate),
      ),
      requestStartSample: startSec * signal.sampleRate,
      bucketScale: bucketCount / Math.max(Number.EPSILON, (endSec - startSec) * signal.sampleRate),
      scale,
      offset,
      unitScale: usePhysicalScaling ? normalization.scale : 1,
      unit: usePhysicalScaling ? normalization.unit : "count",
      accumulator: makeAccumulator(bucketCount),
    };
  });
  return { indices, selected };
}

function makeProgress(
  phase: EDFEnvelopeProgressPhase,
  metrics: EDFEnvelopeMetrics,
  startedAt: number,
): EDFEnvelopeProgress {
  return {
    phase,
    bytesRead: metrics.bytesRead,
    totalBytes: metrics.totalBytes,
    recordsRead: metrics.recordsRead,
    totalRecords: metrics.totalRecords,
    samplesDecoded: metrics.samplesDecoded,
    chunksRead: metrics.chunksRead,
    elapsedMs: nowMs() - startedAt,
    readMs: metrics.readMs,
    decodeMs: metrics.decodeMs,
    integrityMs: metrics.integrityMs,
  };
}

/**
 * Builds one exact min/max envelope. Supplying `onSourceChunk` plus the scan
 * flags lets a worker hash and/or index the EDF without a second file pass.
 */
export async function buildEDFEnvelopeWindow(
  request: EDFEnvelopeBuildRequest,
  hooks: EDFEnvelopeBuildHooks = {},
): Promise<EDFEnvelopeBuildResult> {
  validatePositiveInteger(request.bucketCount, "EDF envelope bucket count");
  if (request.pyramidMinimumBucketCount !== undefined) {
    validatePositiveInteger(
      request.pyramidMinimumBucketCount,
      "EDF envelope pyramid minimum bucket count",
    );
  }
  const chunkSizeBytes = request.chunkSizeBytes ?? DEFAULT_EDF_ENVELOPE_CHUNK_BYTES;
  validatePositiveInteger(chunkSizeBytes, "EDF envelope chunk size");
  if (!Number.isFinite(request.startSec)
    || !Number.isFinite(request.durationSec)
    || request.durationSec < 0) {
    throw new RangeError("EDF envelope window must use finite seconds and a non-negative duration.");
  }
  validatePositiveInteger(request.header.headerBytes, "EDF header byte count");
  validatePositiveInteger(request.header.bytesPerDataRecord, "EDF bytes per data record");
  if (!Number.isSafeInteger(request.header.dataRecordCount) || request.header.dataRecordCount < 0) {
    throw new RangeError("EDF data record count must be a non-negative safe integer.");
  }
  if (!(request.header.dataRecordDurationSec > 0)
    || !Number.isFinite(request.header.dataRecordDurationSec)) {
    throw new RangeError("EDF data record duration must be positive and finite.");
  }

  throwIfAborted(hooks.signal);
  const startedAt = nowMs();
  const recordingDuration = request.header.dataRecordCount * request.header.dataRecordDurationSec;
  const startSec = Math.min(Math.max(0, request.startSec), recordingDuration);
  const endSec = Math.min(recordingDuration, Math.max(startSec, request.startSec + request.durationSec));
  const durationSec = Math.max(0, endSec - startSec);
  const { indices, selected } = selectedDisplaySignals(
    request.header,
    request.channelIndices,
    startSec,
    endSec,
    request.bucketCount,
  );
  const requestedFirstRecord = Math.floor(startSec / request.header.dataRecordDurationSec);
  const requestedLastRecord = Math.min(
    request.header.dataRecordCount,
    Math.ceil(endSec / request.header.dataRecordDurationSec),
  );
  const scanAllRecords = Boolean(hooks.scanAllRecords || hooks.scanWholeBlob);
  const scanFirstRecord = scanAllRecords ? 0 : requestedFirstRecord;
  const scanLastRecord = scanAllRecords ? request.header.dataRecordCount : requestedLastRecord;
  const recordsPerChunk = Math.max(1, Math.floor(chunkSizeBytes / request.header.bytesPerDataRecord));
  const declaredDataEnd = request.header.headerBytes
    + request.header.dataRecordCount * request.header.bytesPerDataRecord;
  if (!Number.isSafeInteger(declaredDataEnd) || declaredDataEnd > request.blob.size) {
    throw new Error("EDF declared data records extend beyond the selected source file.");
  }
  const prefixBytes = hooks.scanWholeBlob ? Math.min(request.header.headerBytes, request.blob.size) : 0;
  const recordBytes = Math.max(0, scanLastRecord - scanFirstRecord) * request.header.bytesPerDataRecord;
  const suffixStart = Math.min(request.blob.size, declaredDataEnd);
  const suffixBytes = hooks.scanWholeBlob ? Math.max(0, request.blob.size - suffixStart) : 0;
  const metrics: EDFEnvelopeMetrics = {
    backend: hooks.backend ?? "direct",
    bytesRead: 0,
    totalBytes: prefixBytes + recordBytes + suffixBytes,
    recordsRead: 0,
    totalRecords: Math.max(0, scanLastRecord - scanFirstRecord),
    samplesDecoded: 0,
    chunksRead: 0,
    elapsedMs: 0,
    readMs: 0,
    decodeMs: 0,
    integrityMs: 0,
  };

  const readChunk = async (
    byteStart: number,
    byteEnd: number,
    section: EDFEnvelopeChunkSection,
    firstRecord?: number,
    recordCount?: number,
  ) => {
    throwIfAborted(hooks.signal);
    const readStartedAt = nowMs();
    const buffer = await request.blob.slice(byteStart, byteEnd).arrayBuffer();
    metrics.readMs += nowMs() - readStartedAt;
    throwIfAborted(hooks.signal);
    if (buffer.byteLength !== byteEnd - byteStart) {
      throw new Error(`EDF source ended while reading bytes ${byteStart}–${byteEnd}.`);
    }
    const bytes = new Uint8Array(buffer);
    metrics.bytesRead += bytes.byteLength;
    metrics.chunksRead += 1;
    hooks.onProgress?.(makeProgress("reading", metrics, startedAt));
    if (hooks.onSourceChunk) {
      const integrityStartedAt = nowMs();
      await hooks.onSourceChunk({ bytes, byteStart, byteEnd, section, firstRecord, recordCount });
      metrics.integrityMs += nowMs() - integrityStartedAt;
      throwIfAborted(hooks.signal);
    }
    return bytes;
  };

  if (hooks.scanWholeBlob) {
    for (let offset = 0; offset < prefixBytes; offset += chunkSizeBytes) {
      await readChunk(offset, Math.min(prefixBytes, offset + chunkSizeBytes), "prefix");
    }
  }

  if (durationSec > 0 || scanAllRecords) {
    for (let chunkRecord = scanFirstRecord; chunkRecord < scanLastRecord; chunkRecord += recordsPerChunk) {
      throwIfAborted(hooks.signal);
      const chunkEndRecord = Math.min(scanLastRecord, chunkRecord + recordsPerChunk);
      const byteStart = request.header.headerBytes + chunkRecord * request.header.bytesPerDataRecord;
      const byteEnd = request.header.headerBytes + chunkEndRecord * request.header.bytesPerDataRecord;
      const bytes = await readChunk(
        byteStart,
        byteEnd,
        "records",
        chunkRecord,
        chunkEndRecord - chunkRecord,
      );
      const view = HOST_IS_LITTLE_ENDIAN
        ? null
        : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const littleEndianSamples = HOST_IS_LITTLE_ENDIAN
        ? new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Int16Array.BYTES_PER_ELEMENT)
        : null;
      const decodeStartedAt = nowMs();
      const decodeFirstRecord = Math.max(chunkRecord, requestedFirstRecord);
      const decodeLastRecord = Math.min(chunkEndRecord, requestedLastRecord);
      for (let record = decodeFirstRecord; record < decodeLastRecord; record += 1) {
        const localRecordByte = (record - chunkRecord) * request.header.bytesPerDataRecord;
        for (const entry of selected) {
          const { signal, accumulator } = entry;
          const recordFirstSample = record * signal.samplesPerRecord;
          const copyFirst = Math.max(entry.firstSample, recordFirstSample);
          const copyEnd = Math.min(entry.endSample, recordFirstSample + signal.samplesPerRecord);
          for (let sample = copyFirst; sample < copyEnd; sample += 1) {
            if ((metrics.samplesDecoded & 0x3fff) === 0) throwIfAborted(hooks.signal);
            const bucket = Math.min(
              request.bucketCount - 1,
              Math.floor((sample - entry.requestStartSample) * entry.bucketScale),
            );
            if (bucket >= 0 && bucket < request.bucketCount) {
              const inRecord = sample - recordFirstSample;
              const sampleByteOffset = localRecordByte + signal.byteOffsetInRecord + inRecord * 2;
              const digital = littleEndianSamples
                ? littleEndianSamples[sampleByteOffset / Int16Array.BYTES_PER_ELEMENT]
                : view!.getInt16(sampleByteOffset, true);
              const value = (digital * entry.scale + entry.offset) * entry.unitScale;
              if (Number.isFinite(value)) {
                if (accumulator.previousBucket === bucket && Number.isFinite(accumulator.previousValue)) {
                  accumulator.variation[bucket] += Math.abs(value - accumulator.previousValue);
                }
                accumulator.previousBucket = bucket;
                accumulator.previousValue = value;
                if (value < accumulator.minima[bucket]) accumulator.minima[bucket] = value;
                if (value > accumulator.maxima[bucket]) accumulator.maxima[bucket] = value;
              } else {
                accumulator.gaps[bucket] = 1;
                accumulator.previousBucket = -1;
                accumulator.previousValue = Number.NaN;
              }
            }
            metrics.samplesDecoded += 1;
          }
        }
      }
      metrics.decodeMs += nowMs() - decodeStartedAt;
      metrics.recordsRead += chunkEndRecord - chunkRecord;
      hooks.onProgress?.(makeProgress("decoding", metrics, startedAt));
    }
  }

  if (hooks.scanWholeBlob) {
    for (let offset = suffixStart; offset < request.blob.size; offset += chunkSizeBytes) {
      await readChunk(offset, Math.min(request.blob.size, offset + chunkSizeBytes), "suffix");
    }
  }

  const finalizeStartedAt = nowMs();
  for (const entry of selected) finishAccumulator(entry.accumulator, hooks.signal);
  metrics.decodeMs += nowMs() - finalizeStartedAt;
  const effectiveRate = durationSec > 0 ? request.bucketCount / durationSec : 0;
  const window: EnvelopeWindowData = {
    data: selected.map((entry) => entry.accumulator.data),
    minima: selected.map((entry) => entry.accumulator.minima),
    maxima: selected.map((entry) => entry.accumulator.maxima),
    gaps: selected.map((entry) => entry.accumulator.gaps),
    variation: selected.map((entry) => entry.accumulator.variation),
    bucketDurationSec: durationSec > 0 ? durationSec / request.bucketCount : 0,
    sampleRates: selected.map(() => effectiveRate),
    channelStartSecs: selected.map(() => startSec),
    startSec,
    durationSec,
    channelIndices: indices,
    channelLabels: selected.map((entry) => entry.signal.label),
    channelUnits: selected.map((entry) => entry.unit),
  };
  let pyramidLevels: EnvelopeWindowData[] | undefined;
  if (request.pyramidMinimumBucketCount !== undefined) {
    const pyramidStartedAt = nowMs();
    pyramidLevels = buildEnvelopePyramid(window, request.pyramidMinimumBucketCount);
    metrics.decodeMs += nowMs() - pyramidStartedAt;
  }
  metrics.elapsedMs = nowMs() - startedAt;
  hooks.onProgress?.(makeProgress("complete", metrics, startedAt));
  return pyramidLevels
    ? { window, pyramidLevels, metrics }
    : { window, metrics };
}

/** Transfer every retained signal buffer exactly once when leaving a worker. */
export function edfEnvelopeTransferList(result: EDFEnvelopeBuildResult): ArrayBuffer[] {
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
