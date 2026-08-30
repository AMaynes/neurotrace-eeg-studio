/**
 * Overview & Purpose
 * Owns browser-side recording ingestion, signal-window access, display
 * filtering, montage construction, and signal-domain formatting.
 *
 * Architectural Relationships
 * Called by: app/page.tsx and signal-integrity tests.
 * Calls: Browser File/Blob, TextDecoder, DataView, and DecompressionStream APIs.
 *
 * External Resources
 * User-selected EDF/EDF+, MATLAB v5, and raw signed-int16 DAT files.
 *
 * Notes
 * This module has no Node.js dependencies. EDF and DAT remain file-backed and
 * are read with File.slice(); MAT v5 is decoded in memory because compressed
 * MATLAB elements are not independently seekable. All state is caller-owned.
 */


export type RecordingFormat =
  | "demo"
  | "edf"
  | "edf+"
  | "mat-v5"
  | "raw-int16-le";

export interface RecordingMeta {
  id: string;
  name: string;
  /** Compatibility alias used throughout the viewer UI. */
  fileName: string;
  format: RecordingFormat;
  durationSec: number;
  channelCount: number;
  channelLabels: string[];
  channelUnits: string[];
  /** Compatibility alias for channelUnits. */
  units: string[];
  sampleRates: number[];
  /** Nominal/default display rate (the first signal rate for mixed-rate EDF). */
  sampleRate: number;
  /** Conservative source-channel indices recommended for the initial display. */
  recommendedDisplayChannels?: number[];
  byteLength?: number;
  patientId?: string;
  recordingId?: string;
  startedAt?: Date;
  /** ISO timestamp compatibility alias for serializable exports. */
  startDateTime?: string;
  warnings: string[];
  assumptions?: string[];
  details?: Readonly<Record<string, string | number | boolean>>;
}

export interface WindowData {
  /** Channel-major physical samples. */
  data: Float32Array[];
  /** One sample rate for each returned channel. */
  sampleRates: number[];
  /** Absolute time of the first returned sample for each channel. */
  channelStartSecs: number[];
  startSec: number;
  durationSec: number;
  channelIndices: number[];
  channelLabels: string[];
  channelUnits: string[];
}

export interface SignalReadOptions {
  /** Stops a superseded file-backed read between bounded chunks. */
  signal?: AbortSignal;
}

/**
 * Screen-resolution extrema for a contiguous time window. Each bucket keeps
 * both polarities, so zoomed-out EEG does not alias a spike into an average.
 * `data` contains the bucket midpoint for cursor/readout compatibility.
 */
export interface EnvelopeWindowData extends WindowData {
  minima: Float32Array[];
  maxima: Float32Array[];
  gaps: Uint8Array[];
  bucketDurationSec: number;
}

export interface SignalSource {
  readonly meta: RecordingMeta;
  getWindow(
    startSec: number,
    durationSec: number,
    channelIndices?: readonly number[],
    options?: SignalReadOptions,
  ): Promise<WindowData>;
  getEnvelopeWindow?(
    startSec: number,
    durationSec: number,
    bucketCount: number,
    channelIndices?: readonly number[],
    options?: SignalReadOptions,
  ): Promise<EnvelopeWindowData>;
}

/** MATLAB's legacy DAT viewer separates neighboring raw traces by 15,000 ADC counts. */
export const LEGACY_RAW_COUNTS_PER_ROW = 15_000;

/**
 * Defense-in-depth for waveform drawing. Canvas clipping remains the primary
 * containment boundary, while this keeps even extreme path coordinates inside
 * the channel row and reports that the source excursion overflowed it.
 */
export function confineTraceYToRow(y: number, rowTop: number, rowHeight: number) {
  if (!Number.isFinite(rowTop) || !Number.isFinite(rowHeight) || !(rowHeight > 0)) {
    throw new Error("Trace row geometry must be finite with a positive height.");
  }
  const rowBottom = rowTop + rowHeight;
  if (!Number.isFinite(y)) {
    return {
      y: y === Number.NEGATIVE_INFINITY ? rowTop : y === Number.POSITIVE_INFINITY ? rowBottom : (rowTop + rowBottom) / 2,
      overflow: true,
    };
  }
  return {
    y: Math.min(rowBottom, Math.max(rowTop, y)),
    overflow: y < rowTop || y > rowBottom,
  };
}

export interface SourceEvent {
  label: string;
  timeSec: number;
  durationSec?: number;
  source: "edf+" | "mat";
}

export type SignalErrorCode =
  | "UNSUPPORTED_FORMAT"
  | "INVALID_HEADER"
  | "TRUNCATED_FILE"
  | "INVALID_WINDOW"
  | "DECOMPRESSION_UNAVAILABLE"
  | "NO_SIGNAL_MATRIX";

export class SignalFileError extends Error {
  readonly code: SignalErrorCode;

  constructor(code: SignalErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SignalFileError";
    this.code = code;
  }
}

interface NormalizedWindow {
  startSec: number;
  endSec: number;
  durationSec: number;
  channelIndices: number[];
}

function normalizeWindowRequest(
  meta: RecordingMeta,
  startSec: number,
  durationSec: number,
  requestedChannels?: readonly number[],
): NormalizedWindow {
  if (!Number.isFinite(startSec) || !Number.isFinite(durationSec) || durationSec < 0) {
    throw new SignalFileError(
      "INVALID_WINDOW",
      "The requested signal window must use finite seconds and a non-negative duration.",
    );
  }

  const start = Math.min(Math.max(0, startSec), meta.durationSec);
  const end = Math.min(meta.durationSec, Math.max(start, startSec + durationSec));
  const channels = requestedChannels
    ? Array.from(requestedChannels)
    : Array.from({ length: meta.channelCount }, (_, index) => index);
  const seen = new Set<number>();

  for (const index of channels) {
    if (!Number.isInteger(index) || index < 0 || index >= meta.channelCount) {
      throw new SignalFileError(
        "INVALID_WINDOW",
        `Channel index ${String(index)} is outside 0–${Math.max(0, meta.channelCount - 1)}.`,
      );
    }
    if (seen.has(index)) {
      throw new SignalFileError(
        "INVALID_WINDOW",
        `Channel index ${index} was requested more than once.`,
      );
    }
    seen.add(index);
  }

  return {
    startSec: start,
    endSec: end,
    durationSec: Math.max(0, end - start),
    channelIndices: channels,
  };
}

function makeWindowResult(
  meta: RecordingMeta,
  request: NormalizedWindow,
  data: Float32Array[],
  sampleRates?: number[],
  channelStartSecs?: number[],
): WindowData {
  return {
    data,
    sampleRates: sampleRates ?? request.channelIndices.map((index) => meta.sampleRates[index]),
    channelStartSecs: channelStartSecs ?? request.channelIndices.map(() => request.startSec),
    startSec: request.startSec,
    durationSec: request.durationSec,
    channelIndices: request.channelIndices,
    channelLabels: request.channelIndices.map((index) => meta.channelLabels[index]),
    channelUnits: request.channelIndices.map((index) => meta.channelUnits[index]),
  };
}

// ---------------------------------------------------------------------------
// Deterministic synthetic source
// ---------------------------------------------------------------------------

export interface DemoSourceOptions {
  name?: string;
  durationSec?: number;
  sampleRate?: number;
  channelLabels?: readonly string[];
  lineFrequency?: 50 | 60;
}

const DEFAULT_DEMO_LABELS = [
  "LAH1",
  "LAH2",
  "LAH3",
  "LAH4",
  "LPH1",
  "LPH2",
  "LPH3",
  "LPH4",
  "RAH1",
  "RAH2",
  "RAH3",
  "RAH4",
  "RPH1",
  "RPH2",
  "RPH3",
  "RPH4",
] as const;

function integerNoise(sampleIndex: number, channelIndex: number, salt = 0): number {
  let value = (sampleIndex | 0) ^ Math.imul(channelIndex + 1, 0x9e3779b1) ^ salt;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  value ^= value >>> 15;
  return (value >>> 0) / 0xffffffff * 2 - 1;
}

function smoothPulse(time: number, start: number, end: number, ramp = 2): number {
  if (time <= start || time >= end) return 0;
  const rise = Math.min(1, (time - start) / ramp);
  const fall = Math.min(1, (end - time) / ramp);
  return Math.sin(Math.min(rise, fall) * Math.PI * 0.5) ** 2;
}

export class DemoSource implements SignalSource {
  readonly meta: RecordingMeta;
  private readonly lineFrequency: 50 | 60;

  constructor(options: DemoSourceOptions = {}) {
    const durationSec = options.durationSec ?? 2 * 60 * 60;
    const sampleRate = options.sampleRate ?? 256;
    const labels = Array.from(options.channelLabels ?? DEFAULT_DEMO_LABELS);
    if (!(durationSec > 0) || !(sampleRate > 0) || labels.length === 0) {
      throw new Error("DemoSource requires a positive duration, sample rate, and at least one channel.");
    }
    this.lineFrequency = options.lineFrequency ?? 60;
    this.meta = {
      id: deterministicId(`${options.name ?? "NeuroScope demonstration"}:${durationSec}:${sampleRate}:${labels.join("|")}`, "rec"),
      name: options.name ?? "NeuroScope demonstration",
      fileName: options.name ?? "NeuroScope demonstration",
      format: "demo",
      durationSec,
      channelCount: labels.length,
      channelLabels: labels,
      channelUnits: labels.map(() => "µV"),
      units: labels.map(() => "µV"),
      sampleRates: labels.map(() => sampleRate),
      sampleRate,
      patientId: "P1027",
      recordingId: "demo-seeg-2025-05-01-01",
      startedAt: new Date("2025-05-01T00:00:00Z"),
      startDateTime: "2025-05-01T00:00:00.000Z",
      warnings: [],
      details: {
        generator: "Deterministic synthetic SEEG with seizure and artifact events",
        lineFrequencyHz: this.lineFrequency,
      },
    };
  }

  async getWindow(
    startSec: number,
    durationSec: number,
    channelIndices?: readonly number[],
    options: SignalReadOptions = {},
  ): Promise<WindowData> {
    throwIfSignalReadAborted(options.signal);
    const request = normalizeWindowRequest(this.meta, startSec, durationSec, channelIndices);
    const sampleRates = request.channelIndices.map((index) => this.meta.sampleRates[index]);
    const data = request.channelIndices.map((channelIndex, outputIndex) => {
      const sampleRate = sampleRates[outputIndex];
      const firstSample = Math.floor(request.startSec * sampleRate);
      const lastSample = Math.ceil(request.endSec * sampleRate);
      const samples = new Float32Array(Math.max(0, lastSample - firstSample));
      const phase = channelIndex * 0.41;
      const hemisphereWeight = channelIndex < this.meta.channelCount / 2 ? 1 : 0.72;

      for (let offset = 0; offset < samples.length; offset += 1) {
        const absoluteSample = firstSample + offset;
        const time = absoluteSample / sampleRate;
        const slow = 13 * Math.sin(2 * Math.PI * 1.15 * time + phase);
        const alpha = 7 * Math.sin(2 * Math.PI * (9.2 + channelIndex * 0.035) * time + phase * 2);
        const beta = 3.2 * Math.sin(2 * Math.PI * 21.5 * time + phase * 0.7);
        const line = 1.4 * Math.sin(2 * Math.PI * this.lineFrequency * time + phase);
        const noise = 5.5 * integerNoise(absoluteSample, channelIndex);
        const colored = 2.2 * integerNoise(Math.floor(absoluteSample / 3), channelIndex, 0x51633e2d);

        // Two repeating electrographic events make arbitrary demo windows useful.
        const cycleTime = ((time % 300) + 300) % 300;
        const ictalEnvelope = smoothPulse(cycleTime, 156, 175, 2.5);
        const ictalFrequency = 4.5 + Math.max(0, cycleTime - 156) * 0.34;
        const ictal =
          ictalEnvelope * hemisphereWeight *
          (68 * Math.sin(2 * Math.PI * ictalFrequency * time + phase) +
            25 * Math.sin(2 * Math.PI * ictalFrequency * 2.03 * time));
        const postIctal = smoothPulse(cycleTime, 175, 205, 5) *
          24 * Math.sin(2 * Math.PI * 1.7 * time + phase);
        const artifactCenter = 155 + (channelIndex % 4) * 0.04;
        const artifactDistance = Math.abs(cycleTime - artifactCenter);
        const artifact = artifactDistance < 0.18
          ? (1 - artifactDistance / 0.18) * 180 * (channelIndex % 2 === 0 ? 1 : -1)
          : 0;

        samples[offset] = slow + alpha + beta + line + noise + colored + ictal + postIctal + artifact;
      }
      return samples;
    });

    // Yield once for large synthetic windows so React can paint pending UI.
    if (data.some((channel) => channel.length > 250_000)) await Promise.resolve();
    return makeWindowResult(
      this.meta,
      request,
      data,
      sampleRates,
      sampleRates.map((sampleRate) => Math.floor(request.startSec * sampleRate) / sampleRate),
    );
  }
}

// ---------------------------------------------------------------------------
// EDF / EDF+ parsing and streamed reads
// ---------------------------------------------------------------------------

export interface EDFSignalHeader {
  index: number;
  label: string;
  transducer: string;
  physicalDimension: string;
  physicalMinimum: number;
  physicalMaximum: number;
  digitalMinimum: number;
  digitalMaximum: number;
  prefilter: string;
  samplesPerRecord: number;
  sampleRate: number;
  reserved: string;
  isAnnotation: boolean;
  byteOffsetInRecord: number;
}

export interface EDFHeader {
  version: string;
  patientIdentification: string;
  recordingIdentification: string;
  startDateText: string;
  startTimeText: string;
  startedAt?: Date;
  headerBytes: number;
  reserved: string;
  declaredDataRecordCount: number;
  dataRecordCount: number;
  dataRecordDurationSec: number;
  signalCount: number;
  signals: EDFSignalHeader[];
  bytesPerDataRecord: number;
  isEDFPlus: boolean;
  isDiscontinuous: boolean;
  warnings: string[];
}

const latin1Decoder = new TextDecoder("windows-1252");
const utf8Decoder = new TextDecoder("utf-8");

export interface EDFUnitNormalization {
  /** Unit exposed to the display and exported window metadata. */
  unit: string;
  /** Multiplier applied after EDF digital-to-physical calibration. */
  scale: number;
  isVoltage: boolean;
}

/**
 * Normalizes common EDF voltage dimensions to microvolts. EDF allows a free
 * text physical-dimension field, so unknown and non-voltage units are kept
 * verbatim rather than guessed.
 */
export function normalizeEDFPhysicalDimension(dimension: string): EDFUnitNormalization {
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
    ? { unit: preserved, scale: 1, isVoltage: false }
    : { unit: "µV", scale, isVoltage: true };
}

function hasUsableEDFCalibration(signal: EDFSignalHeader): boolean {
  return signal.digitalMaximum !== signal.digitalMinimum
    && signal.physicalMaximum !== signal.physicalMinimum;
}

function decodeFixed(bytes: Uint8Array, start: number, length: number): string {
  return latin1Decoder.decode(bytes.subarray(start, start + length)).replace(/\0/g, "").trim();
}

function parseFiniteNumber(text: string, field: string): number {
  const value = Number(text.trim());
  if (!Number.isFinite(value)) {
    throw new SignalFileError("INVALID_HEADER", `EDF ${field} is not a valid number: "${text}".`);
  }
  return value;
}

function parseInteger(text: string, field: string): number {
  const value = parseFiniteNumber(text, field);
  if (!Number.isInteger(value)) {
    throw new SignalFileError("INVALID_HEADER", `EDF ${field} must be an integer; received ${text}.`);
  }
  return value;
}

