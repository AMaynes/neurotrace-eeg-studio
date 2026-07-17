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
  startSec: number;
  durationSec: number;
  channelIndices: number[];
  channelLabels: string[];
  channelUnits: string[];
}

export interface SignalSource {
  readonly meta: RecordingMeta;
  getWindow(
    startSec: number,
    durationSec: number,
    channelIndices?: readonly number[],
  ): Promise<WindowData>;
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
): WindowData {
  return {
    data,
    sampleRates: sampleRates ?? request.channelIndices.map((index) => meta.sampleRates[index]),
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
  ): Promise<WindowData> {
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
    return makeWindowResult(this.meta, request, data, sampleRates);
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
  if (isDiscontinuous) {
    warnings.push("EDF+D discontinuities are displayed on a contiguous record-time axis; annotation timekeeping may contain gaps.");
  }

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

function parseEdfTalText(text: string): SourceEvent[] {
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

export async function parseEDFAnnotations(file: File, header: EDFHeader): Promise<{ events: SourceEvent[]; warnings: string[] }> {
  const annotationSignals = header.signals.filter((signal) => signal.isAnnotation);
  if (!annotationSignals.length) return { events: [], warnings: [] };
  const events: SourceEvent[] = [];
  const warnings: string[] = [];
  const recordsPerChunk = Math.max(1, Math.floor((4 * 1024 * 1024) / Math.max(1, header.bytesPerDataRecord)));

  for (let firstRecord = 0; firstRecord < header.dataRecordCount; firstRecord += recordsPerChunk) {
    const recordCount = Math.min(recordsPerChunk, header.dataRecordCount - firstRecord);
    const byteStart = header.headerBytes + firstRecord * header.bytesPerDataRecord;
    const byteEnd = byteStart + recordCount * header.bytesPerDataRecord;
    const bytes = new Uint8Array(await file.slice(byteStart, byteEnd).arrayBuffer());
    for (let localRecord = 0; localRecord < recordCount; localRecord += 1) {
      const recordOffset = localRecord * header.bytesPerDataRecord;
      for (const signal of annotationSignals) {
        const start = recordOffset + signal.byteOffsetInRecord;
        const end = start + signal.samplesPerRecord * 2;
        events.push(...parseEdfTalText(latin1Decoder.decode(bytes.subarray(start, end))));
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

export class EDFSource implements SignalSource {
  readonly meta: RecordingMeta;
  readonly header: EDFHeader;
  readonly events: SourceEvent[];
  private readonly file: File;
  private readonly displaySignals: EDFSignalHeader[];

  private constructor(file: File, header: EDFHeader, events: SourceEvent[], annotationWarnings: string[]) {
    this.file = file;
    this.header = header;
    this.events = events;
    this.displaySignals = header.signals.filter((signal) => !signal.isAnnotation);
    if (this.displaySignals.length === 0) {
      throw new SignalFileError("INVALID_HEADER", "The EDF contains an annotation channel but no displayable signal channels.");
    }
    this.meta = {
      id: deterministicId(`${file.name}:${file.size}:${file.lastModified}`, "rec"),
      name: file.name,
      fileName: file.name,
      format: header.isEDFPlus ? "edf+" : "edf",
      durationSec: header.dataRecordCount * header.dataRecordDurationSec,
      channelCount: this.displaySignals.length,
      channelLabels: this.displaySignals.map((signal) => signal.label),
      channelUnits: this.displaySignals.map((signal) => signal.physicalDimension),
      units: this.displaySignals.map((signal) => signal.physicalDimension),
      sampleRates: this.displaySignals.map((signal) => signal.sampleRate),
      sampleRate: this.displaySignals[0].sampleRate,
      byteLength: file.size,
      patientId: header.patientIdentification.split(/\s+/)[0] || undefined,
      recordingId: header.recordingIdentification || undefined,
      startedAt: header.startedAt,
      startDateTime: header.startedAt?.toISOString(),
      warnings: [...header.warnings, ...annotationWarnings],
      assumptions: header.startedAt ? ["EDF start clock timezone is not specified; preserved as source-local wall time."] : [],
      details: {
        dataRecords: header.dataRecordCount,
        dataRecordDurationSec: header.dataRecordDurationSec,
        annotationChannels: header.signals.filter((signal) => signal.isAnnotation).length,
        discontinuous: header.isDiscontinuous,
      },
    };
  }

  static async create(file: File): Promise<EDFSource> {
    const header = await parseEDFHeader(file);
    const annotations = await parseEDFAnnotations(file, header);
    return new EDFSource(file, header, annotations.events, annotations.warnings);
  }

  async getWindow(
    startSec: number,
    durationSec: number,
    channelIndices?: readonly number[],
  ): Promise<WindowData> {
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
      return makeWindowResult(this.meta, request, sampleRanges.map((range) => range.output));
    }

    const firstRecord = Math.floor(request.startSec / this.header.dataRecordDurationSec);
    const lastRecordExclusive = Math.min(
      this.header.dataRecordCount,
      Math.ceil(request.endSec / this.header.dataRecordDurationSec),
    );
    // Keep slices moderate while still amortizing File/Blob overhead.
    const recordsPerChunk = Math.max(1, Math.floor((8 * 1024 * 1024) / this.header.bytesPerDataRecord));

    for (let chunkRecord = firstRecord; chunkRecord < lastRecordExclusive; chunkRecord += recordsPerChunk) {
      const chunkEndRecord = Math.min(lastRecordExclusive, chunkRecord + recordsPerChunk);
      const byteStart = this.header.headerBytes + chunkRecord * this.header.bytesPerDataRecord;
      const byteEnd = this.header.headerBytes + chunkEndRecord * this.header.bytesPerDataRecord;
      const view = new DataView(await this.file.slice(byteStart, byteEnd).arrayBuffer());

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
          const usePhysicalScaling = digitalSpan !== 0 && Number.isFinite(physicalSpan);
          const scale = usePhysicalScaling ? physicalSpan / digitalSpan : 1;
          const offset = usePhysicalScaling
            ? signal.physicalMinimum - signal.digitalMinimum * scale
            : 0;
          for (let sample = copyFirst; sample < copyEnd; sample += 1) {
            const inRecord = sample - recordFirstSample;
            const digital = view.getInt16(
              localRecordByte + signal.byteOffsetInRecord + inRecord * 2,
              true,
            );
            range.output[sample - range.first] = digital * scale + offset;
          }
        });
      }
    }

    return makeWindowResult(
      this.meta,
      request,
      sampleRanges.map((range) => range.output),
      selected.map((signal) => signal.sampleRate),
    );
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
    const warnings = [
      "Headerless DAT interpretation assumes sample-major, channel-interleaved signed 16-bit little-endian values. Confirm the mapping before clinical review.",
      ...(options.warnings ?? []),
    ];
    if (trailingBytes) warnings.push(`Ignored ${trailingBytes} trailing byte(s) that do not form a complete sample frame.`);
    if (!options.physicalScale) warnings.push("No physical scale was supplied; raw digital counts are displayed as arbitrary units.");

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
  ): Promise<WindowData> {
    const request = normalizeWindowRequest(this.meta, startSec, durationSec, channelIndices);
    const sampleRate = this.meta.sampleRates[0];
    const firstSample = Math.floor(request.startSec * sampleRate);
    const endSample = Math.min(this.totalSamples, Math.ceil(request.endSec * sampleRate));
    const sampleCount = Math.max(0, endSample - firstSample);
    const outputs = request.channelIndices.map(() => new Float32Array(sampleCount));
    if (sampleCount === 0 || outputs.length === 0) return makeWindowResult(this.meta, request, outputs);

    const bytesPerFrame = this.meta.channelCount * 2;
    const framesPerChunk = Math.max(1, Math.floor((8 * 1024 * 1024) / bytesPerFrame));
    for (let chunkStart = firstSample; chunkStart < endSample; chunkStart += framesPerChunk) {
      const chunkEnd = Math.min(endSample, chunkStart + framesPerChunk);
      const byteStart = chunkStart * bytesPerFrame;
      const view = new DataView(await this.file.slice(byteStart, chunkEnd * bytesPerFrame).arrayBuffer());
      for (let sample = chunkStart; sample < chunkEnd; sample += 1) {
        const localFrameByte = (sample - chunkStart) * bytesPerFrame;
        request.channelIndices.forEach((channelIndex, outputIndex) => {
          const digital = view.getInt16(localFrameByte + channelIndex * 2, true);
          outputs[outputIndex][sample - firstSample] =
            digital * this.scale[channelIndex] + this.physicalOffset[channelIndex];
        });
      }
    }
    return makeWindowResult(this.meta, request, outputs);
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
    return makeWindowResult(this.meta, request, data);
  }
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
  return { sourceIndex, actualLabel: label, group, contact };
}

export function buildMontage(
  data: readonly Float32Array[],
  labels: readonly string[],
  mode: MontageMode,
  badChannels: BadChannelSet = new Set<number | string>(),
  sampleRates?: readonly number[],
): MontageResult {
  if (data.length !== labels.length) {
    throw new Error(`Montage received ${data.length} signals but ${labels.length} labels.`);
  }
  if (sampleRates && sampleRates.length !== data.length) {
    throw new Error(`Montage received ${data.length} signals but ${sampleRates.length} sample rates.`);
  }
  const validIndices = data
    .map((_, index) => index)
    .filter((index) => !channelIsBad(index, labels[index], badChannels));
  const warnings: string[] = [];

  if (mode === "referential") {
    return {
      data: validIndices.map((index) => data[index].slice()),
      labels: validIndices.map((index) => labels[index]),
      sampleRates: sampleRates ? validIndices.map((index) => sampleRates[index]) : undefined,
      sourceIndices: validIndices.map((index) => [index]),
      primarySourceIndices: validIndices,
      mode,
      warnings,
    };
  }

  if (mode === "average" || mode === "average-reference") {
    if (validIndices.length === 0) {
      warnings.push("No usable channels remain after bad-channel exclusion.");
      return { data: [], labels: [], sourceIndices: [], primarySourceIndices: [], mode, warnings };
    }
    const sampleCount = data[validIndices[0]].length;
    const referenceRate = sampleRates?.[validIndices[0]];
    if (referenceRate !== undefined && validIndices.some((index) => Math.abs((sampleRates?.[index] ?? referenceRate) - referenceRate) > 1e-9)) {
      throw new Error("Average reference requires equal sampling rates. Resample mixed-rate EDF channels first.");
    }
    if (validIndices.some((index) => data[index].length !== sampleCount)) {
      throw new Error("Average reference requires equal-length channels. Resample mixed-rate EDF channels first.");
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
    }
  }
  if (outputData.length === 0) {
    warnings.push("No adjacent numbered electrode contacts were available for a bipolar derivation.");
  }
  return {
    data: outputData,
    labels: outputLabels,
    sampleRates: sampleRates ? primarySourceIndices.map((index) => sampleRates[index]) : undefined,
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

let generatedIdCounter = 0;

/** Deterministic, monotonic IDs for ephemeral client-side annotations. */
export function makeId(prefix = "ann"): string {
  generatedIdCounter += 1;
  const safePrefix = prefix.replace(/[^a-z0-9_-]/gi, "-") || "id";
  return `${safePrefix}-${generatedIdCounter.toString(36).padStart(6, "0")}`;
}