function parseEDFDate(dateText: string, timeText: string): Date | undefined {
  const dateMatch = /^(\d{2})\.(\d{2})\.(\d{2})$/.exec(dateText.trim());
  const timeMatch = /^(\d{2})\.(\d{2})\.(\d{2})$/.exec(timeText.trim());
  if (!dateMatch || !timeMatch) return undefined;
  const shortYear = Number(dateMatch[3]);
  const year = shortYear >= 85 ? 1900 + shortYear : 2000 + shortYear;
  const date = new Date(Date.UTC(
    year,
    Number(dateMatch[2]) - 1,
    Number(dateMatch[1]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    Number(timeMatch[3]),
  ));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function readEDFSignalField(
  bytes: Uint8Array,
  offset: number,
  width: number,
  signalCount: number,
): string[] {
  return Array.from({ length: signalCount }, (_, index) =>
    decodeFixed(bytes, offset + index * width, width),
  );
}

export async function parseEDFHeader(file: File): Promise<EDFHeader> {
  if (file.size < 256) {
    throw new SignalFileError("TRUNCATED_FILE", "This EDF file is shorter than its 256-byte fixed header.");
  }
  const fixedBytes = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  const version = decodeFixed(fixedBytes, 0, 8);
  if (version !== "0" && version !== "0.0") {
    throw new SignalFileError(
      "UNSUPPORTED_FORMAT",
      `Unsupported EDF version "${version || "blank"}". This viewer supports EDF and EDF+ files with version 0.`,
    );
  }

  const patientIdentification = decodeFixed(fixedBytes, 8, 80);
  const recordingIdentification = decodeFixed(fixedBytes, 88, 80);
  const startDateText = decodeFixed(fixedBytes, 168, 8);
  const startTimeText = decodeFixed(fixedBytes, 176, 8);
  const headerBytes = parseInteger(decodeFixed(fixedBytes, 184, 8), "header byte count");
  const reserved = decodeFixed(fixedBytes, 192, 44);
  if (reserved.toUpperCase().startsWith("EDF+D")) {
    throw new SignalFileError(
      "UNSUPPORTED_FORMAT",
      "EDF+D discontinuous recordings are not yet supported because flattening record gaps would make waveform and annotation times disagree. Convert to continuous EDF+C or preserve the discontinuity timeline before review.",
    );
  }
  const declaredDataRecordCount = parseInteger(
    decodeFixed(fixedBytes, 236, 8),
    "data record count",
  );
  const dataRecordDurationSec = parseFiniteNumber(
    decodeFixed(fixedBytes, 244, 8),
    "data record duration",
  );
  const signalCount = parseInteger(decodeFixed(fixedBytes, 252, 4), "signal count");

  if (signalCount <= 0 || signalCount > 65_535) {
    throw new SignalFileError("INVALID_HEADER", `EDF signal count ${signalCount} is outside the supported range.`);
  }
  const minimumHeaderBytes = 256 + signalCount * 256;
  if (headerBytes < minimumHeaderBytes || headerBytes > file.size) {
    throw new SignalFileError(
      headerBytes > file.size ? "TRUNCATED_FILE" : "INVALID_HEADER",
      `EDF header declares ${headerBytes} bytes; at least ${minimumHeaderBytes} are required for ${signalCount} signals.`,
    );
  }
  if (!(dataRecordDurationSec > 0)) {
    throw new SignalFileError("INVALID_HEADER", "EDF data record duration must be greater than zero.");
  }
  if (declaredDataRecordCount < -1) {
    throw new SignalFileError("INVALID_HEADER", "EDF data record count may only be -1 when it is unknown.");
  }

  const bytes = new Uint8Array(await file.slice(0, headerBytes).arrayBuffer());
  let offset = 256;
  const labels = readEDFSignalField(bytes, offset, 16, signalCount); offset += 16 * signalCount;
  const transducers = readEDFSignalField(bytes, offset, 80, signalCount); offset += 80 * signalCount;
  const dimensions = readEDFSignalField(bytes, offset, 8, signalCount); offset += 8 * signalCount;
  const physicalMins = readEDFSignalField(bytes, offset, 8, signalCount); offset += 8 * signalCount;
  const physicalMaxes = readEDFSignalField(bytes, offset, 8, signalCount); offset += 8 * signalCount;
  const digitalMins = readEDFSignalField(bytes, offset, 8, signalCount); offset += 8 * signalCount;
  const digitalMaxes = readEDFSignalField(bytes, offset, 8, signalCount); offset += 8 * signalCount;
  const prefilters = readEDFSignalField(bytes, offset, 80, signalCount); offset += 80 * signalCount;
  const samplesPerRecords = readEDFSignalField(bytes, offset, 8, signalCount); offset += 8 * signalCount;
  const signalReserved = readEDFSignalField(bytes, offset, 32, signalCount);

  const warnings: string[] = [];
  let byteOffsetInRecord = 0;
  const signals = labels.map((label, index): EDFSignalHeader => {
    const physicalMinimum = parseFiniteNumber(physicalMins[index], `physical minimum for ${label || `signal ${index + 1}`}`);
    const physicalMaximum = parseFiniteNumber(physicalMaxes[index], `physical maximum for ${label || `signal ${index + 1}`}`);
    const digitalMinimum = parseInteger(digitalMins[index], `digital minimum for ${label || `signal ${index + 1}`}`);
    const digitalMaximum = parseInteger(digitalMaxes[index], `digital maximum for ${label || `signal ${index + 1}`}`);
    const samplesPerRecord = parseInteger(samplesPerRecords[index], `samples per record for ${label || `signal ${index + 1}`}`);
    if (samplesPerRecord <= 0) {
      throw new SignalFileError("INVALID_HEADER", `EDF signal "${label || index + 1}" has no samples per data record.`);
    }
    if (digitalMaximum === digitalMinimum) {
      warnings.push(`Signal "${label || index + 1}" has identical digital minimum and maximum; raw digital values will be shown.`);
    }
    if (physicalMaximum === physicalMinimum) {
      warnings.push(`Signal "${label || index + 1}" has identical physical minimum and maximum; raw digital values will be shown because its physical calibration is invalid.`);
    }
    const signal: EDFSignalHeader = {
      index,
      label: label || `Signal ${index + 1}`,
      transducer: transducers[index],
      physicalDimension: dimensions[index] || "a.u.",
      physicalMinimum,
      physicalMaximum,
      digitalMinimum,
      digitalMaximum,
      prefilter: prefilters[index],
      samplesPerRecord,
      sampleRate: samplesPerRecord / dataRecordDurationSec,
      reserved: signalReserved[index],
      isAnnotation: /^EDF Annotations$/i.test(label.trim()),
      byteOffsetInRecord,
    };
    byteOffsetInRecord += samplesPerRecord * 2;
    return signal;
  });

  const bytesPerDataRecord = byteOffsetInRecord;
  const availableDataBytes = file.size - headerBytes;
  const completeRecords = Math.floor(availableDataBytes / bytesPerDataRecord);
  let dataRecordCount = declaredDataRecordCount === -1 ? completeRecords : declaredDataRecordCount;
  if (declaredDataRecordCount === -1) {
    warnings.push(`EDF record count was unknown (-1); inferred ${completeRecords} complete records from file size.`);
  } else if (declaredDataRecordCount > completeRecords) {
    throw new SignalFileError(
      "TRUNCATED_FILE",
      `EDF declares ${declaredDataRecordCount} records but only ${completeRecords} complete records are present.`,
    );
  } else if (declaredDataRecordCount < completeRecords) {
    warnings.push(`${completeRecords - declaredDataRecordCount} trailing complete data record(s) are not part of the declared EDF recording.`);
    dataRecordCount = declaredDataRecordCount;
  }
  const remainder = availableDataBytes - completeRecords * bytesPerDataRecord;
  if (remainder > 0) warnings.push(`Ignored ${remainder} trailing byte(s) after the last complete EDF data record.`);

  const upperReserved = reserved.toUpperCase();
  const isEDFPlus = upperReserved.startsWith("EDF+C") || upperReserved.startsWith("EDF+D") || signals.some((signal) => signal.isAnnotation);
  const isDiscontinuous = upperReserved.startsWith("EDF+D");

  return {
    version,
    patientIdentification,
    recordingIdentification,
    startDateText,
    startTimeText,
    startedAt: parseEDFDate(startDateText, startTimeText),
    headerBytes,
    reserved,
    declaredDataRecordCount,
    dataRecordCount,
    dataRecordDurationSec,
    signalCount,
    signals,
    bytesPerDataRecord,
    isEDFPlus,
    isDiscontinuous,
    warnings,
  };
}

/** Alias for callers that prefer conventional mixed-case naming. */
export const parseEdfHeader = parseEDFHeader;

export function parseEdfTalText(text: string): SourceEvent[] {
  const events: SourceEvent[] = [];
  for (const tal of text.split("\0")) {
    if (!tal) continue;
    const annotationSeparator = tal.indexOf("\x14");
    if (annotationSeparator < 0) continue;
    const timing = tal.slice(0, annotationSeparator);
    const [onsetText, durationText] = timing.split("\x15", 2);
    const timeSec = Number(onsetText);
    const durationSec = durationText ? Number(durationText) : undefined;
    if (!Number.isFinite(timeSec)) continue;
    const labels = tal.slice(annotationSeparator + 1).split("\x14").map((label) => label.trim()).filter(Boolean);
    for (const label of labels) {
      events.push({
        label,
        timeSec,
        durationSec: durationSec !== undefined && Number.isFinite(durationSec) && durationSec >= 0 ? durationSec : undefined,
        source: "edf+",
      });
    }
  }
  return events;
}

export async function parseEDFAnnotations(
  file: File,
  header: EDFHeader,
  options: SignalReadOptions = {},
): Promise<{ events: SourceEvent[]; warnings: string[] }> {
  const annotationSignals = header.signals.filter((signal) => signal.isAnnotation);
  if (!annotationSignals.length) return { events: [], warnings: [] };
  const events: SourceEvent[] = [];
  const warnings: string[] = [];
  const recordsPerChunk = Math.max(1, Math.floor((4 * 1024 * 1024) / Math.max(1, header.bytesPerDataRecord)));
  throwIfSignalReadAborted(options.signal);

  for (let firstRecord = 0; firstRecord < header.dataRecordCount; firstRecord += recordsPerChunk) {
    throwIfSignalReadAborted(options.signal);
    const recordCount = Math.min(recordsPerChunk, header.dataRecordCount - firstRecord);
    const byteStart = header.headerBytes + firstRecord * header.bytesPerDataRecord;
    const byteEnd = byteStart + recordCount * header.bytesPerDataRecord;
    const bytes = new Uint8Array(await file.slice(byteStart, byteEnd).arrayBuffer());
    throwIfSignalReadAborted(options.signal);
    for (let localRecord = 0; localRecord < recordCount; localRecord += 1) {
      const recordOffset = localRecord * header.bytesPerDataRecord;
      for (const signal of annotationSignals) {
        const start = recordOffset + signal.byteOffsetInRecord;
        const end = start + signal.samplesPerRecord * 2;
        events.push(...parseEdfTalText(utf8Decoder.decode(bytes.subarray(start, end))));
      }
    }
  }

  const deduplicated = new Map<string, SourceEvent>();
  for (const event of events) {
    const key = `${event.timeSec.toFixed(9)}\0${event.durationSec ?? ""}\0${event.label}`;
    if (!deduplicated.has(key)) deduplicated.set(key, event);
  }
  if (!deduplicated.size) {
    warnings.push("EDF+ annotation channel contained no non-timekeeping text annotations.");
  }
  return { events: [...deduplicated.values()].sort((a, b) => a.timeSec - b.timeSec || a.label.localeCompare(b.label)), warnings };
}

const MAX_RECOMMENDED_DISPLAY_CHANNELS = 18;
const MAX_PLAUSIBLE_EEG_SPAN_UV = 100_000;

function isObviousAuxiliaryEDFSignal(signal: EDFSignalHeader): boolean {
  const label = signal.label
    .trim()
    .replace(/^EEG\s+/i, "")
    .replace(/(?:[-_\s]+(?:REF|LE|AR|AVG))$/i, "")
    .trim();
  return /^(?:BIO|MISC)(?:\s|$)/i.test(signal.label.trim())
    || /^(?:AUX|ECG|EKG|EMG|EOG|RESP|RESPIRATION|TRIG|TRIGGER|DC\d*|E|ABD|SPO2|ETCO2|PULSE|CO2WAVE)$/i.test(label);
}

function isLikelyEEGEDFSignal(signal: EDFSignalHeader): boolean {
  if (/^EEG(?:\s|$)/i.test(signal.label.trim())) return true;
  const label = signal.label
    .trim()
    .replace(/(?:[-_\s]+(?:REF|LE|AR|AVG))$/i, "")
    .replace(/[\s_-]/g, "");
  return /^(?:FP\d|FPZ|F\d|FZ|FC\d|C\d|CZ|T\d|TP\d|P\d|PZ|O\d|OZ|A\d|M\d)$/i.test(label)
    || /^[A-Z]{1,6}\d{1,3}$/i.test(label);
}

function recommendEDFDisplayChannels(
  displaySignals: readonly EDFSignalHeader[],
  unitScaleBySignalIndex: readonly number[],
  warnings: string[],
): number[] {
  const suspiciousCalibration: string[] = [];
  const candidates = displaySignals.map((signal, displayIndex) => {
    const normalization = normalizeEDFPhysicalDimension(signal.physicalDimension);
    const calibrated = hasUsableEDFCalibration(signal);
    const normalizedSpan = Math.abs(signal.physicalMaximum - signal.physicalMinimum)
      * unitScaleBySignalIndex[signal.index];
    const plausibleSpan = calibrated && (!normalization.isVoltage || normalizedSpan <= MAX_PLAUSIBLE_EEG_SPAN_UV);
    if (calibrated && normalization.isVoltage && !plausibleSpan) suspiciousCalibration.push(signal.label);
    return {
      displayIndex,
      isVoltage: normalization.isVoltage,
      isLikelyEEG: isLikelyEEGEDFSignal(signal),
      isAuxiliary: isObviousAuxiliaryEDFSignal(signal),
      calibrated,
      plausibleSpan,
    };
  });

  if (suspiciousCalibration.length) {
    warnings.push(
      `Initial display recommendation omitted ${suspiciousCalibration.length} channel(s) with normalized physical spans above ${MAX_PLAUSIBLE_EEG_SPAN_UV.toLocaleString("en-US")} µV: ${suspiciousCalibration.join(", ")}. They remain available in the channel list; verify their calibration before use.`,
    );
  }

  const safe = candidates.filter((candidate) => candidate.calibrated && !candidate.isAuxiliary && candidate.plausibleSpan);
  if (!safe.length) {
    warnings.push("No channels met the conservative initial-display calibration and signal-type checks; no channels were selected automatically. Every source channel remains available for manual review.");
    return [];
  }
  const preferredVoltageEEG = safe.filter((candidate) => candidate.isVoltage && candidate.isLikelyEEG);
  const preferredVoltage = safe.filter((candidate) => candidate.isVoltage);
  const recommendation = preferredVoltageEEG.length
    ? preferredVoltageEEG
    : preferredVoltage.length
      ? preferredVoltage
      : safe;
  return recommendation
    .slice(0, MAX_RECOMMENDED_DISPLAY_CHANNELS)
    .map((candidate) => candidate.displayIndex);
}

export interface EDFSourceOptions {
  /** Defaults to true. Large interactive imports can defer this full-file pass. */
  parseAnnotations?: boolean;
}

export class EDFSource implements SignalSource {
  readonly meta: RecordingMeta;
  readonly header: EDFHeader;
  readonly events: SourceEvent[];
  private readonly file: File;
  private readonly displaySignals: EDFSignalHeader[];
  private readonly physicalUnitScaleBySignalIndex: number[];
  private annotationsLoaded: boolean;
  private annotationLoadPromise: Promise<readonly SourceEvent[]> | null = null;

  private constructor(
    file: File,
    header: EDFHeader,
    events: SourceEvent[],
    annotationWarnings: string[],
    annotationsLoaded: boolean,
  ) {
    this.file = file;
    this.header = header;
    this.events = events;
    this.annotationsLoaded = annotationsLoaded;
    this.displaySignals = header.signals.filter((signal) => !signal.isAnnotation);
    this.physicalUnitScaleBySignalIndex = header.signals.map(
      (signal) => normalizeEDFPhysicalDimension(signal.physicalDimension).scale,
    );
    if (this.displaySignals.length === 0) {
      throw new SignalFileError("INVALID_HEADER", "The EDF contains an annotation channel but no displayable signal channels.");
    }
    const warnings = [...header.warnings, ...annotationWarnings];
    const recommendedDisplayChannels = recommendEDFDisplayChannels(
      this.displaySignals,
      this.physicalUnitScaleBySignalIndex,
      warnings,
    );
    const channelUnits = this.displaySignals.map((signal) =>
      !hasUsableEDFCalibration(signal)
        ? "count"
        : normalizeEDFPhysicalDimension(signal.physicalDimension).unit);
    this.meta = {
      id: deterministicId(`${file.name}:${file.size}:${file.lastModified}`, "rec"),
      name: file.name,
      fileName: file.name,
      format: header.isEDFPlus ? "edf+" : "edf",
      durationSec: header.dataRecordCount * header.dataRecordDurationSec,
      channelCount: this.displaySignals.length,
      channelLabels: this.displaySignals.map((signal) => signal.label),
      channelUnits,
      units: channelUnits,
      sampleRates: this.displaySignals.map((signal) => signal.sampleRate),
      sampleRate: this.displaySignals[0].sampleRate,
      recommendedDisplayChannels,
      byteLength: file.size,
      patientId: header.patientIdentification.split(/\s+/)[0] || undefined,
      recordingId: header.recordingIdentification || undefined,
      startedAt: header.startedAt,
      startDateTime: header.startedAt?.toISOString(),
      warnings,
      assumptions: header.startedAt ? ["EDF start clock timezone is not specified; preserved as source-local wall time."] : [],
      details: {
        dataRecords: header.dataRecordCount,
        dataRecordDurationSec: header.dataRecordDurationSec,
        annotationChannels: header.signals.filter((signal) => signal.isAnnotation).length,
        discontinuous: header.isDiscontinuous,
      },
    };
  }

  static async create(file: File, options: EDFSourceOptions = {}): Promise<EDFSource> {
    const header = await parseEDFHeader(file);
    const shouldParseAnnotations = options.parseAnnotations !== false;
    const annotations = shouldParseAnnotations
      ? await parseEDFAnnotations(file, header)
      : { events: [], warnings: [] };
    return new EDFSource(file, header, annotations.events, annotations.warnings, shouldParseAnnotations);
  }

  async loadAnnotations(options: SignalReadOptions = {}): Promise<readonly SourceEvent[]> {
    if (this.annotationsLoaded) return this.events;
    if (this.annotationLoadPromise) return this.annotationLoadPromise;
    this.annotationLoadPromise = parseEDFAnnotations(this.file, this.header, options)
      .then((annotations) => {
        this.events.splice(0, this.events.length, ...annotations.events);
        for (const warning of annotations.warnings) {
          if (!this.meta.warnings.includes(warning)) this.meta.warnings.push(warning);
        }
        this.annotationsLoaded = true;
        return this.events;
      })
      .catch((error) => {
        this.annotationLoadPromise = null;
        throw error;
      });
    return this.annotationLoadPromise;
  }

  applyVerifiedAnnotations(events: readonly SourceEvent[], warnings: readonly string[] = []) {
    this.events.splice(0, this.events.length, ...events);
    for (const warning of warnings) {
      if (!this.meta.warnings.includes(warning)) this.meta.warnings.push(warning);
    }
    this.annotationsLoaded = true;
    this.annotationLoadPromise = Promise.resolve(this.events);
  }

  async getWindow(
    startSec: number,
    durationSec: number,
    channelIndices?: readonly number[],
    options: SignalReadOptions = {},
  ): Promise<WindowData> {
    throwIfSignalReadAborted(options.signal);
    const request = normalizeWindowRequest(this.meta, startSec, durationSec, channelIndices);
    const selected = request.channelIndices.map((index) => this.displaySignals[index]);
    const sampleRanges = selected.map((signal) => {
      const first = Math.floor(request.startSec * signal.sampleRate);
      const end = Math.min(
        this.header.dataRecordCount * signal.samplesPerRecord,
        Math.ceil(request.endSec * signal.sampleRate),
      );
      return { first, end, output: new Float32Array(Math.max(0, end - first)) };
    });
    if (request.durationSec === 0 || selected.length === 0) {
      return makeWindowResult(
        this.meta,
        request,
        sampleRanges.map((range) => range.output),
        selected.map((signal) => signal.sampleRate),
        sampleRanges.map((range, index) => range.first / selected[index].sampleRate),
      );
    }

    const firstRecord = Math.floor(request.startSec / this.header.dataRecordDurationSec);
    const lastRecordExclusive = Math.min(
      this.header.dataRecordCount,
      Math.ceil(request.endSec / this.header.dataRecordDurationSec),
    );
    // Keep slices moderate while still amortizing File/Blob overhead.
    const recordsPerChunk = Math.max(1, Math.floor((8 * 1024 * 1024) / this.header.bytesPerDataRecord));

    for (let chunkRecord = firstRecord; chunkRecord < lastRecordExclusive; chunkRecord += recordsPerChunk) {
      throwIfSignalReadAborted(options.signal);
      const chunkEndRecord = Math.min(lastRecordExclusive, chunkRecord + recordsPerChunk);
      const byteStart = this.header.headerBytes + chunkRecord * this.header.bytesPerDataRecord;
      const byteEnd = this.header.headerBytes + chunkEndRecord * this.header.bytesPerDataRecord;
      const view = new DataView(await this.file.slice(byteStart, byteEnd).arrayBuffer());
      throwIfSignalReadAborted(options.signal);

      for (let record = chunkRecord; record < chunkEndRecord; record += 1) {
        const localRecordByte = (record - chunkRecord) * this.header.bytesPerDataRecord;
        selected.forEach((signal, selectedIndex) => {
          const range = sampleRanges[selectedIndex];
          const recordFirstSample = record * signal.samplesPerRecord;
          const copyFirst = Math.max(range.first, recordFirstSample);
          const copyEnd = Math.min(range.end, recordFirstSample + signal.samplesPerRecord);
          if (copyEnd <= copyFirst) return;

          const digitalSpan = signal.digitalMaximum - signal.digitalMinimum;
          const physicalSpan = signal.physicalMaximum - signal.physicalMinimum;
          const usePhysicalScaling = digitalSpan !== 0
            && physicalSpan !== 0
            && Number.isFinite(physicalSpan);
          const scale = usePhysicalScaling ? physicalSpan / digitalSpan : 1;
          const offset = usePhysicalScaling
            ? signal.physicalMinimum - signal.digitalMinimum * scale
            : 0;
          const unitScale = usePhysicalScaling
            ? this.physicalUnitScaleBySignalIndex[signal.index]
            : 1;
          for (let sample = copyFirst; sample < copyEnd; sample += 1) {
            const inRecord = sample - recordFirstSample;
            const digital = view.getInt16(
              localRecordByte + signal.byteOffsetInRecord + inRecord * 2,
              true,
            );
            range.output[sample - range.first] = (digital * scale + offset) * unitScale;
          }
        });
      }
    }

    return makeWindowResult(
      this.meta,
      request,
      sampleRanges.map((range) => range.output),
      selected.map((signal) => signal.sampleRate),
      sampleRanges.map((range, index) => range.first / selected[index].sampleRate),
    );
  }

  async getEnvelopeWindow(
    startSec: number,
    durationSec: number,
    bucketCount: number,
    channelIndices?: readonly number[],
    options: SignalReadOptions = {},
  ): Promise<EnvelopeWindowData> {
    validateEnvelopeBucketCount(bucketCount);
    throwIfSignalReadAborted(options.signal);
    const request = normalizeWindowRequest(this.meta, startSec, durationSec, channelIndices);
    const selected = request.channelIndices.map((index) => this.displaySignals[index]);
    const accumulators = selected.map(() => makeEnvelopeAccumulator(bucketCount));
    if (request.durationSec === 0 || selected.length === 0) {
      return makeEnvelopeWindowResult(this.meta, request, accumulators, bucketCount);
    }

    const firstRecord = Math.floor(request.startSec / this.header.dataRecordDurationSec);
    const lastRecordExclusive = Math.min(
      this.header.dataRecordCount,
      Math.ceil(request.endSec / this.header.dataRecordDurationSec),
    );
    const recordsPerChunk = Math.max(1, Math.floor((4 * 1024 * 1024) / this.header.bytesPerDataRecord));

    for (let chunkRecord = firstRecord; chunkRecord < lastRecordExclusive; chunkRecord += recordsPerChunk) {
      throwIfSignalReadAborted(options.signal);
      const chunkEndRecord = Math.min(lastRecordExclusive, chunkRecord + recordsPerChunk);
      const byteStart = this.header.headerBytes + chunkRecord * this.header.bytesPerDataRecord;
      const byteEnd = this.header.headerBytes + chunkEndRecord * this.header.bytesPerDataRecord;
      const view = new DataView(await this.file.slice(byteStart, byteEnd).arrayBuffer());
      throwIfSignalReadAborted(options.signal);

      for (let record = chunkRecord; record < chunkEndRecord; record += 1) {
        const localRecordByte = (record - chunkRecord) * this.header.bytesPerDataRecord;
        selected.forEach((signal, selectedIndex) => {
          const recordFirstSample = record * signal.samplesPerRecord;
          const copyFirst = Math.max(Math.floor(request.startSec * signal.sampleRate), recordFirstSample);
          const copyEnd = Math.min(
            Math.ceil(request.endSec * signal.sampleRate),
            recordFirstSample + signal.samplesPerRecord,
          );
          if (copyEnd <= copyFirst) return;

          const digitalSpan = signal.digitalMaximum - signal.digitalMinimum;
          const physicalSpan = signal.physicalMaximum - signal.physicalMinimum;
          const usePhysicalScaling = digitalSpan !== 0 && physicalSpan !== 0 && Number.isFinite(physicalSpan);
          const scale = usePhysicalScaling ? physicalSpan / digitalSpan : 1;
          const offset = usePhysicalScaling ? signal.physicalMinimum - signal.digitalMinimum * scale : 0;
          const unitScale = usePhysicalScaling ? this.physicalUnitScaleBySignalIndex[signal.index] : 1;
          for (let sample = copyFirst; sample < copyEnd; sample += 1) {
            const sampleTime = sample / signal.sampleRate;
            const bucket = Math.min(
              bucketCount - 1,
              Math.floor(((sampleTime - request.startSec) / request.durationSec) * bucketCount),
            );
            const inRecord = sample - recordFirstSample;
            const digital = view.getInt16(localRecordByte + signal.byteOffsetInRecord + inRecord * 2, true);
            addEnvelopeSample(accumulators[selectedIndex], bucket, (digital * scale + offset) * unitScale);
          }
        });
      }
    }

    return makeEnvelopeWindowResult(this.meta, request, accumulators, bucketCount);
  }
}

// ---------------------------------------------------------------------------
// Headerless signed int16 DAT source (legacy MATLAB companion files)
// ---------------------------------------------------------------------------

export interface RawDatSourceOptions {
  sampleRate: number;
  channelCount: number;
  channelLabels?: readonly string[];
  /** Physical units per digital count. May be scalar or one value per channel. */
  physicalScale?: number | readonly number[];
  /** Physical offset after scaling. May be scalar or one value per channel. */
  physicalOffset?: number | readonly number[];
  channelUnits?: string | readonly string[];
  name?: string;
  warnings?: readonly string[];
  assumptions?: readonly string[];
}

function expandPerChannel(
  value: number | readonly number[] | undefined,
  count: number,
  fallback: number,
  field: string,
): number[] {
  if (value === undefined) return Array(count).fill(fallback) as number[];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field} must be finite.`);
    return Array(count).fill(value) as number[];
  }
  if (value.length !== count || value.some((entry) => !Number.isFinite(entry))) {
    throw new Error(`${field} must contain exactly ${count} finite values.`);
  }
  return Array.from(value);
}

export class RawDatSource implements SignalSource {
  readonly meta: RecordingMeta;
  private readonly file: File;
  private readonly scale: number[];
  private readonly physicalOffset: number[];
  private readonly totalSamples: number;

  private constructor(file: File, options: RawDatSourceOptions) {
    if (!(options.sampleRate > 0) || !Number.isFinite(options.sampleRate)) {
      throw new Error("Raw DAT sample rate must be a positive finite number.");
    }
    if (!Number.isInteger(options.channelCount) || options.channelCount <= 0) {
      throw new Error("Raw DAT channel count must be a positive integer.");
    }
    if (options.physicalScale !== undefined) {
      const scales = typeof options.physicalScale === "number" ? [options.physicalScale] : options.physicalScale;
      if (scales.some((scale) => !Number.isFinite(scale) || !(scale > 0))) {
        throw new Error("Raw DAT physical scale must contain only positive finite values.");
      }
    }
    this.file = file;
    this.scale = expandPerChannel(options.physicalScale, options.channelCount, 1, "physicalScale");
    this.physicalOffset = expandPerChannel(options.physicalOffset, options.channelCount, 0, "physicalOffset");
    const bytesPerFrame = options.channelCount * 2;
    this.totalSamples = Math.floor(file.size / bytesPerFrame);
    const trailingBytes = file.size - this.totalSamples * bytesPerFrame;
    const labels = Array.from({ length: options.channelCount }, (_, index) =>
      options.channelLabels?.[index] || `CH${String(index + 1).padStart(3, "0")}`,
    );
    const defaultUnit = options.physicalScale === undefined ? "a.u." : "µV";
    const units = typeof options.channelUnits === "string"
      ? labels.map(() => options.channelUnits as string)
      : Array.from({ length: options.channelCount }, (_, index) => options.channelUnits?.[index] || defaultUnit);
    const anatomicalChannels = orderAnatomicalChannelIndices(labels)
      .filter((index) => anatomicalChannelGroup(labels[index]) !== null);
    const displayCandidates = anatomicalChannels.length
      ? anatomicalChannels
      : labels.map((_, index) => index);
    const recommendedDisplayChannels = displayCandidates.slice(0, MAX_RECOMMENDED_DISPLAY_CHANNELS);
    const warnings = [
      "Headerless DAT interpretation assumes sample-major, channel-interleaved signed 16-bit little-endian values. Confirm the mapping before clinical review.",
      ...(options.warnings ?? []),
    ];
    if (displayCandidates.length > recommendedDisplayChannels.length) {
      warnings.push(
        `Initial display is limited to ${MAX_RECOMMENDED_DISPLAY_CHANNELS} channels for responsive loading; every mapped channel remains available through CH+.`,
      );
    }
    if (trailingBytes) warnings.push(`Ignored ${trailingBytes} trailing byte(s) that do not form a complete sample frame.`);
    if (options.physicalScale === undefined) warnings.push("No physical scale was supplied; raw digital counts are displayed as arbitrary units.");

    this.meta = {
      id: deterministicId(`${file.name}:${file.size}:${file.lastModified}:${options.sampleRate}:${options.channelCount}`, "rec"),
      name: options.name ?? file.name,
      fileName: file.name,
      format: "raw-int16-le",
      durationSec: this.totalSamples / options.sampleRate,
      channelCount: options.channelCount,
      channelLabels: labels,
      channelUnits: units,
      units,
      sampleRates: labels.map(() => options.sampleRate),
      sampleRate: options.sampleRate,
      recommendedDisplayChannels,
      byteLength: file.size,
      warnings,
      assumptions: ["signed int16", "little-endian", "sample-major channel interleave", ...(options.assumptions ?? [])],
      details: {
        totalSampleFrames: this.totalSamples,
        trailingBytes,
        sampleRateHz: options.sampleRate,
        channelCount: options.channelCount,
        physicalScale: typeof options.physicalScale === "number" ? options.physicalScale : "per-channel or unspecified",
      },
    };
  }

  static async create(file: File, options: RawDatSourceOptions): Promise<RawDatSource> {
    return new RawDatSource(file, options);
  }

  async getWindow(
    startSec: number,
    durationSec: number,
    channelIndices?: readonly number[],
    options: SignalReadOptions = {},
  ): Promise<WindowData> {
    throwIfSignalReadAborted(options.signal);
    const request = normalizeWindowRequest(this.meta, startSec, durationSec, channelIndices);
    const sampleRate = this.meta.sampleRates[0];
    const firstSample = Math.floor(request.startSec * sampleRate);
    const endSample = Math.min(this.totalSamples, Math.ceil(request.endSec * sampleRate));
    const sampleCount = Math.max(0, endSample - firstSample);
    const outputs = request.channelIndices.map(() => new Float32Array(sampleCount));
    const channelStartSecs = request.channelIndices.map(() => firstSample / sampleRate);
    if (sampleCount === 0 || outputs.length === 0) return makeWindowResult(this.meta, request, outputs, undefined, channelStartSecs);

    const bytesPerFrame = this.meta.channelCount * 2;
    const framesPerChunk = Math.max(1, Math.floor((8 * 1024 * 1024) / bytesPerFrame));
    for (let chunkStart = firstSample; chunkStart < endSample; chunkStart += framesPerChunk) {
      throwIfSignalReadAborted(options.signal);
      const chunkEnd = Math.min(endSample, chunkStart + framesPerChunk);
      const byteStart = chunkStart * bytesPerFrame;
      const view = new DataView(await this.file.slice(byteStart, chunkEnd * bytesPerFrame).arrayBuffer());
      throwIfSignalReadAborted(options.signal);
      for (let sample = chunkStart; sample < chunkEnd; sample += 1) {
        const localFrameByte = (sample - chunkStart) * bytesPerFrame;
        request.channelIndices.forEach((channelIndex, outputIndex) => {
          const digital = view.getInt16(localFrameByte + channelIndex * 2, true);
          outputs[outputIndex][sample - firstSample] =
            digital * this.scale[channelIndex] + this.physicalOffset[channelIndex];
        });
      }
    }
    return makeWindowResult(this.meta, request, outputs, undefined, channelStartSecs);
  }

  async getEnvelopeWindow(
    startSec: number,
    durationSec: number,
    bucketCount: number,
    channelIndices?: readonly number[],
    options: SignalReadOptions = {},
  ): Promise<EnvelopeWindowData> {
    validateEnvelopeBucketCount(bucketCount);
    throwIfSignalReadAborted(options.signal);
    const request = normalizeWindowRequest(this.meta, startSec, durationSec, channelIndices);
    const sampleRate = this.meta.sampleRates[0];
    const firstSample = Math.floor(request.startSec * sampleRate);
    const endSample = Math.min(this.totalSamples, Math.ceil(request.endSec * sampleRate));
    const accumulators = request.channelIndices.map(() => makeEnvelopeAccumulator(bucketCount));
    if (firstSample >= endSample || accumulators.length === 0) {
      return makeEnvelopeWindowResult(this.meta, request, accumulators, bucketCount);
    }

    const bytesPerFrame = this.meta.channelCount * 2;
    const framesPerChunk = Math.max(1, Math.floor((4 * 1024 * 1024) / bytesPerFrame));
    for (let chunkStart = firstSample; chunkStart < endSample; chunkStart += framesPerChunk) {
      throwIfSignalReadAborted(options.signal);
      const chunkEnd = Math.min(endSample, chunkStart + framesPerChunk);
      const byteStart = chunkStart * bytesPerFrame;
      const view = new DataView(await this.file.slice(byteStart, chunkEnd * bytesPerFrame).arrayBuffer());
      throwIfSignalReadAborted(options.signal);
      for (let sample = chunkStart; sample < chunkEnd; sample += 1) {
        const sampleTime = sample / sampleRate;
        const bucket = Math.min(
          bucketCount - 1,
          Math.floor(((sampleTime - request.startSec) / request.durationSec) * bucketCount),
        );
        const localFrameByte = (sample - chunkStart) * bytesPerFrame;
        request.channelIndices.forEach((channelIndex, outputIndex) => {
          const digital = view.getInt16(localFrameByte + channelIndex * 2, true);
          addEnvelopeSample(
            accumulators[outputIndex],
            bucket,
            digital * this.scale[channelIndex] + this.physicalOffset[channelIndex],
          );
        });
      }
    }
    return makeEnvelopeWindowResult(this.meta, request, accumulators, bucketCount);
  }
}

// ---------------------------------------------------------------------------
// MATLAB Level-5 numeric matrix parsing
// ---------------------------------------------------------------------------

const MI_INT8 = 1;
const MI_UINT8 = 2;
const MI_INT16 = 3;
const MI_UINT16 = 4;
const MI_INT32 = 5;
const MI_UINT32 = 6;
const MI_SINGLE = 7;
const MI_DOUBLE = 9;
const MI_INT64 = 12;
const MI_UINT64 = 13;
const MI_MATRIX = 14;
const MI_COMPRESSED = 15;
const MI_UTF8 = 16;
const MI_UTF16 = 17;
const MI_UTF32 = 18;

const MX_CELL_CLASS = 1;
const MX_STRUCT_CLASS = 2;
const MX_CHAR_CLASS = 4;
const NUMERIC_MX_CLASSES = new Set([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const NUMERIC_MI_TYPES = new Set([
  MI_INT8,
  MI_UINT8,
  MI_INT16,
  MI_UINT16,
  MI_INT32,
  MI_UINT32,
  MI_SINGLE,
  MI_DOUBLE,
  MI_INT64,
  MI_UINT64,
]);

interface MatTag {
  type: number;
  byteLength: number;
  data: Uint8Array;
  nextOffset: number;
  small: boolean;
}

interface MatNumericDescriptor {
  name: string;
  dimensions: number[];
  elementCount: number;
  dataType: number;
  bytes: Uint8Array;
  littleEndian: boolean;
  complex: boolean;
}

interface MatStringDescriptor {
  name: string;
  dimensions: number[];
  values: string[];
}

interface MatParseContext {
  littleEndian: boolean;
  numeric: MatNumericDescriptor[];
  strings: MatStringDescriptor[];
  warnings: string[];
}

export interface LegacyMatMetadata {
  sampleRate?: number;
  channelCount?: number;
  channelLabels: string[];
  events: Array<{ label: string; timeSec: number }>;
  warnings: string[];
}

export interface MatSourceOptions {
  /** Overrides a scalar Fs/sample_rate variable found in the file. */
  sampleRate?: number;
  channelLabels?: readonly string[];
  channelUnits?: string | readonly string[];
}

function align8(value: number): number {
  return Math.ceil(value / 8) * 8;
}

function isKnownMiType(type: number): boolean {
  return (type >= 1 && type <= 7) || (type >= 9 && type <= 18);
}

function readMatTag(bytes: Uint8Array, offset: number, littleEndian: boolean): MatTag | null {
  if (offset >= bytes.byteLength) return null;
  if (bytes.byteLength - offset < 8) {
    if (bytes.subarray(offset).every((value) => value === 0)) return null;
    throw new SignalFileError("TRUNCATED_FILE", "MAT v5 element tag is truncated.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const smallType = view.getUint16(offset, littleEndian);
  const smallLength = view.getUint16(offset + 2, littleEndian);
  if (smallLength > 0 && smallLength <= 4 && isKnownMiType(smallType)) {
    return {
      type: smallType,
      byteLength: smallLength,
      data: bytes.subarray(offset + 4, offset + 4 + smallLength),
      nextOffset: offset + 8,
      small: true,
    };
  }

  const type = view.getUint32(offset, littleEndian);
  const byteLength = view.getUint32(offset + 4, littleEndian);
  if (type === 0 && byteLength === 0 && bytes.subarray(offset).every((value) => value === 0)) return null;
  if (!isKnownMiType(type)) {
    throw new SignalFileError("INVALID_HEADER", `MAT v5 contains unsupported or corrupt element type ${type}.`);
  }
  const dataStart = offset + 8;
  const dataEnd = dataStart + byteLength;
  if (!Number.isSafeInteger(dataEnd) || dataEnd > bytes.byteLength) {
    throw new SignalFileError("TRUNCATED_FILE", `MAT v5 element type ${type} extends past the end of its container.`);
  }
  const paddedEnd = dataStart + align8(byteLength);
  let nextOffset = Math.min(paddedEnd, bytes.byteLength);
  // A few writers omit padding after miCOMPRESSED despite the Level-5 spec.
  if (
    type === MI_COMPRESSED &&
    dataEnd < nextOffset &&
    bytes.subarray(dataEnd, nextOffset).some((value) => value !== 0)
  ) {
    nextOffset = dataEnd;
  }
  return {
    type,
    byteLength,
    data: bytes.subarray(dataStart, dataEnd),
    nextOffset,
    small: false,
  };
}

function readIntegerArray(tag: MatTag, littleEndian: boolean): number[] {
  const view = new DataView(tag.data.buffer, tag.data.byteOffset, tag.data.byteLength);
  const result: number[] = [];
  const width = tag.type === MI_INT8 || tag.type === MI_UINT8 ? 1
    : tag.type === MI_INT16 || tag.type === MI_UINT16 ? 2
      : tag.type === MI_INT32 || tag.type === MI_UINT32 ? 4
        : 0;
  if (!width || tag.data.byteLength % width !== 0) {
    throw new SignalFileError("INVALID_HEADER", "MAT v5 integer metadata has an invalid storage type or length.");
  }
  for (let offset = 0; offset < tag.data.byteLength; offset += width) {
    if (tag.type === MI_INT8) result.push(view.getInt8(offset));
    else if (tag.type === MI_UINT8) result.push(view.getUint8(offset));
    else if (tag.type === MI_INT16) result.push(view.getInt16(offset, littleEndian));
    else if (tag.type === MI_UINT16) result.push(view.getUint16(offset, littleEndian));
    else if (tag.type === MI_INT32) result.push(view.getInt32(offset, littleEndian));
    else result.push(view.getUint32(offset, littleEndian));
  }
  return result;
}

function decodeMatText(tag: MatTag, littleEndian: boolean): string {
  if (tag.type === MI_INT8 || tag.type === MI_UINT8 || tag.type === MI_UTF8) {
    return new TextDecoder("utf-8").decode(tag.data).replace(/\0+$/g, "");
  }
  const view = new DataView(tag.data.buffer, tag.data.byteOffset, tag.data.byteLength);
  const codePoints: number[] = [];
  if (tag.type === MI_UINT16 || tag.type === MI_UTF16) {
    for (let offset = 0; offset + 1 < tag.data.byteLength; offset += 2) {
      codePoints.push(view.getUint16(offset, littleEndian));
    }
  } else if (tag.type === MI_UTF32) {
    for (let offset = 0; offset + 3 < tag.data.byteLength; offset += 4) {
      codePoints.push(view.getUint32(offset, littleEndian));
    }
  } else {
    return "";
  }
  return String.fromCodePoint(...codePoints.filter((point) => point !== 0));
}

function decodeMatCharRows(
  tag: MatTag,
  dimensions: readonly number[],
  littleEndian: boolean,
): string[] {
  const rowCount = dimensions[0] ?? 1;
  const declaredCount = dimensions.reduce((product, dimension) => product * dimension, 1);
  if (rowCount <= 0 || declaredCount <= 0) return [];

  let codePoints: number[];
  if (tag.type === MI_UTF8) {
    codePoints = Array.from(new TextDecoder("utf-8").decode(tag.data), (character) =>
      character.codePointAt(0) ?? 0,
    );
  } else {
    const view = new DataView(tag.data.buffer, tag.data.byteOffset, tag.data.byteLength);
    const width = tag.type === MI_INT8 || tag.type === MI_UINT8 ? 1
      : tag.type === MI_INT16 || tag.type === MI_UINT16 || tag.type === MI_UTF16 ? 2
        : tag.type === MI_UINT32 || tag.type === MI_UTF32 ? 4
          : 0;
    if (!width) return [];
    const availableCount = Math.floor(tag.data.byteLength / width);
    codePoints = Array.from({ length: Math.min(declaredCount, availableCount) }, (_, index) => {
      const offset = index * width;
      if (width === 1) return view.getUint8(offset);
      if (width === 2) return view.getUint16(offset, littleEndian);
      return view.getUint32(offset, littleEndian);
    });
  }

  const columnCount = Math.ceil(Math.min(declaredCount, codePoints.length) / rowCount);
  return Array.from({ length: rowCount }, (_, row) => {
    let value = "";
    for (let column = 0; column < columnCount; column += 1) {
      const codePoint = codePoints[row + column * rowCount];
      if (codePoint && codePoint <= 0x10ffff) value += String.fromCodePoint(codePoint);
    }
    return value.replace(/[\0\s]+$/g, "").trim();
  });
}

function miTypeWidth(type: number): number {
  if (type === MI_INT8 || type === MI_UINT8) return 1;
  if (type === MI_INT16 || type === MI_UINT16) return 2;
  if (type === MI_INT32 || type === MI_UINT32 || type === MI_SINGLE) return 4;
  if (type === MI_DOUBLE || type === MI_INT64 || type === MI_UINT64) return 8;
  return 0;
}

function readNumericAt(descriptor: MatNumericDescriptor, index: number): number {
  const width = miTypeWidth(descriptor.dataType);
  const offset = index * width;
  if (!width || index < 0 || offset + width > descriptor.bytes.byteLength) {
    throw new SignalFileError("TRUNCATED_FILE", `MAT numeric matrix "${descriptor.name}" has fewer values than its dimensions declare.`);
  }
  const view = new DataView(
    descriptor.bytes.buffer,
    descriptor.bytes.byteOffset,
    descriptor.bytes.byteLength,
  );
  switch (descriptor.dataType) {
    case MI_INT8: return view.getInt8(offset);
    case MI_UINT8: return view.getUint8(offset);
    case MI_INT16: return view.getInt16(offset, descriptor.littleEndian);
    case MI_UINT16: return view.getUint16(offset, descriptor.littleEndian);
    case MI_INT32: return view.getInt32(offset, descriptor.littleEndian);
    case MI_UINT32: return view.getUint32(offset, descriptor.littleEndian);
    case MI_SINGLE: return view.getFloat32(offset, descriptor.littleEndian);
    case MI_DOUBLE: return view.getFloat64(offset, descriptor.littleEndian);
    case MI_INT64: return Number(view.getBigInt64(offset, descriptor.littleEndian));
    case MI_UINT64: return Number(view.getBigUint64(offset, descriptor.littleEndian));
    default: throw new SignalFileError("UNSUPPORTED_FORMAT", `Unsupported MAT numeric storage type ${descriptor.dataType}.`);
  }
}

async function decompressMatElement(compressed: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new SignalFileError(
      "DECOMPRESSION_UNAVAILABLE",
      "This MAT v5 file uses miCOMPRESSED data, but this browser cannot decompress zlib streams. Use a current browser, or save the MAT file without compression.",
    );
  }
  try {
    const decompressor = new DecompressionStream("deflate");
    const source = new Blob([compressed.slice().buffer]).stream().pipeThrough(decompressor);
    const reader = source.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const maximumExpandedBytes = 1024 * 1024 * 1024;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maximumExpandedBytes) {
        await reader.cancel();
        throw new SignalFileError(
          "UNSUPPORTED_FORMAT",
          "A compressed MAT element expands beyond the 1 GiB browser safety limit. Export the signal as EDF or an uncompressed MAT file.",
        );
      }
      chunks.push(chunk);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    chunks.forEach((chunk) => {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    });
    return result;
  } catch (error) {
    if (error instanceof SignalFileError) throw error;
    throw new SignalFileError(
      "INVALID_HEADER",
      "The MAT v5 compressed element could not be decompressed. The file may be damaged or use a nonstandard codec.",
      { cause: error },
    );
  }
}

function childTags(bytes: Uint8Array, littleEndian: boolean): MatTag[] {
  const tags: MatTag[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const tag = readMatTag(bytes, offset, littleEndian);
    if (!tag) break;
    tags.push(tag);
    if (tag.nextOffset <= offset) {
      throw new SignalFileError("INVALID_HEADER", "MAT v5 parser encountered a non-advancing element.");
    }
    offset = tag.nextOffset;
  }
  return tags;
}

async function parseMatMatrix(
  matrixBytes: Uint8Array,
  context: MatParseContext,
  pathPrefix: string,
  depth: number,
): Promise<void> {
  if (depth > 24) {
    throw new SignalFileError("INVALID_HEADER", "MAT v5 structure nesting exceeds the supported depth.");
  }
  const tags = childTags(matrixBytes, context.littleEndian);
  if (tags.length < 3) throw new SignalFileError("INVALID_HEADER", "MAT v5 matrix is missing flags, dimensions, or name metadata.");
  const flagWords = readIntegerArray(tags[0], context.littleEndian);
  if (!flagWords.length) throw new SignalFileError("INVALID_HEADER", "MAT v5 matrix has empty array flags.");
  const matrixClass = flagWords[0] & 0xff;
  const complex = (flagWords[0] & 0x0800) !== 0;
  const dimensions = readIntegerArray(tags[1], context.littleEndian);
  if (dimensions.length === 0 || dimensions.some((dimension) => dimension < 0 || !Number.isSafeInteger(dimension))) {
    throw new SignalFileError("INVALID_HEADER", "MAT v5 matrix dimensions are invalid.");
  }
  const ownName = decodeMatText(tags[2], context.littleEndian).trim();
  const name = ownName
    ? pathPrefix ? `${pathPrefix}.${ownName}` : ownName
    : pathPrefix || "unnamed";

  if (matrixClass === MX_CHAR_CLASS) {
    const characterTag = tags.slice(3).find((tag) =>
      tag.type === MI_INT8 ||
      tag.type === MI_UINT8 ||
      tag.type === MI_INT16 ||
      tag.type === MI_UINT16 ||
      tag.type === MI_UINT32 ||
      tag.type === MI_UTF8 ||
      tag.type === MI_UTF16 ||
      tag.type === MI_UTF32,
    );
    if (characterTag) {
      context.strings.push({
        name,
        dimensions,
        values: decodeMatCharRows(characterTag, dimensions, context.littleEndian),
      });
    }
    return;
  }

  if (NUMERIC_MX_CLASSES.has(matrixClass)) {
    const realTag = tags.slice(3).find((tag) => NUMERIC_MI_TYPES.has(tag.type));
    if (!realTag) throw new SignalFileError("INVALID_HEADER", `MAT numeric matrix "${name}" has no real data element.`);
    const elementCount = dimensions.reduce((product, dimension) => product * dimension, 1);
    const width = miTypeWidth(realTag.type);
    if (!Number.isSafeInteger(elementCount) || elementCount * width > realTag.data.byteLength) {
      throw new SignalFileError("TRUNCATED_FILE", `MAT numeric matrix "${name}" is shorter than its declared dimensions.`);
    }
    context.numeric.push({
      name,
      dimensions,
      elementCount,
      dataType: realTag.type,
      bytes: realTag.data,
      littleEndian: context.littleEndian,
      complex,
    });
    return;
  }

  if (matrixClass === MX_STRUCT_CLASS && tags.length >= 5) {
    const fieldLengthValues = readIntegerArray(tags[3], context.littleEndian);
    const fieldLength = fieldLengthValues[0] ?? 0;
    if (fieldLength > 0) {
      const rawNames = tags[4].data;
      const fieldNames: string[] = [];
      for (let offset = 0; offset + fieldLength <= rawNames.byteLength; offset += fieldLength) {
        fieldNames.push(
          new TextDecoder("utf-8").decode(rawNames.subarray(offset, offset + fieldLength)).replace(/\0[\s\S]*$/, "").trim(),
        );
      }
      let valueIndex = 0;
      const structureCount = dimensions.reduce((product, dimension) => product * dimension, 1);
      for (const tag of tags.slice(5)) {
        if (tag.type !== MI_MATRIX) continue;
        const fieldName = fieldNames[valueIndex % Math.max(1, fieldNames.length)] || `field${valueIndex + 1}`;
        const structureIndex = Math.floor(valueIndex / Math.max(1, fieldNames.length));
        const structurePath = structureCount > 1 ? `${name}[${structureIndex}]` : name;
        await parseMatMatrix(tag.data, context, `${structurePath}.${fieldName}`, depth + 1);
        valueIndex += 1;
      }
      return;
    }
  }

  // Cell arrays and unfamiliar container classes can still contain useful matrices.
  let nestedIndex = 0;
  const containerCount = dimensions.reduce((product, dimension) => product * dimension, 1);
  for (const tag of tags.slice(3)) {
    if (tag.type !== MI_MATRIX) continue;
    const nestedPath = matrixClass === MX_CELL_CLASS && containerCount > 1
      ? `${name}[${nestedIndex}]`
      : name;
    await parseMatMatrix(tag.data, context, nestedPath, depth + 1);
    nestedIndex += 1;
  }
}

async function parseMatElements(bytes: Uint8Array, context: MatParseContext, depth = 0): Promise<void> {
  if (depth > 24) throw new SignalFileError("INVALID_HEADER", "MAT v5 compressed nesting exceeds the supported depth.");
  let offset = 0;
  while (offset < bytes.byteLength) {
    const tag = readMatTag(bytes, offset, context.littleEndian);
    if (!tag) break;
    if (tag.type === MI_MATRIX) {
      await parseMatMatrix(tag.data, context, "", depth + 1);
    } else if (tag.type === MI_COMPRESSED) {
      const decompressed = await decompressMatElement(tag.data);
      await parseMatElements(decompressed, context, depth + 1);
    }
    if (tag.nextOffset <= offset) throw new SignalFileError("INVALID_HEADER", "MAT v5 parser could not advance to the next element.");
    offset = tag.nextOffset;
  }
}

async function loadMatV5Context(file: File): Promise<MatParseContext> {
  const firstBytes = new Uint8Array(await file.slice(0, Math.min(file.size, 128)).arrayBuffer());
  const signature = String.fromCharCode(...firstBytes.subarray(0, 8));
  const headerText = new TextDecoder("windows-1252").decode(firstBytes);
  if (signature === "\u0089HDF\r\n\u001a\n" || /MATLAB\s+7\.3\s+MAT-file/i.test(headerText)) {
    throw new SignalFileError(
      "UNSUPPORTED_FORMAT",
      "MATLAB v7.3 files use HDF5, which this browser-only importer does not decode. Export the signal as EDF, or resave it with MATLAB using -v7 (Level 5).",
    );
  }
  if (file.size < 128 || !/MATLAB\s+(?:5\.0|Level 5)\s+MAT-file/i.test(headerText)) {
    throw new SignalFileError(
      "UNSUPPORTED_FORMAT",
      "This is not a MATLAB Level-5 MAT file. MAT v4 and v7.3/HDF5 are not supported by the in-browser importer.",
    );
  }
  const endianBytes = String.fromCharCode(firstBytes[126], firstBytes[127]);
  const littleEndian = endianBytes === "IM";
  if (!littleEndian && endianBytes !== "MI") {
    throw new SignalFileError("INVALID_HEADER", `MAT v5 endian indicator "${endianBytes}" is invalid.`);
  }
  const allBytes = new Uint8Array(await file.arrayBuffer());
  const context: MatParseContext = { littleEndian, numeric: [], strings: [], warnings: [] };
  await parseMatElements(allBytes.subarray(128), context);
  return context;
}

function canonicalMatPath(path: string): string {
  return path
    .replace(/\[\d+\]/g, "")
    .split(".")
    .map((segment) => segment.replace(/[^a-z0-9]/gi, "").toLowerCase())
    .filter(Boolean)
    .join(".");
}

function legacyEventIndex(path: string, field: "label" | "times"): number | undefined {
  const match = new RegExp(`(?:^|\\.)events(?:\\[(\\d+)\\])?\\.${field}(?:\\[\\d+\\])?$`, "i").exec(path);
  return match ? Number(match[1] ?? 0) : undefined;
}

/**
 * Reads the metadata contract produced by the legacy UNM session pipeline.
 * The companion .dat signal remains separate and should be opened with
 * RawDatSource after the returned rate/count/labels are reviewed.
 */
export async function parseLegacyMatMetadata(file: File): Promise<LegacyMatMetadata> {
  const context = await loadMatV5Context(file);
  const warnings = [...context.warnings];
  const numericBySuffix = (suffix: string) => context.numeric.find((descriptor) =>
    canonicalMatPath(descriptor.name).endsWith(suffix),
  );

  const rateDescriptor = numericBySuffix("sessioninfo.sfile.header.samplerate");
  const rawRate = rateDescriptor?.elementCount ? readNumericAt(rateDescriptor, 0) : undefined;
  const sampleRate = rawRate !== undefined && Number.isFinite(rawRate) && rawRate > 0
    ? rawRate
    : undefined;
  if (rawRate !== undefined && sampleRate === undefined) {
    warnings.push(`Legacy MAT sample_rate value ${String(rawRate)} is invalid.`);
  } else if (sampleRate === undefined) {
    warnings.push("Legacy MAT metadata does not contain sessionInfo.sFile.header.sample_rate.");
  }

  const countDescriptor = numericBySuffix("sessioninfo.sfile.header.numchannels");
  const rawCount = countDescriptor?.elementCount ? readNumericAt(countDescriptor, 0) : undefined;
  let channelCount: number | undefined;
  if (rawCount !== undefined && Number.isFinite(rawCount) && rawCount > 0) {
    channelCount = Math.trunc(rawCount);
    if (channelCount !== rawCount) warnings.push(`Legacy MAT num_channels ${rawCount} was rounded down to ${channelCount}.`);
  } else if (rawCount !== undefined) {
    warnings.push(`Legacy MAT num_channels value ${String(rawCount)} is invalid.`);
  } else {
    warnings.push("Legacy MAT metadata does not contain sessionInfo.sFile.header.num_channels.");
  }

  const channelLabels = context.strings
    .filter((descriptor) =>
      canonicalMatPath(descriptor.name).endsWith("sessioninfo.channelmat.channel.name"),
    )
    .flatMap((descriptor) => descriptor.values)
    .map((value) => value.trim())
    .filter(Boolean);
  if (channelLabels.length === 0) {
    warnings.push("No sessionInfo.ChannelMat.Channel.Name values were found; channel labels must be mapped manually.");
  } else if (channelCount !== undefined && channelLabels.length !== channelCount) {
    warnings.push(`Legacy MAT declares ${channelCount} channels but provides ${channelLabels.length} channel name(s).`);
  }

  const eventParts = new Map<number, { label?: string; timeSec?: number }>();
  for (const descriptor of context.strings) {
    const eventIndex = legacyEventIndex(descriptor.name, "label");
    if (eventIndex === undefined) continue;
    const label = descriptor.values.find((value) => value.trim().length > 0)?.trim();
    if (!label) continue;
    const event = eventParts.get(eventIndex) ?? {};
    if (event.label === undefined) event.label = label;
    eventParts.set(eventIndex, event);
  }
  for (const descriptor of context.numeric) {
    const eventIndex = legacyEventIndex(descriptor.name, "times");
    if (eventIndex === undefined || descriptor.elementCount === 0) continue;
    // The legacy MATLAB tool uses the first value as the event onset.
    const timeSec = readNumericAt(descriptor, 0);
    if (!Number.isFinite(timeSec)) continue;
    const event = eventParts.get(eventIndex) ?? {};
    if (event.timeSec === undefined) event.timeSec = timeSec;
    eventParts.set(eventIndex, event);
  }
  const incompleteEvents = [...eventParts.values()].filter((event) =>
    !event.label || event.timeSec === undefined,
  ).length;
  if (incompleteEvents) warnings.push(`Skipped ${incompleteEvents} legacy event(s) missing a label or finite onset time.`);
  const events = [...eventParts.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, event]) => event.label && event.timeSec !== undefined
      ? [{ label: event.label, timeSec: event.timeSec }]
      : []);

  return {
    sampleRate,
    channelCount,
    channelLabels,
    events,
    warnings: [...new Set(warnings)],
  };
}

function sampleRateNameScore(name: string): number {
  const leaf = name.split(".").at(-1)?.replace(/[^a-z0-9]/gi, "").toLowerCase() ?? "";
  if (["fs", "srate", "samplerate", "samplingrate", "samplingfrequency"].includes(leaf)) return 100;
  if (leaf.includes("sample") && leaf.includes("rate")) return 90;
  if (leaf.includes("sampling") && leaf.includes("freq")) return 85;
  if (["frequency", "freq", "hz"].includes(leaf)) return 30;
  return 0;
}

function chooseMatSampleRate(descriptors: readonly MatNumericDescriptor[]): { value?: number; name?: string } {
  const candidates = descriptors
    .filter((descriptor) => descriptor.elementCount === 1)
    .map((descriptor) => ({
      descriptor,
      value: readNumericAt(descriptor, 0),
      score: sampleRateNameScore(descriptor.name),
    }))
    .filter(({ value, score }) => score > 0 && Number.isFinite(value) && value > 0 && value <= 1_000_000)
    .sort((a, b) => b.score - a.score || a.descriptor.name.localeCompare(b.descriptor.name));
  return candidates.length ? { value: candidates[0].value, name: candidates[0].descriptor.name } : {};
}

function decodeMatSignalMatrix(descriptor: MatNumericDescriptor): {
  data: Float32Array[];
  sampleCount: number;
  channelCount: number;
  sampleAxis: number;
} {
  const dimensions = descriptor.dimensions.length ? [...descriptor.dimensions] : [descriptor.elementCount, 1];
  const sampleAxis = dimensions.reduce(
    (best, dimension, index) => dimension > dimensions[best] ? index : best,
    0,
  );
  const sampleCount = dimensions[sampleAxis];
  const channelCount = dimensions.reduce(
    (product, dimension, index) => index === sampleAxis ? product : product * dimension,
    1,
  );
  if (sampleCount <= 0 || channelCount <= 0) {
    throw new SignalFileError("NO_SIGNAL_MATRIX", `MAT matrix "${descriptor.name}" is empty.`);
  }

  const strides = dimensions.map((_, index) =>
    dimensions.slice(0, index).reduce((product, dimension) => product * dimension, 1),
  );
  const otherAxes = dimensions.map((_, index) => index).filter((index) => index !== sampleAxis);
  const data = Array.from({ length: channelCount }, (_, channelIndex) => {
    let remainder = channelIndex;
    let baseIndex = 0;
    for (const axis of otherAxes) {
      const coordinate = remainder % dimensions[axis];
      remainder = Math.floor(remainder / dimensions[axis]);
      baseIndex += coordinate * strides[axis];
    }
    const channel = new Float32Array(sampleCount);
    for (let sample = 0; sample < sampleCount; sample += 1) {
      channel[sample] = readNumericAt(descriptor, baseIndex + sample * strides[sampleAxis]);
    }
    return channel;
  });
  return { data, sampleCount, channelCount, sampleAxis };
}

export class MatSource implements SignalSource {
  readonly meta: RecordingMeta;
  readonly matrixName: string;
  private readonly data: Float32Array[];

  private constructor(
    file: File,
    descriptor: MatNumericDescriptor,
    decoded: ReturnType<typeof decodeMatSignalMatrix>,
    sampleRate: number,
    sampleRateSource: string,
    options: MatSourceOptions,
    parserWarnings: string[],
  ) {
    this.data = decoded.data;
    this.matrixName = descriptor.name;
    const labels = Array.from({ length: decoded.channelCount }, (_, index) =>
      options.channelLabels?.[index] || `CH${String(index + 1).padStart(3, "0")}`,
    );
    const units = typeof options.channelUnits === "string"
      ? labels.map(() => options.channelUnits as string)
      : Array.from({ length: decoded.channelCount }, (_, index) => options.channelUnits?.[index] || "a.u.");
    const warnings = [...parserWarnings];
    if (!options.sampleRate && sampleRateSource === "assumed") {
      warnings.push("No scalar Fs/sample_rate variable was found; display timing assumes 256 Hz. Set the verified sample rate before annotation.");
    }
    if (!options.channelUnits) warnings.push("MAT numeric matrices do not encode a standard physical scale; values are displayed in arbitrary units.");
    if (descriptor.complex) warnings.push(`Matrix "${descriptor.name}" is complex; only its real component is displayed.`);
    if (descriptor.dimensions.filter((dimension) => dimension > 1).length > 2) {
      warnings.push(`Matrix dimensions [${descriptor.dimensions.join(", ")}] were flattened into ${decoded.channelCount} channels along sample axis ${decoded.sampleAxis + 1}.`);
    }
    this.meta = {
      id: deterministicId(`${file.name}:${file.size}:${file.lastModified}:${descriptor.name}`, "rec"),
      name: file.name,
      fileName: file.name,
      format: "mat-v5",
      durationSec: decoded.sampleCount / sampleRate,
      channelCount: decoded.channelCount,
      channelLabels: labels,
      channelUnits: units,
      units,
      sampleRates: labels.map(() => sampleRate),
      sampleRate,
      byteLength: file.size,
      warnings,
      details: {
        matrixName: descriptor.name,
        matrixDimensions: descriptor.dimensions.join("×"),
        sampleAxis: decoded.sampleAxis + 1,
        sampleRateSource,
      },
    };
  }

  static async create(file: File, options: MatSourceOptions = {}): Promise<MatSource> {
    const context = await loadMatV5Context(file);
    const signalCandidates = context.numeric
      .filter((descriptor) => descriptor.elementCount > 1)
      .sort((a, b) => b.elementCount - a.elementCount || a.name.localeCompare(b.name));
    if (!signalCandidates.length) {
      throw new SignalFileError(
        "NO_SIGNAL_MATRIX",
        "No non-scalar numeric signal matrix was found in this MAT v5 file. If this is session metadata paired with a .dat file, use the legacy DAT mapper.",
      );
    }
    const signal = signalCandidates[0];
    const selectionWarnings = [...context.warnings];
    if (signalCandidates.length > 1) {
      selectionWarnings.push(`Selected largest numeric matrix "${signal.name}" (${signal.dimensions.join("×")}) from ${signalCandidates.length} viable matrices. Confirm the matrix and sample axis before committed review.`);
    }
    const foundRate = chooseMatSampleRate(context.numeric);
    const sampleRate = options.sampleRate ?? foundRate.value ?? 256;
    if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) {
      throw new SignalFileError("INVALID_HEADER", `MAT sample rate ${String(sampleRate)} is invalid.`);
    }
    const sampleRateSource = options.sampleRate
      ? "user override"
      : foundRate.name ?? "assumed";
    const decoded = decodeMatSignalMatrix(signal);
    if (options.channelLabels && options.channelLabels.length !== decoded.channelCount) {
      throw new SignalFileError(
        "INVALID_HEADER",
        `Provided ${options.channelLabels.length} channel labels for a MAT matrix decoded as ${decoded.channelCount} channels.`,
      );
    }
    return new MatSource(
      file,
      signal,
      decoded,
      sampleRate,
      sampleRateSource,
      options,
      selectionWarnings,
    );
  }

  async getWindow(
    startSec: number,
    durationSec: number,
    channelIndices?: readonly number[],
  ): Promise<WindowData> {
    const request = normalizeWindowRequest(this.meta, startSec, durationSec, channelIndices);
    const sampleRate = this.meta.sampleRates[0];
    const firstSample = Math.floor(request.startSec * sampleRate);
    const endSample = Math.min(this.data[0]?.length ?? 0, Math.ceil(request.endSec * sampleRate));
    const data = request.channelIndices.map((channelIndex) => this.data[channelIndex].slice(firstSample, endSample));
    return makeWindowResult(
      this.meta,
      request,
      data,
      undefined,
      request.channelIndices.map(() => firstSample / sampleRate),
    );
  }
}

// ---------------------------------------------------------------------------
// Clinical display decimation and raw synchronized-dropout detection
// ---------------------------------------------------------------------------

export type ClinicalDecimationFactor = 1 | 2;

export interface ClinicalDisplayTrace {
  data: Float32Array;
  sampleRate: number;
  factor: ClinicalDecimationFactor;
  /** Local input offset retained first so factor-2 output stays on global even samples. */
  retainedInputSampleOffset: 0 | 1;
  /** Recording-global source sample represented by output sample zero. */
  outputStartSampleIndex: number;
  /** Output sample-zero offset relative to this input window's source origin. */
  outputStartOffsetSec: number;
  /** Fixed input-rate delay removed before the 2× output is retained. */
  compensatedGroupDelaySamples: number;
  /** Time correction for the retained filtered samples before pairing with source time. */
  retainedSampleTimeCorrectionSec: number;
}

export interface ClinicalDisplaySignals {
  data: Float32Array[];
  sampleRates: number[];
  factors: ClinicalDecimationFactor[];
  retainedInputSampleOffsets: Array<0 | 1>;
  outputStartSampleIndices: number[];
  outputStartOffsetSecs: number[];
  compensatedGroupDelaySamples: number[];
  retainedSampleTimeCorrectionSec: number[];
}

const CLINICAL_FIR_ORDER = 96;
const CLINICAL_FIR_TAPS = CLINICAL_FIR_ORDER + 1;
const CLINICAL_FIR_GROUP_DELAY = CLINICAL_FIR_ORDER / 2;
const CLINICAL_FIR_KAISER_BETA = 5.65;
const CLINICAL_PASSBAND_EDGE_HZ = 200;
const clinicalFirCache = new Map<number, Float64Array>();

function modifiedBesselI0(value: number): number {
  const squaredQuarter = value * value / 4;
  let sum = 1;
  let term = 1;
  for (let order = 1; order < 100; order += 1) {
    term *= squaredQuarter / (order * order);
    sum += term;
    if (Math.abs(term) <= Math.abs(sum) * Number.EPSILON) break;
  }
  return sum;
}

/** Returns the exact conditional factor specified for clinical display traces. */
export function clinicalDecimationFactor(
  sampleRate: number,
  sampleCount: number,
  pixelCount: number,
): ClinicalDecimationFactor {
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) {
    throw new Error("Clinical display sample rate must be positive and finite.");
  }
  if (!Number.isInteger(sampleCount) || sampleCount < 0) {
    throw new Error("Clinical display sample count must be a non-negative integer.");
  }
  if (!(pixelCount > 0) || !Number.isFinite(pixelCount)) {
    throw new Error("Clinical display pixel count must be positive and finite.");
  }
  const resolutionFactor = Math.min(2, Math.floor(sampleCount / Math.max(1, Math.floor(pixelCount))));
  return sampleRate / 4 >= 250 && resolutionFactor >= 2 ? 2 : 1;
}

/**
 * Designs Sean's fixed 96th-order, 97-tap fir1-equivalent Kaiser low-pass.
 * Coefficients are symmetric and normalized to unity DC gain.
 */
export function designClinicalDecimationFir(sampleRate: number): Float64Array {
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate) || sampleRate / 4 < 250) {
    throw new Error("Clinical 2× display decimation requires a source rate of at least 1000 Hz.");
  }
  const cached = clinicalFirCache.get(sampleRate);
  if (cached) return cached.slice();

  const stopbandEdgeHz = Math.min(245, sampleRate / 4 - 5);
  if (!(stopbandEdgeHz > CLINICAL_PASSBAND_EDGE_HZ)) {
    throw new Error("Clinical display decimation has no valid 200 Hz-to-stopband transition.");
  }
  const cutoffHz = (CLINICAL_PASSBAND_EDGE_HZ + stopbandEdgeHz) / 2;
  const cutoffCyclesPerSample = cutoffHz / sampleRate;
  const windowDenominator = modifiedBesselI0(CLINICAL_FIR_KAISER_BETA);
  const coefficients = new Float64Array(CLINICAL_FIR_TAPS);
  let dcGain = 0;

  for (let tap = 0; tap < CLINICAL_FIR_TAPS; tap += 1) {
    const centeredTap = tap - CLINICAL_FIR_GROUP_DELAY;
    const ideal = centeredTap === 0
      ? 2 * cutoffCyclesPerSample
      : Math.sin(2 * Math.PI * cutoffCyclesPerSample * centeredTap) / (Math.PI * centeredTap);
    const windowPosition = centeredTap / CLINICAL_FIR_GROUP_DELAY;
    const window = modifiedBesselI0(
      CLINICAL_FIR_KAISER_BETA * Math.sqrt(Math.max(0, 1 - windowPosition * windowPosition)),
    ) / windowDenominator;
    coefficients[tap] = ideal * window;
    dcGain += coefficients[tap];
  }
  for (let tap = 0; tap < coefficients.length; tap += 1) coefficients[tap] /= dcGain;
  clinicalFirCache.set(sampleRate, coefficients.slice());
  return coefficients;
}

/**
 * Applies a single causal FIR pass, removes its known 48-input-sample delay,
 * and retains every second sample. Negative-time and post-EOF filter state is
 * exactly zero. A full recording beginning at global sample zero retains
 * ceil(N / 2) samples; subwindows retain every global even sample they contain.
 */
export function decimateClinicalDisplayTrace(
  input: Float32Array,
  sampleRate: number,
  pixelCount: number,
  sourceStartSampleIndex = 0,
): ClinicalDisplayTrace {
  if (!Number.isSafeInteger(sourceStartSampleIndex) || sourceStartSampleIndex < 0) {
    throw new Error("Clinical display source start sample index must be a non-negative safe integer.");
  }
  const factor = clinicalDecimationFactor(sampleRate, input.length, pixelCount);
  if (factor === 1) {
    return {
      data: input,
      sampleRate,
      factor,
      retainedInputSampleOffset: 0,
      outputStartSampleIndex: sourceStartSampleIndex,
      outputStartOffsetSec: 0,
      compensatedGroupDelaySamples: 0,
      retainedSampleTimeCorrectionSec: 0,
    };
  }

  const coefficients = designClinicalDecimationFir(sampleRate);
  const retainedInputSampleOffset: 0 | 1 = sourceStartSampleIndex % 2 === 0 ? 0 : 1;
  const outputLength = Math.max(0, Math.ceil((input.length - retainedInputSampleOffset) / 2));
  const output = new Float32Array(outputLength);
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const filteredSample = CLINICAL_FIR_GROUP_DELAY
      + retainedInputSampleOffset
      + outputIndex * 2;
    let value = 0;
    let finite = true;
    for (let tap = 0; tap < coefficients.length; tap += 1) {
      const sourceIndex = filteredSample - tap;
      if (sourceIndex < 0 || sourceIndex >= input.length) continue;
      const sourceValue = input[sourceIndex];
      if (!Number.isFinite(sourceValue)) {
        finite = false;
        break;
      }
      value += coefficients[tap] * sourceValue;
    }
    output[outputIndex] = finite ? value : Number.NaN;
  }
  return {
    data: output,
    sampleRate: sampleRate / 2,
    factor,
    retainedInputSampleOffset,
    outputStartSampleIndex: sourceStartSampleIndex + retainedInputSampleOffset,
    outputStartOffsetSec: retainedInputSampleOffset / sampleRate,
    compensatedGroupDelaySamples: CLINICAL_FIR_GROUP_DELAY,
    retainedSampleTimeCorrectionSec: -CLINICAL_FIR_GROUP_DELAY / sampleRate,
  };
}

function throwIfSignalReadAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error("Signal read was superseded");
  error.name = "AbortError";
  throw error;
}

function validateEnvelopeBucketCount(bucketCount: number) {
  if (!Number.isSafeInteger(bucketCount) || bucketCount <= 0) {
    throw new SignalFileError("INVALID_WINDOW", "Envelope bucket count must be a positive whole number.");
  }
}

type EnvelopeAccumulator = {
  minima: Float32Array;
  maxima: Float32Array;
  gaps: Uint8Array;
  data: Float32Array;
};

function makeEnvelopeAccumulator(bucketCount: number): EnvelopeAccumulator {
  const minima = new Float32Array(bucketCount);
  const maxima = new Float32Array(bucketCount);
  const data = new Float32Array(bucketCount);
  minima.fill(Number.POSITIVE_INFINITY);
  maxima.fill(Number.NEGATIVE_INFINITY);
  data.fill(Number.NaN);
  return { minima, maxima, gaps: new Uint8Array(bucketCount), data };
}

function addEnvelopeSample(accumulator: EnvelopeAccumulator, bucket: number, value: number) {
  if (bucket < 0 || bucket >= accumulator.data.length) return;
  if (!Number.isFinite(value)) {
    accumulator.gaps[bucket] = 1;
    return;
  }
  accumulator.minima[bucket] = Math.min(accumulator.minima[bucket], value);
  accumulator.maxima[bucket] = Math.max(accumulator.maxima[bucket], value);
}

function finishEnvelopeAccumulator(accumulator: EnvelopeAccumulator) {
  for (let bucket = 0; bucket < accumulator.data.length; bucket += 1) {
    const minimum = accumulator.minima[bucket];
    const maximum = accumulator.maxima[bucket];
    if (minimum === Number.POSITIVE_INFINITY || maximum === Number.NEGATIVE_INFINITY) {
      accumulator.gaps[bucket] = 1;
      accumulator.minima[bucket] = Number.NaN;
      accumulator.maxima[bucket] = Number.NaN;
      continue;
    }
    accumulator.data[bucket] = (minimum + maximum) / 2;
  }
}

function makeEnvelopeWindowResult(
  meta: RecordingMeta,
  request: NormalizedWindow,
  accumulators: EnvelopeAccumulator[],
  bucketCount: number,
): EnvelopeWindowData {
  accumulators.forEach(finishEnvelopeAccumulator);
  const effectiveRate = request.durationSec > 0 ? bucketCount / request.durationSec : 0;
  return {
    ...makeWindowResult(
      meta,
      request,
      accumulators.map((entry) => entry.data),
      request.channelIndices.map(() => effectiveRate),
      request.channelIndices.map(() => request.startSec),
    ),
    minima: accumulators.map((entry) => entry.minima),
    maxima: accumulators.map((entry) => entry.maxima),
    gaps: accumulators.map((entry) => entry.gaps),
    bucketDurationSec: request.durationSec > 0 ? request.durationSec / bucketCount : 0,
  };
}

/** Applies the clinical rule independently to mixed-rate raw/display channels. */
export function prepareClinicalDisplaySignals(
  data: readonly Float32Array[],
  sampleRates: readonly number[],
  pixelCount: number,
  sourceStartSampleIndices?: readonly number[],
): ClinicalDisplaySignals {
  if (data.length !== sampleRates.length) {
    throw new Error(`Expected ${data.length} sample rates, received ${sampleRates.length}.`);
  }
  if (sourceStartSampleIndices && sourceStartSampleIndices.length !== data.length) {
    throw new Error(`Expected ${data.length} source start sample indices, received ${sourceStartSampleIndices.length}.`);
  }
  const traces = data.map((channel, index) =>
    decimateClinicalDisplayTrace(
      channel,
      sampleRates[index],
      pixelCount,
      sourceStartSampleIndices?.[index] ?? 0,
    ),
  );
  return {
    data: traces.map((trace) => trace.data),
    sampleRates: traces.map((trace) => trace.sampleRate),
    factors: traces.map((trace) => trace.factor),
    retainedInputSampleOffsets: traces.map((trace) => trace.retainedInputSampleOffset),
    outputStartSampleIndices: traces.map((trace) => trace.outputStartSampleIndex),
    outputStartOffsetSecs: traces.map((trace) => trace.outputStartOffsetSec),
    compensatedGroupDelaySamples: traces.map((trace) => trace.compensatedGroupDelaySamples),
    retainedSampleTimeCorrectionSec: traces.map((trace) => trace.retainedSampleTimeCorrectionSec),
  };
}

export interface RawFlatlineInterval {
  startSec: number;
  endSec: number;
  durationSec: number;
  minimumFlatChannelCount: number;
  totalChannelCount: number;
}

export interface RawFlatlineDetectionOptions {
  startSec?: number;
  /** Optional absolute origin for each channel when raw windows are offset. */
  channelStartSecs?: readonly number[];
  thresholdFraction?: number;
  minimumDurationSec?: number;
  absoluteTolerance?: number;
}

export interface EnvelopeFlatlineDetectionOptions {
  startSec?: number;
  thresholdFraction?: number;
  minimumDurationSec?: number;
  absoluteTolerance?: number;
}

/**
 * Conservatively detects synchronized flat source intervals from exact
 * per-bucket extrema. A bucket is flat only when its finite minimum and
 * maximum match, and adjacent buckets merge only while enough channels keep
 * the same value across their boundary. Partially flat buckets and stepwise
 * signals are therefore never promoted to one long dropout.
 */
export function detectEnvelopeSynchronizedFlatlines(
  minima: readonly Float32Array[],
  maxima: readonly Float32Array[],
  gaps: readonly Uint8Array[],
  bucketDurationSec: number,
  options: EnvelopeFlatlineDetectionOptions = {},
): RawFlatlineInterval[] {
  if (minima.length !== maxima.length || minima.length !== gaps.length) {
    throw new Error("Envelope flatline arrays must have matching channel counts.");
  }
  if (!minima.length) return [];
  if (!(bucketDurationSec > 0) || !Number.isFinite(bucketDurationSec)) {
    throw new Error("Envelope bucket duration must be positive and finite.");
  }
  const bucketCount = minima[0].length;
  if (maxima.some((channel) => channel.length !== bucketCount)
    || minima.some((channel) => channel.length !== bucketCount)
    || gaps.some((channel) => channel.length !== bucketCount)) {
    throw new Error("Envelope flatline channels must have matching bucket counts.");
  }
  const thresholdFraction = options.thresholdFraction ?? 0.8;
  const minimumDurationSec = options.minimumDurationSec ?? 0.25;
  const absoluteTolerance = options.absoluteTolerance ?? 0;
  const startSec = options.startSec ?? 0;
  if (!(thresholdFraction > 0 && thresholdFraction <= 1) || !Number.isFinite(thresholdFraction)) {
    throw new Error("Envelope flatline threshold fraction must be greater than zero and at most one.");
  }
  if (!(minimumDurationSec >= 0) || !Number.isFinite(minimumDurationSec)) {
    throw new Error("Envelope flatline minimum duration must be non-negative and finite.");
  }
  if (!(absoluteTolerance >= 0) || !Number.isFinite(absoluteTolerance)) {
    throw new Error("Envelope flatline tolerance must be non-negative and finite.");
  }
  if (!Number.isFinite(startSec)) throw new Error("Envelope flatline start time must be finite.");

  const requiredChannels = Math.ceil(minima.length * thresholdFraction);
  const output: RawFlatlineInterval[] = [];
  let runStartBucket = -1;
  let runMinimum = Number.POSITIVE_INFINITY;
  let previousFlat = new Uint8Array(minima.length);
  let previousValues = new Float32Array(minima.length);
  const finishRun = (endBucketExclusive: number) => {
    if (runStartBucket < 0) return;
    const durationSec = (endBucketExclusive - runStartBucket) * bucketDurationSec;
    if (durationSec >= minimumDurationSec) {
      output.push({
        startSec: startSec + runStartBucket * bucketDurationSec,
        endSec: startSec + endBucketExclusive * bucketDurationSec,
        durationSec,
        minimumFlatChannelCount: runMinimum,
        totalChannelCount: minima.length,
      });
    }
    runStartBucket = -1;
    runMinimum = Number.POSITIVE_INFINITY;
  };

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const currentFlat = new Uint8Array(minima.length);
    const currentValues = new Float32Array(minima.length);
    let flatChannels = 0;
    for (let channel = 0; channel < minima.length; channel += 1) {
      const minimum = minima[channel][bucket];
      const maximum = maxima[channel][bucket];
      if (!gaps[channel][bucket]
        && Number.isFinite(minimum)
        && Number.isFinite(maximum)
        && Math.abs(maximum - minimum) <= absoluteTolerance) {
        currentFlat[channel] = 1;
        currentValues[channel] = (minimum + maximum) / 2;
        flatChannels += 1;
      }
    }
    let continuousChannels = 0;
    if (bucket > 0) {
      for (let channel = 0; channel < minima.length; channel += 1) {
        if (previousFlat[channel]
          && currentFlat[channel]
          && Math.abs(currentValues[channel] - previousValues[channel]) <= absoluteTolerance) {
          continuousChannels += 1;
        }
      }
    }
    const bucketQualifies = flatChannels >= requiredChannels;
    const canExtend = runStartBucket >= 0
      && bucketQualifies
      && continuousChannels >= requiredChannels;
    if (canExtend) {
      runMinimum = Math.min(runMinimum, continuousChannels);
    } else {
      finishRun(bucket);
      if (bucketQualifies) {
        runStartBucket = bucket;
        runMinimum = flatChannels;
      }
    }
    previousFlat = currentFlat;
    previousValues = currentValues;
  }
  finishRun(bucketCount);
  return output;
}

interface ChannelFlatlineInterval {
  startSec: number;
  endSec: number;
}

/**
 * Detects intervals where at least 80% of raw source channels remain unchanged
 * together for at least 250 ms. NaNs break a channel's run and all supplied
 * channels remain in the threshold denominator, which is conservative for
 * missing data and mixed sample rates.
 */
export function detectRawSynchronizedFlatlines(
  data: readonly Float32Array[],
  sampleRates: readonly number[],
  options: RawFlatlineDetectionOptions = {},
): RawFlatlineInterval[] {
  if (data.length !== sampleRates.length) {
    throw new Error(`Expected ${data.length} sample rates, received ${sampleRates.length}.`);
  }
  if (options.channelStartSecs && options.channelStartSecs.length !== data.length) {
    throw new Error(`Expected ${data.length} channel start times, received ${options.channelStartSecs.length}.`);
  }
  if (data.length === 0) return [];
  const thresholdFraction = options.thresholdFraction ?? 0.8;
  const minimumDurationSec = options.minimumDurationSec ?? 0.25;
  const absoluteTolerance = options.absoluteTolerance ?? 0;
  const startSec = options.startSec ?? 0;
  if (!(thresholdFraction > 0 && thresholdFraction <= 1) || !Number.isFinite(thresholdFraction)) {
    throw new Error("Raw flatline threshold fraction must be greater than zero and at most one.");
  }
  if (!(minimumDurationSec >= 0) || !Number.isFinite(minimumDurationSec)) {
    throw new Error("Raw flatline minimum duration must be non-negative and finite.");
  }
  if (!(absoluteTolerance >= 0) || !Number.isFinite(absoluteTolerance)) {
    throw new Error("Raw flatline tolerance must be non-negative and finite.");
  }
  if (!Number.isFinite(startSec)) throw new Error("Raw flatline start time must be finite.");
  if (options.channelStartSecs?.some((channelStartSec) => !Number.isFinite(channelStartSec))) {
    throw new Error("Raw flatline channel start times must be finite.");
  }

  const intervals: ChannelFlatlineInterval[] = [];
  data.forEach((channel, channelIndex) => {
    const sampleRate = sampleRates[channelIndex];
    const channelStartSec = options.channelStartSecs?.[channelIndex] ?? startSec;
    if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) {
      throw new Error(`Sample rate for channel ${channelIndex + 1} must be positive and finite.`);
    }
    let runStartSample = -1;
    for (let sample = 1; sample < channel.length; sample += 1) {
      const previous = channel[sample - 1];
      const current = channel[sample];
      const unchanged = Number.isFinite(previous)
        && Number.isFinite(current)
        && Math.abs(current - previous) <= absoluteTolerance;
      if (unchanged) {
        if (runStartSample < 0) runStartSample = sample - 1;
      } else if (runStartSample >= 0) {
        const runEndSample = sample - 1;
        if ((runEndSample - runStartSample) / sampleRate >= minimumDurationSec) {
          intervals.push({
            startSec: channelStartSec + runStartSample / sampleRate,
            endSec: channelStartSec + runEndSample / sampleRate,
          });
        }
        runStartSample = -1;
      }
    }
    if (runStartSample >= 0) {
      const runEndSample = channel.length - 1;
      if ((runEndSample - runStartSample) / sampleRate >= minimumDurationSec) {
        intervals.push({
          startSec: channelStartSec + runStartSample / sampleRate,
          endSec: channelStartSec + runEndSample / sampleRate,
        });
      }
    }
  });
  if (!intervals.length) return [];

  const events = intervals.flatMap((interval) => [
    { timeSec: interval.startSec, delta: 1 },
    { timeSec: interval.endSec, delta: -1 },
  ]).sort((first, second) => first.timeSec - second.timeSec || first.delta - second.delta);
  const requiredChannels = Math.ceil(data.length * thresholdFraction);
  const output: RawFlatlineInterval[] = [];
  let activeChannels = 0;
  let eventIndex = 0;
  let regionStart: number | undefined;
  let regionEnd = 0;
  let regionMinimum = Number.POSITIVE_INFINITY;

  while (eventIndex < events.length) {
    const segmentStart = events[eventIndex].timeSec;
    while (eventIndex < events.length && events[eventIndex].timeSec === segmentStart) {
      activeChannels += events[eventIndex].delta;
      eventIndex += 1;
    }
    const segmentEnd = events[eventIndex]?.timeSec;
    const isQualifyingSegment = segmentEnd !== undefined
      && segmentEnd > segmentStart
      && activeChannels >= requiredChannels;
    if (isQualifyingSegment) {
      if (regionStart === undefined) regionStart = segmentStart;
      regionEnd = segmentEnd;
      regionMinimum = Math.min(regionMinimum, activeChannels);
    } else if (regionStart !== undefined) {
      const durationSec = regionEnd - regionStart;
      if (durationSec >= minimumDurationSec) {
        output.push({
          startSec: regionStart,
          endSec: regionEnd,
          durationSec,
          minimumFlatChannelCount: regionMinimum,
          totalChannelCount: data.length,
        });
      }
      regionStart = undefined;
      regionMinimum = Number.POSITIVE_INFINITY;
    }
  }
  if (regionStart !== undefined) {
    const durationSec = regionEnd - regionStart;
    if (durationSec >= minimumDurationSec) {
      output.push({
        startSec: regionStart,
        endSec: regionEnd,
        durationSec,
        minimumFlatChannelCount: regionMinimum,
        totalChannelCount: data.length,
      });
    }
  }
  return output;
}

// ---------------------------------------------------------------------------
// Display-only digital filters
// ---------------------------------------------------------------------------

export interface DisplayFilterSettings {
  enabled: boolean;
  highPassHz: number;
  lowPassHz: number;
  /** Zero disables the line-frequency notch. */
  notchHz: 0 | 50 | 60;
  notchQ?: number;
  /** Forward-backward filtering removes display phase delay. Defaults to true. */
  zeroPhase?: boolean;
}

interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function designBiquad(
  kind: "highpass" | "lowpass" | "notch",
  frequency: number,
  sampleRate: number,
  q: number,
): BiquadCoefficients | null {
  if (!(frequency > 0) || !(sampleRate > 0) || frequency >= sampleRate / 2 || !(q > 0)) return null;
  const omega = 2 * Math.PI * frequency / sampleRate;
  const cosine = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * q);
  let b0: number;
  let b1: number;
  let b2: number;
  if (kind === "lowpass") {
    b0 = (1 - cosine) / 2;
    b1 = 1 - cosine;
    b2 = b0;
  } else if (kind === "highpass") {
    b0 = (1 + cosine) / 2;
    b1 = -(1 + cosine);
    b2 = b0;
  } else {
    b0 = 1;
    b1 = -2 * cosine;
    b2 = 1;
  }
  const a0 = 1 + alpha;
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: -2 * cosine / a0,
    a2: (1 - alpha) / a0,
  };
}

function biquadPass(input: Float32Array, coefficients: BiquadCoefficients): Float32Array {
  const output = new Float32Array(input.length);
  const denominator = 1 + coefficients.a1 + coefficients.a2;
  let z1 = 0;
  let z2 = 0;
  let initialized = false;
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];
    if (!Number.isFinite(value)) {
      output[index] = value;
      z1 = 0;
      z2 = 0;
      initialized = false;
      continue;
    }
    if (!initialized) {
      const gain = Math.abs(denominator) > 1e-12
        ? (coefficients.b0 + coefficients.b1 + coefficients.b2) / denominator
        : 1;
      const steadyOutput = gain * value;
      z1 = steadyOutput - coefficients.b0 * value;
      z2 = coefficients.b2 * value - coefficients.a2 * steadyOutput;
      initialized = true;
    }
    const filtered = coefficients.b0 * value + z1;
    z1 = coefficients.b1 * value - coefficients.a1 * filtered + z2;
    z2 = coefficients.b2 * value - coefficients.a2 * filtered;
    output[index] = filtered;
  }
  return output;
}

function reverseFloat32(input: Float32Array): Float32Array {
  const output = new Float32Array(input.length);
  for (let index = 0; index < input.length; index += 1) output[index] = input[input.length - 1 - index];
  return output;
}

function applyBiquad(
  input: Float32Array,
  coefficients: BiquadCoefficients,
  zeroPhase: boolean,
): Float32Array {
  const forward = biquadPass(input, coefficients);
  if (!zeroPhase || input.length < 3) return forward;
  return reverseFloat32(biquadPass(reverseFloat32(forward), coefficients));
}

export function applyDisplayFilters(
  data: readonly Float32Array[],
  sampleRates: readonly number[],
  settings: DisplayFilterSettings,
): Float32Array[] {
  if (sampleRates.length !== data.length) {
    throw new Error(`Expected ${data.length} sample rates, received ${sampleRates.length}.`);
  }
  if (settings.enabled === false) return data.map((channel) => channel.slice());
  const zeroPhase = settings.zeroPhase !== false;
  const q = settings.notchQ && settings.notchQ > 0 ? settings.notchQ : 30;

  return data.map((input, index) => {
    const sampleRate = sampleRates[index];
    if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) {
      throw new Error(`Sample rate for channel ${index + 1} must be positive and finite.`);
    }
    let output: Float32Array = input.slice();
    const highpass = designBiquad("highpass", settings.highPassHz, sampleRate, Math.SQRT1_2);
    const notch = designBiquad("notch", settings.notchHz, sampleRate, q);
    const lowpass = designBiquad("lowpass", settings.lowPassHz, sampleRate, Math.SQRT1_2);
    if (highpass) output = applyBiquad(output, highpass, zeroPhase);
    if (notch) output = applyBiquad(output, notch, zeroPhase);
    if (lowpass) output = applyBiquad(output, lowpass, zeroPhase);
    return output;
  });
}

// ---------------------------------------------------------------------------
// Referential, average-reference, and adjacent-contact bipolar montages
// ---------------------------------------------------------------------------

export type MontageMode = "referential" | "average" | "average-reference" | "bipolar";

export interface MontageResult {
  data: Float32Array[];
  labels: string[];
  /** Optional compatibility field; callers may retain source window rates. */
  sampleRates?: number[];
  /** Absolute time represented by sample zero of each returned channel. */
  sampleStartSecs?: number[];
  /** Original zero-based source indices contributing to each derived channel. */
  sourceIndices: number[][];
  /** Source index represented by the row before any reference contribution. */
  primarySourceIndices: number[];
  mode: MontageMode;
  warnings: string[];
}

type BadChannelSet = ReadonlySet<number | string>;

function channelIsBad(index: number, label: string, badChannels: BadChannelSet): boolean {
  if (badChannels.has(index) || badChannels.has(label)) return true;
  const normalized = label.trim().toLowerCase();
  for (const entry of badChannels) {
    if (typeof entry === "string" && entry.trim().toLowerCase() === normalized) return true;
  }
  return false;
}

const STANDARD_SCALP_LABELS = new Set([
  "FP1", "FP2", "FPZ", "F3", "F4", "F7", "F8", "FZ", "FC1", "FC2", "FC5", "FC6",
  "C3", "C4", "CZ", "T3", "T4", "T5", "T6", "T7", "T8", "TP9", "TP10", "P3", "P4",
  "P7", "P8", "PZ", "O1", "O2", "OZ", "A1", "A2", "M1", "M2",
]);

const LEGACY_AUXILIARY_GROUPS = new Set([
  "DC", "MARK", "E", "C", "EX", "F", "REF", "GND", "ECG", "EKG", "EMG",
  "EOG", "TRIG", "SYNC", "AUX", "STI",
]);

interface ContactLabel {
  sourceIndex: number;
  actualLabel: string;
  group: string;
  contact: number;
}

function parseContactLabel(label: string, sourceIndex: number): ContactLabel | null {
  const cleaned = label
    .trim()
    .replace(/^EEG\s+/i, "")
    .replace(/(?:[-_\s]+(?:REF|LE|AR|AVG))$/i, "")
    .trim();
  const canonical = cleaned.replace(/[\s_-]/g, "").toUpperCase();
  if (STANDARD_SCALP_LABELS.has(canonical)) return null;
  const match = /^(.*?)(\d+)$/.exec(cleaned);
  if (!match || !/[A-Za-z]/.test(match[1])) return null;
  const contact = Number(match[2]);
  if (!Number.isSafeInteger(contact)) return null;
  const group = match[1].replace(/[\s_-]+/g, "").toUpperCase();
  if (LEGACY_AUXILIARY_GROUPS.has(group)) return null;
  return { sourceIndex, actualLabel: label, group, contact };
}

/**
 * Returns the anatomical depth-electrode group used by the legacy MATLAB
 * reviewer. Bipolar display labels such as LA1–LA2 resolve to the same LA
 * group, while the MATLAB reviewer's explicitly auxiliary groups return null.
 */
export function anatomicalChannelGroup(label: string): string | null {
  const cleaned = label
    .trim()
    .replace(/^EEG\s+/i, "")
    .replace(/(?:[-_\s]+(?:REF|LE|AR|AVG))$/i, "")
    .trim();
  // Only the first contact establishes the group. This also handles derived
  // labels such as "EEG LA1-REF–EEG LA2-REF" without confusing reference
  // suffix hyphens with the bipolar separator.
  const match = /^([A-Za-z]+)[\s_-]*(\d+)/.exec(cleaned);
  if (!match) return null;
  const group = match[1].replace(/[\s_-]+/g, "").toUpperCase();
  if (LEGACY_AUXILIARY_GROUPS.has(group)) return null;
  return group;
}

/**
 * Reproduces the MATLAB reviewer's stable left/right/other ordering without
 * changing the source-channel identity carried by each row.
 */
export function orderAnatomicalChannelIndices(
  labels: readonly string[],
  indices: readonly number[] = labels.map((_, index) => index),
): number[] {
  return indices
    .map((sourceIndex, position) => {
      const group = anatomicalChannelGroup(labels[sourceIndex] ?? "");
      const side = group?.startsWith("L") ? 0 : group?.startsWith("R") ? 1 : group ? 2 : 3;
      return { sourceIndex, position, side };
    })
    .sort((left, right) => left.side - right.side || left.position - right.position)
    .map(({ sourceIndex }) => sourceIndex);
}

export function buildMontage(
  data: readonly Float32Array[],
  labels: readonly string[],
  mode: MontageMode,
  badChannels: BadChannelSet = new Set<number | string>(),
  sampleRates?: readonly number[],
  sampleStartSecs?: readonly number[],
): MontageResult {
  if (data.length !== labels.length) {
    throw new Error(`Montage received ${data.length} signals but ${labels.length} labels.`);
  }
  if (sampleRates && sampleRates.length !== data.length) {
    throw new Error(`Montage received ${data.length} signals but ${sampleRates.length} sample rates.`);
  }
  if (sampleStartSecs && sampleStartSecs.length !== data.length) {
    throw new Error(`Montage received ${data.length} signals but ${sampleStartSecs.length} sample start times.`);
  }
  if (sampleStartSecs?.some((startSec) => !Number.isFinite(startSec))) {
    throw new Error("Montage sample start times must be finite.");
  }
  const validIndices = data
    .map((_, index) => index)
    .filter((index) => !channelIsBad(index, labels[index], badChannels));
  const warnings: string[] = [];

  if (mode === "referential") {
    const allIndices = data.map((_, index) => index);
    return {
      data: allIndices.map((index) => data[index]),
      labels: allIndices.map((index) => labels[index]),
      sampleRates: sampleRates ? allIndices.map((index) => sampleRates[index]) : undefined,
      sampleStartSecs: sampleStartSecs ? allIndices.map((index) => sampleStartSecs[index]) : undefined,
      sourceIndices: allIndices.map((index) => [index]),
      primarySourceIndices: allIndices,
      mode,
      warnings,
    };
  }

  if (mode === "average" || mode === "average-reference") {
    if (validIndices.length === 0) {
      warnings.push("No usable channels remain after bad-channel exclusion.");
      return {
        data: [],
        labels: [],
        sampleStartSecs: sampleStartSecs ? [] : undefined,
        sourceIndices: [],
        primarySourceIndices: [],
        mode,
        warnings,
      };
    }
    const sampleCount = data[validIndices[0]].length;
    const referenceRate = sampleRates?.[validIndices[0]];
    const referenceStartSec = sampleStartSecs?.[validIndices[0]];
    if (referenceRate !== undefined && validIndices.some((index) => Math.abs((sampleRates?.[index] ?? referenceRate) - referenceRate) > 1e-9)) {
      throw new Error("Average reference requires equal sampling rates. Resample mixed-rate EDF channels first.");
    }
    if (validIndices.some((index) => data[index].length !== sampleCount)) {
      throw new Error("Average reference requires equal-length channels. Resample mixed-rate EDF channels first.");
    }
    if (referenceStartSec !== undefined && validIndices.some(
      (index) => Math.abs((sampleStartSecs?.[index] ?? referenceStartSec) - referenceStartSec) > 1e-9,
    )) {
      throw new Error("Average reference requires channels with aligned sample start times.");
    }
    const average = new Float64Array(sampleCount);
    const counts = new Uint32Array(sampleCount);
    for (const index of validIndices) {
      const channel = data[index];
      for (let sample = 0; sample < sampleCount; sample += 1) {
        if (Number.isFinite(channel[sample])) {
          average[sample] += channel[sample];
          counts[sample] += 1;
        }
      }
    }
    for (let sample = 0; sample < sampleCount; sample += 1) {
      if (counts[sample]) average[sample] /= counts[sample];
      else average[sample] = Number.NaN;
    }
    const output = validIndices.map((index) => {
      const channel = new Float32Array(sampleCount);
      for (let sample = 0; sample < sampleCount; sample += 1) {
        channel[sample] = Number.isFinite(data[index][sample]) && Number.isFinite(average[sample])
          ? data[index][sample] - average[sample]
          : Number.NaN;
      }
      return channel;
    });
    return {
      data: output,
      labels: validIndices.map((index) => `${labels[index]} (CAR)`),
      sampleRates: referenceRate === undefined ? undefined : validIndices.map(() => referenceRate),
      sampleStartSecs: referenceStartSec === undefined
        ? undefined
        : validIndices.map(() => referenceStartSec),
      sourceIndices: validIndices.map(() => [...validIndices]),
      primarySourceIndices: validIndices,
      mode,
      warnings,
    };
  }

  const groups = new Map<string, ContactLabel[]>();
  for (const index of validIndices) {
    const contact = parseContactLabel(labels[index], index);
    if (!contact) continue;
    const group = groups.get(contact.group) ?? [];
    group.push(contact);
    groups.set(contact.group, group);
  }
  const outputData: Float32Array[] = [];
  const outputLabels: string[] = [];
  const sourceIndices: number[][] = [];
  const primarySourceIndices: number[] = [];
  const outputSampleStartSecs: number[] = [];
  for (const contacts of groups.values()) {
    contacts.sort((a, b) => a.contact - b.contact || a.sourceIndex - b.sourceIndex);
    for (let index = 0; index < contacts.length - 1; index += 1) {
      const first = contacts[index];
      const second = contacts[index + 1];
      // Never bridge missing/bad contacts; only true N-to-N+1 electrode neighbors.
      if (second.contact !== first.contact + 1) continue;
      if (contacts[index + 2]?.contact === second.contact) continue;
      const firstData = data[first.sourceIndex];
      const secondData = data[second.sourceIndex];
      const firstRate = sampleRates?.[first.sourceIndex];
      const secondRate = sampleRates?.[second.sourceIndex];
      if (firstRate !== undefined && secondRate !== undefined && Math.abs(firstRate - secondRate) > 1e-9) {
        warnings.push(`${first.actualLabel}–${second.actualLabel} was omitted because ${firstRate} Hz and ${secondRate} Hz channels cannot be subtracted without resampling.`);
        continue;
      }
      const firstStartSec = sampleStartSecs?.[first.sourceIndex];
      const secondStartSec = sampleStartSecs?.[second.sourceIndex];
      if (firstStartSec !== undefined
        && secondStartSec !== undefined
        && Math.abs(firstStartSec - secondStartSec) > 1e-9) {
        warnings.push(`${first.actualLabel}–${second.actualLabel} was omitted because their sample start times (${firstStartSec} s and ${secondStartSec} s) are not aligned.`);
        continue;
      }
      const sampleCount = Math.min(firstData.length, secondData.length);
      if (firstData.length !== secondData.length) {
        warnings.push(`${first.actualLabel}–${second.actualLabel} was clipped to the shorter equal-rate window.`);
      }
      const derived = new Float32Array(sampleCount);
      for (let sample = 0; sample < sampleCount; sample += 1) {
        // Conventional label polarity: A1–A2 means A1 minus A2.
        derived[sample] = firstData[sample] - secondData[sample];
      }
      outputData.push(derived);
      outputLabels.push(`${first.actualLabel}–${second.actualLabel}`);
      sourceIndices.push([first.sourceIndex, second.sourceIndex]);
      primarySourceIndices.push(first.sourceIndex);
      if (firstStartSec !== undefined) outputSampleStartSecs.push(firstStartSec);
    }
  }
  if (outputData.length === 0) {
    warnings.push("No adjacent numbered electrode contacts were available for a bipolar derivation.");
  }
  return {
    data: outputData,
    labels: outputLabels,
    sampleRates: sampleRates ? primarySourceIndices.map((index) => sampleRates[index]) : undefined,
    sampleStartSecs: sampleStartSecs ? outputSampleStartSecs : undefined,
    sourceIndices,
    primarySourceIndices,
    mode,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Export helpers
// ---------------------------------------------------------------------------

export function formatClock(seconds: number, withMs = false): string {
  if (!Number.isFinite(seconds)) return withMs ? "--:--:--.---" : "--:--:--";
  const negative = seconds < 0;
  const absolute = Math.abs(seconds);
  const totalMilliseconds = withMs ? Math.round(absolute * 1000) : Math.floor(absolute) * 1000;
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor(totalMilliseconds % 3_600_000 / 60_000);
  const wholeSeconds = Math.floor(totalMilliseconds % 60_000 / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return `${negative ? "−" : ""}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}${withMs ? `.${String(milliseconds).padStart(3, "0")}` : ""}`;
}

/** Backwards-compatible name used by earlier viewer prototypes. */
export const formatTime = formatClock;

export function csvEscape(value: unknown): string {
  let text: string;
  if (value == null) text = "";
  else if (value instanceof Date) text = value.toISOString();
  else if (typeof value === "object") {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  } else text = String(value);
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

/** FNV-1a-based stable identifier for persisted entities derived from known input. */
export function deterministicId(seed: string, prefix = "id"): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const safePrefix = prefix.replace(/[^a-z0-9_-]/gi, "-") || "id";
  return `${safePrefix}-${(hash >>> 0).toString(36).padStart(7, "0")}`;
}

/** Collision-resistant IDs remain safe when recovered annotations survive a reload. */
export function makeId(prefix = "ann"): string {
  const safePrefix = prefix.replace(/[^a-z0-9_-]/gi, "-") || "id";
  const cryptoObject = globalThis.crypto;
  if (typeof cryptoObject?.randomUUID === "function") {
    return `${safePrefix}-${cryptoObject.randomUUID()}`;
  }
  const bytes = new Uint8Array(16);
  if (typeof cryptoObject?.getRandomValues === "function") {
    cryptoObject.getRandomValues(bytes);
  } else {
    // Last-resort compatibility path for older non-secure browser contexts.
    const timestamp = Date.now();
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256) ^ (timestamp >>> (index % 6 * 8));
    }
  }
  const randomText = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${safePrefix}-${Date.now().toString(36)}-${randomText}`;
}
