"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  DemoSource,
  EDFSource,
  MatSource,
  RawDatSource,
  applyDisplayFilters,
  buildMontage,
  formatClock,
  makeId,
  parseLegacyMatMetadata,
  type DisplayFilterSettings,
  type LegacyMatMetadata,
  type MontageMode,
  type RecordingMeta,
  type SignalSource,
} from "./eeg-core";
import { sha256Blob } from "./source-integrity";

type Reliability = "gold" | "silver" | "bronze" | "gray";
type Geometry = "point" | "interval" | "window" | "session";
type TrackId = "context" | "windowed" | "instance";
type AnnotationStatus = "draft" | "committed" | "suggestion";
type AnnotationOrigin = "manual" | "imported" | "detector" | "legacy";

type LabelDefinition = {
  id: string;
  name: string;
  short: string;
  color: string;
  geometry: Geometry;
  track: TrackId;
  defaultDuration: number;
  category: "Context" | "Seizure" | "Rhythmic / periodic" | "Sleep stage" | "Quality" | "Instance";
  shortcut?: string;
  hidden?: boolean;
};

type ChannelScope = {
  displayLabel: string;
  montage: MontageMode;
  primarySourceIndex: number;
  sourceIndices: number[];
  sourceLabels: string[];
};

type Annotation = {
  id: string;
  labelId: string;
  start: number;
  end: number;
  track: TrackId;
  geometry: Geometry;
  channels: number[];
  confidence: number;
  reliability: Reliability;
  origin: AnnotationOrigin;
  reviewer: string;
  notes: string;
  status: AnnotationStatus;
  candidateId?: string;
  channelScope?: ChannelScope;
  revisions?: Array<{
    revision: number;
    committedAt: string;
    labelId: string;
    start: number;
    end: number;
    confidence: number;
    reviewer: string;
    notes: string;
    reliability: Reliability;
    origin: AnnotationOrigin;
    geometry: Geometry;
    track: TrackId;
    channels: number[];
    channelScope?: ChannelScope;
    sourceHash: string;
    sourceContentHash: string;
    candidateId?: string;
    displaySnapshot: {
      montage: MontageMode;
      filters: DisplayFilterSettings;
      gain: number;
      snapMode: "1s" | "100ms" | "sample";
      selectedSourceChannels: number[];
      badSourceChannels: number[];
    };
    sourceSnapshot: {
      format: RecordingMeta["format"];
      durationSec: number;
      sampleRates: number[];
      assumptions: string[];
      warnings: string[];
      interpretation?: Record<string, unknown>;
    };
  }>;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type Candidate = {
  id: string;
  time: number;
  label: string;
  source: Reliability;
  status: "active" | "queued" | "reviewed" | "skipped" | "conflict";
};

type DisplayWindow = {
  data: Float32Array[];
  labels: string[];
  sampleRates: number[];
  sourceIndices: number[][];
  primarySourceIndices: number[];
  warnings: string[];
};

const LABELS: LabelDefinition[] = [
  { id: "session-context", name: "Entire-session context", short: "SESSION", color: "#8db7f3", geometry: "session", track: "context", defaultDuration: 0, category: "Context" },
  { id: "laterality", name: "Lateralization / locality", short: "LOCALITY", color: "#b99cf7", geometry: "session", track: "context", defaultDuration: 0, category: "Context" },
  { id: "note", name: "Monitoring note", short: "NOTE", color: "#8db7f3", geometry: "interval", track: "context", defaultDuration: 5, category: "Context" },
  { id: "medication", name: "Medication context", short: "MED", color: "#78d5c8", geometry: "interval", track: "context", defaultDuration: 30, category: "Context" },
  { id: "ictal", name: "Ictal", short: "ICTAL", color: "#ff6b7b", geometry: "interval", track: "windowed", defaultDuration: 12, category: "Seizure", shortcut: "1" },
  { id: "preictal", name: "Pre-ictal", short: "PRE", color: "#f3a85f", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Seizure", shortcut: "2" },
  { id: "postictal", name: "Post-ictal", short: "POST", color: "#d887ef", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Seizure", shortcut: "3" },
  { id: "gpd", name: "GPDs — generalized periodic discharges", short: "GPD", color: "#f3bb5f", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Rhythmic / periodic", shortcut: "4" },
  { id: "lpd", name: "LPDs — lateralized periodic discharges", short: "LPD", color: "#f0a758", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Rhythmic / periodic", shortcut: "5" },
  { id: "bipd", name: "BIPDs — bilateral independent periodic discharges", short: "BIPD", color: "#df9163", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Rhythmic / periodic", shortcut: "6" },
  { id: "grda", name: "GRDA — generalized rhythmic delta activity", short: "GRDA", color: "#e7c765", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Rhythmic / periodic", shortcut: "7" },
  { id: "lrda", name: "LRDA — lateralized rhythmic delta activity", short: "LRDA", color: "#d8b159", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Rhythmic / periodic", shortcut: "8" },
  { id: "gsw", name: "GSW — generalized spike-and-wave / sharp-and-wave", short: "GSW", color: "#f6cf6a", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Rhythmic / periodic", shortcut: "9" },
  { id: "wake", name: "W — Wake", short: "W", color: "#67d7a2", geometry: "window", track: "windowed", defaultDuration: 30, category: "Sleep stage" },
  { id: "n1", name: "N1 sleep", short: "N1", color: "#79c7f5", geometry: "window", track: "windowed", defaultDuration: 30, category: "Sleep stage" },
  { id: "n2", name: "N2 sleep", short: "N2", color: "#67aef8", geometry: "window", track: "windowed", defaultDuration: 30, category: "Sleep stage" },
  { id: "n3", name: "N3 sleep", short: "N3", color: "#768eea", geometry: "window", track: "windowed", defaultDuration: 30, category: "Sleep stage" },
  { id: "rem", name: "REM sleep", short: "REM", color: "#9b83ee", geometry: "window", track: "windowed", defaultDuration: 30, category: "Sleep stage" },
  { id: "artifact", name: "Artifact", short: "ARTIFACT", color: "#a9b2b8", geometry: "interval", track: "windowed", defaultDuration: 8, category: "Quality" },
  { id: "uncertain", name: "Uncertain", short: "?", color: "#a88cf4", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Quality" },
  { id: "spikes", name: "Epileptiform spike", short: "SPIKE", color: "#f6cf6a", geometry: "point", track: "instance", defaultDuration: 0, category: "Instance" },
  { id: "button", name: "Button push", short: "BUTTON", color: "#55a9ff", geometry: "point", track: "context", defaultDuration: 0, category: "Context" },
  { id: "asm", name: "ASM given", short: "ASM", color: "#5fd4c8", geometry: "point", track: "context", defaultDuration: 0, category: "Context" },
  { id: "clinical", name: "Clinical observation", short: "OBS", color: "#ff8e96", geometry: "point", track: "context", defaultDuration: 0, category: "Context" },
  { id: "rpp-unspecified", name: "RPP / IIC unspecified", short: "RPP?", color: "#b6a05d", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Rhythmic / periodic", hidden: true },
  { id: "sleep-unspecified", name: "Sleep stage unspecified", short: "SLEEP?", color: "#668fc4", geometry: "window", track: "windowed", defaultDuration: 30, category: "Sleep stage", hidden: true },
];

const LABEL_BY_ID = new Map(LABELS.map((label) => [label.id, label]));

function annotationGeometry(annotation: Pick<Annotation, "geometry" | "labelId">): Geometry {
  return annotation.geometry ?? LABEL_BY_ID.get(annotation.labelId)?.geometry ?? "point";
}

function normalizeAnnotationGeometry(annotation: Annotation, durationSec: number): Annotation {
  const label = LABEL_BY_ID.get(annotation.labelId);
  if (!label) return annotation;
  const geometry = annotationGeometry(annotation);
  const duration = Math.max(0, Number.isFinite(durationSec) ? durationSec : 0);
  let start = clamp(Number.isFinite(annotation.start) ? annotation.start : 0, 0, duration);
  let end = clamp(Number.isFinite(annotation.end) ? annotation.end : start, 0, duration);
  if (geometry === "point") {
    if (duration > 0) start = Math.min(start, Math.max(0, duration - 1e-6));
    end = start;
  } else if (geometry === "session") {
    start = 0;
    end = duration;
  } else if (geometry === "window") {
    if (duration > 0 && start >= duration) start = Math.max(0, duration - 1e-6);
    start = Math.floor(start / 30) * 30;
    end = Math.min(duration, start + 30);
  } else {
    if (end < start) [start, end] = [end, start];
    if (duration > 0 && end <= start) {
      const minimumDuration = Math.min(0.1, duration);
      if (start >= duration) start = Math.max(0, duration - minimumDuration);
      end = Math.min(duration, start + minimumDuration);
    }
  }
  const track: TrackId = ["context", "windowed", "instance"].includes(annotation.track)
    ? annotation.track
    : label.track;
  return { ...annotation, start, end, geometry, track };
}

function annotationOverlapsWindow(annotation: Annotation, start: number, end: number) {
  const point = annotationGeometry(annotation) === "point";
  return point
    ? annotation.start >= start && annotation.start < end
    : annotation.start < end && annotation.end > start;
}

function assignAnnotationLanes(items: Annotation[]) {
  const laneEnds: number[] = [];
  const lanes = new Map<string, number>();
  [...items].sort((a, b) => a.start - b.start || a.end - b.end).forEach((item) => {
    const effectiveEnd = annotationGeometry(item) === "point" ? item.start + 0.001 : item.end;
    let lane = laneEnds.findIndex((end) => end <= item.start);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(effectiveEnd);
    } else {
      laneEnds[lane] = effectiveEnd;
    }
    lanes.set(item.id, lane);
  });
  return { lanes, laneCount: Math.max(1, laneEnds.length) };
}

function tsvCell(value: unknown) {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ");
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function migrateAnnotationList(value: unknown, durationSec: number, channelCount = Number.POSITIVE_INFINITY): Annotation[] {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const saved = raw as Annotation;
    if (typeof saved.id !== "string" || !saved.id || seenIds.has(saved.id)) return [];
    seenIds.add(saved.id);
    const labelId = saved.labelId === "iiic" ? "rpp-unspecified" : saved.labelId === "nrem" ? "sleep-unspecified" : saved.labelId;
    const label = LABEL_BY_ID.get(labelId);
    if (!label || !Number.isFinite(Number(saved.start)) || !Number.isFinite(Number(saved.end))) return [];
    const status: AnnotationStatus = ["draft", "committed", "suggestion"].includes(saved.status) ? saved.status : "draft";
    const reliability: Reliability = ["gold", "silver", "bronze", "gray"].includes(saved.reliability) ? saved.reliability : "gray";
    const origin: AnnotationOrigin = ["manual", "imported", "detector", "legacy"].includes(saved.origin) ? saved.origin : "legacy";
    const channels = Array.isArray(saved.channels) ? saved.channels.filter((index) => Number.isInteger(index) && index >= 0 && index < channelCount) : [];
    const scopeIndices = Array.isArray(saved.channelScope?.sourceIndices)
      ? saved.channelScope.sourceIndices.filter((index) => Number.isInteger(index) && index >= 0 && index < channelCount)
      : [];
    const validScope = saved.channelScope
      && Number.isInteger(saved.channelScope.primarySourceIndex)
      && saved.channelScope.primarySourceIndex >= 0
      && saved.channelScope.primarySourceIndex < channelCount
      && scopeIndices.length > 0;
    const revisions = Array.isArray(saved.revisions)
      ? saved.revisions.filter((revision) => revision
        && Number.isInteger(revision.revision)
        && typeof revision.committedAt === "string"
        && typeof revision.sourceHash === "string"
        && typeof revision.sourceContentHash === "string"
        && typeof revision.notes === "string"
        && ["point", "interval", "window", "session"].includes(revision.geometry)
        && ["context", "windowed", "instance"].includes(revision.track))
      : [];
    const migrated = {
      ...saved,
      labelId,
      track: ["context", "windowed", "instance"].includes(saved.track) ? saved.track : label.track,
      geometry: ["point", "interval", "window", "session"].includes(saved.geometry) ? saved.geometry : label.geometry,
      channels,
      channelScope: validScope ? {
        displayLabel: typeof saved.channelScope?.displayLabel === "string" ? saved.channelScope.displayLabel : `Display row ${saved.channelScope?.primarySourceIndex ?? 0}`,
        montage: ["referential", "average", "average-reference", "bipolar"].includes(saved.channelScope?.montage ?? "") ? saved.channelScope!.montage : "referential",
        primarySourceIndex: saved.channelScope!.primarySourceIndex,
        sourceIndices: scopeIndices,
        sourceLabels: scopeIndices.map((index) => saved.channelScope?.sourceLabels?.[saved.channelScope.sourceIndices.indexOf(index)] ?? `Ch ${index + 1}`),
      } : undefined,
      confidence: clamp(Number.isFinite(saved.confidence) ? saved.confidence : 50, 0, 100),
      reliability,
      origin,
      reviewer: typeof saved.reviewer === "string" ? saved.reviewer : "",
      notes: typeof saved.notes === "string" ? saved.notes : "",
      status,
      revisions,
      revision: Number.isInteger(saved.revision) && saved.revision > 0 ? saved.revision : 1,
      createdAt: typeof saved.createdAt === "string" ? saved.createdAt : new Date().toISOString(),
      updatedAt: typeof saved.updatedAt === "string" ? saved.updatedAt : new Date().toISOString(),
    };
    return [normalizeAnnotationGeometry(migrated, durationSec)];
  });
}

function migrateCandidateList(value: unknown, durationSec: number): Candidate[] {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const candidate = raw as Candidate;
    if (typeof candidate.id !== "string" || !candidate.id || seenIds.has(candidate.id)) return [];
    if (!Number.isFinite(candidate.time) || candidate.time < 0 || candidate.time >= durationSec) return [];
    if (typeof candidate.label !== "string" || !candidate.label.trim()) return [];
    if (!["active", "queued", "reviewed", "skipped", "conflict"].includes(candidate.status)) return [];
    if (!["gold", "silver", "bronze", "gray"].includes(candidate.source)) return [];
    seenIds.add(candidate.id);
    return [{ ...candidate, label: candidate.label.trim() }];
  });
}

const DEMO_ANNOTATIONS: Annotation[] = [
  annotationSeed("laterality", 0, 7938, "committed", "gold", 100, "Right temporal"),
  annotationSeed("preictal", 948, 972, "committed", "gold", 92, "Subtle rhythmic evolution"),
  annotationSeed("artifact", 961, 966, "committed", "gold", 98, "Electrode movement"),
  annotationSeed("ictal", 972.4, 994.8, "committed", "gold", 96, "Electrographic onset with right temporal evolution"),
  annotationSeed("clinical", 981.2, 981.2, "committed", "gold", 88, "Right head turn"),
  annotationSeed("button", 985.1, 985.1, "committed", "bronze", 100, "Imported event marker"),
  annotationSeed("postictal", 994.8, 1030, "committed", "gold", 91, "Diffuse attenuation"),
  annotationSeed("asm", 1027.5, 1027.5, "committed", "bronze", 100, "Levetiracetam documented"),
];

const DEMO_CANDIDATES: Candidate[] = [
  { id: "cand-1", time: 978, label: "EEG onset — right temporal", source: "bronze", status: "active" },
  { id: "cand-2", time: 4024, label: "Rhythmic evolution", source: "silver", status: "queued" },
  { id: "cand-3", time: 6072, label: "Tonic event / button push", source: "bronze", status: "queued" },
  { id: "cand-4", time: 7145, label: "Detector disagreement", source: "silver", status: "conflict" },
];

const DEFAULT_FILTERS: DisplayFilterSettings = {
  highPassHz: 0.5,
  lowPassHz: 70,
  notchHz: 60,
  enabled: true,
};

function annotationSeed(
  labelId: string,
  start: number,
  end: number,
  status: AnnotationStatus,
  reliability: Reliability,
  confidence: number,
  notes: string,
): Annotation {
  const now = "2026-07-16T02:18:00.000Z";
  return {
    id: `demo-${labelId}-${start}`,
    labelId,
    start,
    end,
    track: LABEL_BY_ID.get(labelId)?.track ?? "instance",
    geometry: LABEL_BY_ID.get(labelId)?.geometry ?? "point",
    channels: [],
    confidence,
    reliability,
    origin: reliability === "silver" ? "detector" : reliability === "bronze" ? "imported" : "legacy",
    reviewer: "AM",
    notes,
    status,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function snapTime(value: number, mode: "1s" | "100ms" | "sample", sampleRate: number, bypass = false) {
  if (bypass) return value;
  if (mode === "1s") return Math.round(value);
  if (mode === "100ms") return Math.round(value * 10) / 10;
  return Math.round(value * sampleRate) / sampleRate;
}

function shortFileName(name: string, max = 26) {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot) : "";
  return `${name.slice(0, max - ext.length - 1)}…${ext}`;
}

function formatAmplitude(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1000) return `${(value / 1000).toFixed(2)} mV`;
  return `${value.toFixed(abs >= 100 ? 0 : 1)} µV`;
}

function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(files: Array<{ name: string; content: string }>) {
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    localChunks.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centralChunks.push(central);
    offset += local.length;
  }
  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const chunks = [...localChunks, ...centralChunks, end];
  const buffer = new ArrayBuffer(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  const output = new Uint8Array(buffer);
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return new Blob([buffer], { type: "application/zip" });
}

function sourceMeta(source: SignalSource) {
  return source.meta;
}

function primarySampleRate(meta: RecordingMeta) {
  return meta.sampleRates[0] ?? 1;
}

function patientLabel(meta: RecordingMeta) {
  return meta.patientId || "Local session";
}

function recordingLabel(meta: RecordingMeta) {
  return meta.recordingId || meta.id;
}

function formatSessionStart(date?: Date) {
  if (!date) return "Not provided";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} source clock`;
}

export default function Home() {
  const demoSource = useMemo(() => {
    const source = new DemoSource({ name: "UNM_EMU_2025-05-01_01.edf", durationSec: 7938, sampleRate: 256 });
    Object.assign(source.meta, { patientId: "P-1027", recordingId: "2025-05-01_01", startedAt: new Date("2025-05-01T00:00:00Z") });
    return source;
  }, []);
  const sourceRef = useRef<SignalSource>(demoSource);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overviewRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const waveDrawRef = useRef<() => void>(() => {});
  const viewerWheelRef = useRef<(event: WheelEvent) => void>(() => {});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const annotationsRef = useRef<Annotation[]>(DEMO_ANNOTATIONS);
  const undoRef = useRef<Annotation[][]>([]);
  const redoRef = useRef<Annotation[][]>([]);
  const pointerRef = useRef<{ startX: number; startTime: number; moved: boolean } | null>(null);
  const wheelFrameRef = useRef<number | null>(null);
  const wheelDeltaRef = useRef(0);
  const wheelWidthRef = useRef(1);
  const cursorFrameRef = useRef<number | null>(null);
  const pendingCursorRef = useRef<{ time: number; row: number; amplitude: number; selection?: { start: number; end: number } } | null>(null);
  const contextResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const pendingAnnotationDragRef = useRef<Pick<Annotation, "start" | "end" | "track" | "geometry"> | null>(null);
  const dragAnnotationRef = useRef<{
    id: string;
    mode: "move" | "start" | "end";
    originX: number;
    original: Annotation;
    snapshot: Annotation[];
    moved: boolean;
  } | null>(null);

  const [meta, setMeta] = useState<RecordingMeta>(() => sourceMeta(demoSource));
  const [sessionKey, setSessionKey] = useState("demo-p1027-2025-05-01");
  const [recordingType, setRecordingType] = useState("SEEG / iEEG");
  const [viewStart, setViewStart] = useState(966);
  const [timebase, setTimebase] = useState(20);
  const [gain, setGain] = useState(1);
  const [montage, setMontage] = useState<MontageMode>("referential");
  const [filters, setFilters] = useState<DisplayFilterSettings>(DEFAULT_FILTERS);
  const [selectedChannels, setSelectedChannels] = useState<Set<number>>(() => new Set(meta.channelLabels.slice(0, 16).map((_, index) => index)));
  const [badChannels, setBadChannels] = useState<Set<number>>(() => new Set([9]));
  const [focusedChannel, setFocusedChannel] = useState(0);
  const [display, setDisplay] = useState<DisplayWindow>({ data: [], labels: [], sampleRates: [], sourceIndices: [], primarySourceIndices: [], warnings: [] });
  const [loadingSignal, setLoadingSignal] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>(DEMO_ANNOTATIONS);
  const [annotationDragPreview, setAnnotationDragPreview] = useState<{ id: string; patch: Pick<Annotation, "start" | "end" | "track" | "geometry"> } | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>("demo-ictal-972.4");
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [cursorTime, setCursorTime] = useState(978);
  const [cursorAmplitude, setCursorAmplitude] = useState(0);
  const [cursorLocked, setCursorLocked] = useState(true);
  const [activeTool, setActiveTool] = useState<"cursor" | "seizure">("cursor");
  const [markOnset, setMarkOnset] = useState<number | null>(null);
  const [snapMode, setSnapMode] = useState<"1s" | "100ms" | "sample">("100ms");
  const [playing, setPlaying] = useState(false);
  const [spectrogramOpen, setSpectrogramOpen] = useState(false);
  const [rightTab, setRightTab] = useState<"labels" | "qc">("labels");
  const [paletteSearch, setPaletteSearch] = useState("");
  const [channelSearch, setChannelSearch] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>(DEMO_CANDIDATES);
  const [activeCandidate, setActiveCandidate] = useState(0);
  const [toast, setToast] = useState("Ready — raw data stays on this device");
  const [importBusy, setImportBusy] = useState(false);
  const [dragGhost, setDragGhost] = useState<{ labelId: string; time: number } | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSessionMap, setShowSessionMap] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [contextTrackHeight, setContextTrackHeight] = useState(76);
  const [pendingDat, setPendingDat] = useState<File | null>(null);
  const [pendingLegacyMatFile, setPendingLegacyMatFile] = useState<File | null>(null);
  const [pendingLegacyMeta, setPendingLegacyMeta] = useState<LegacyMatMetadata | null>(null);
  const [datMapping, setDatMapping] = useState({ sampleRate: 0, channelCount: 0, physicalScale: 1 });
  const [confirmCommit, setConfirmCommit] = useState<string[]>([]);
  const [reviewer, setReviewer] = useState("AM");
  const [sourceHash, setSourceHash] = useState("demo:synthetic-signal-v1");
  const [rawSourceHash, setRawSourceHash] = useState("demo:synthetic-signal-v1");
  const [sourceInterpretation, setSourceInterpretation] = useState<Record<string, unknown> | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<"saved" | "error">("saved");

  const selectedAnnotation = annotations.find((item) => item.id === selectedAnnotationId) ?? null;
  const selectedGeometry = selectedAnnotation ? annotationGeometry(selectedAnnotation) : null;
  const activeCandidateItem = candidates[activeCandidate] ?? null;
  const sourceHashDisplay = sourceHash.startsWith("demo:")
    ? sourceHash
    : `${sourceHash.slice(0, 8)}…${sourceHash.slice(-4)}`;

  useLayoutEffect(() => {
    annotationsRef.current = annotations;
  }, [annotations]);

  useEffect(() => {
    try {
      const savedReviewer = localStorage.getItem("neurotrace:reviewer");
      // Local reviewer identity is external persisted state and is restored once after hydration.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (savedReviewer) setReviewer(savedReviewer);
    } catch { /* local preferences are optional */ }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("neurotrace:reviewer", reviewer);
    } catch { /* local preferences are optional */ }
  }, [reviewer]);

  const setViewStartSafe = useCallback((next: number | ((value: number) => number)) => {
    setViewStart((current) => {
      const value = typeof next === "function" ? next(current) : next;
      return clamp(value, 0, Math.max(0, meta.durationSec - timebase));
    });
  }, [meta.durationSec, timebase]);

  const setTimeWindow = useCallback((requested: number, anchorTime = viewStart + timebase / 2) => {
    const next = clamp(requested, 1, Math.min(300, Math.max(1, meta.durationSec)));
    const anchor = clamp(anchorTime, viewStart, viewStart + timebase);
    const anchorRatio = timebase > 0 ? (anchor - viewStart) / timebase : 0.5;
    setViewStart(clamp(anchor - anchorRatio * next, 0, Math.max(0, meta.durationSec - next)));
    setTimebase(next);
  }, [meta.durationSec, timebase, viewStart]);

  const zoomTimeWindow = useCallback((direction: "in" | "out", anchorTime?: number) => {
    setTimeWindow(timebase * (direction === "in" ? 0.8 : 1.25), anchorTime);
  }, [setTimeWindow, timebase]);

  const commitMutation = useCallback((mutator: (current: Annotation[]) => Annotation[]) => {
    setAnnotations((current) => {
      undoRef.current.push(current);
      if (undoRef.current.length > 100) undoRef.current.shift();
      redoRef.current = [];
      return mutator(current);
    });
  }, []);

  const undo = useCallback(() => {
    const previous = undoRef.current.pop();
    if (!previous) {
      setToast("Nothing to undo");
      return;
    }
    redoRef.current.push(annotationsRef.current);
    setAnnotations(previous);
    setSelectedAnnotationId(null);
    setToast("Last annotation change undone");
  }, []);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) {
      setToast("Nothing to redo");
      return;
    }
    undoRef.current.push(annotationsRef.current);
    setAnnotations(next);
    setToast("Annotation change restored");
  }, []);

  const addAnnotation = useCallback((label: LabelDefinition, time: number, explicitEnd?: number) => {
    const samplingRate = display.sampleRates[focusedChannel] ?? primarySampleRate(meta);
    let start = clamp(snapTime(Math.min(time, explicitEnd ?? time), snapMode, samplingRate), 0, meta.durationSec);
    let end = label.geometry === "point" ? start : explicitEnd ?? start + label.defaultDuration;
    end = clamp(snapTime(Math.max(end, start), snapMode, samplingRate), start, meta.durationSec);
    if (label.geometry === "window") {
      const windowStart = Math.floor(start / 30) * 30;
      end = Math.min(meta.durationSec, windowStart + 30);
      time = windowStart;
    } else if (label.geometry === "session") {
      start = 0;
      end = meta.durationSec;
      time = 0;
    }
    const now = new Date().toISOString();
    const sourceIndices = display.sourceIndices[focusedChannel] ?? [];
    const primarySourceIndex = display.primarySourceIndices[focusedChannel];
    if (label.id === "spikes" && (primarySourceIndex === undefined || primarySourceIndex < 0 || sourceIndices.length === 0)) {
      setToast("Choose a visible source channel before placing an epileptiform spike");
      return;
    }
    const activeSourceCandidate = candidates[activeCandidate];
    const candidateMatches = label.geometry !== "session" && activeSourceCandidate && activeSourceCandidate.status !== "skipped" && activeSourceCandidate.status !== "conflict" && (
      label.geometry === "point"
        ? Math.abs(activeSourceCandidate.time - start) <= 1
        : explicitEnd !== undefined
          ? activeSourceCandidate.time >= start && activeSourceCandidate.time <= end
          : Math.abs(activeSourceCandidate.time - start) <= 1
    );
    const next = normalizeAnnotationGeometry({
      id: makeId("ann"),
      labelId: label.id,
      start: label.geometry === "window" || label.geometry === "session" ? time : start,
      end,
      track: label.track,
      geometry: label.geometry,
      channels: label.id === "spikes" ? [...sourceIndices] : [],
      confidence: label.id === "uncertain" ? 50 : 85,
      reliability: "gray",
      origin: "manual",
      reviewer,
      notes: "",
      status: "draft",
      candidateId: candidateMatches ? activeSourceCandidate.id : undefined,
      channelScope: label.id === "spikes" && primarySourceIndex !== undefined ? {
        displayLabel: display.labels[focusedChannel] ?? `Display row ${focusedChannel + 1}`,
        montage,
        primarySourceIndex,
        sourceIndices: [...sourceIndices],
        sourceLabels: sourceIndices.map((index) => meta.channelLabels[index] ?? `Ch ${index + 1}`),
      } : undefined,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }, meta.durationSec);
    const replacedSleepIds = label.category === "Sleep stage"
      ? annotationsRef.current.filter((item) => {
        const existing = LABEL_BY_ID.get(item.labelId);
        return existing?.category === "Sleep stage" && annotationOverlapsWindow(item, next.start, next.end);
      }).map((item) => item.id)
      : [];
    commitMutation((current) => [...current.filter((item) => !replacedSleepIds.includes(item.id)), next]);
    setSelectedAnnotationId(next.id);
    setCursorTime(next.start);
    setCursorLocked(true);
    setSelection(null);
    setToast(replacedSleepIds.length
      ? `${label.name} replaced the prior sleep stage for this 30-second epoch`
      : `${label.name} placed at ${formatClock(next.start, true)} — draft`);
  }, [activeCandidate, candidates, commitMutation, display, focusedChannel, meta, montage, reviewer, snapMode]);

  const updateAnnotation = useCallback((id: string, patch: Partial<Annotation>, withHistory = true) => {
    const apply = (current: Annotation[]) => current.map((item) => {
      if (item.id !== id) return item;
      const next = {
        ...item,
        ...patch,
        status: patch.status ?? (item.status === "committed" ? "draft" : item.status),
        revision: item.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      return normalizeAnnotationGeometry(next, meta.durationSec);
    });
    if (withHistory) commitMutation(apply);
    else setAnnotations(apply);
  }, [commitMutation, meta.durationSec]);

  const deleteAnnotation = useCallback((id: string) => {
    const removed = annotationsRef.current.find((item) => item.id === id);
    commitMutation((current) => current.filter((item) => item.id !== id));
    if (removed?.candidateId) {
      const hasOtherCommittedLink = annotationsRef.current.some((item) => item.id !== id && item.candidateId === removed.candidateId && item.status === "committed");
      if (!hasOtherCommittedLink) {
        setCandidates((items) => items.map((item) => item.id === removed.candidateId && item.status === "reviewed" ? { ...item, status: "queued" } : item));
      }
    }
    setSelectedAnnotationId(null);
    setToast("Annotation removed — undo is available");
  }, [commitMutation]);

  const qcIssues = useMemo(() => {
    const issues: Array<{ level: "warning" | "info"; text: string; annotationId?: string }> = [];
    for (const warning of meta.warnings ?? []) issues.push({ level: "warning", text: `Source assumption: ${warning}` });
    for (const assumption of meta.assumptions ?? []) issues.push({ level: "info", text: `Source metadata: ${assumption}` });
    for (const warning of display.warnings) issues.push({ level: "warning", text: `Display montage: ${warning}` });
    if (recoveryStatus === "error") issues.push({ level: "warning", text: "Local recovery is unavailable; export before closing the session." });
    const candidateIds = new Set(candidates.map((item) => item.id));
    for (const item of annotations) {
      const geometry = annotationGeometry(item);
      if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end > meta.durationSec || item.end < item.start) {
        issues.push({ level: "warning", text: "Annotation bounds fall outside the recording", annotationId: item.id });
      } else if (geometry === "point" && item.start !== item.end) {
        issues.push({ level: "warning", text: "Instance label must be a single moment", annotationId: item.id });
      } else if (geometry === "session" && (item.start !== 0 || item.end !== meta.durationSec)) {
        issues.push({ level: "warning", text: "Entire-session context must span the recording", annotationId: item.id });
      } else if (geometry === "window" && (Math.abs(item.start / 30 - Math.round(item.start / 30)) > 1e-6 || item.end - item.start > 30.000001)) {
        issues.push({ level: "warning", text: "Sleep-stage window is not aligned to a 30-second epoch", annotationId: item.id });
      }
      if (item.status === "committed" && !item.reviewer.trim()) {
        issues.push({ level: "warning", text: "Committed annotation is missing reviewer identity", annotationId: item.id });
      }
      if (item.status === "committed" && item.origin === "manual" && !item.revisions?.length) {
        issues.push({ level: "warning", text: "Manual commit is missing an immutable revision snapshot", annotationId: item.id });
      }
      if (item.candidateId && !candidateIds.has(item.candidateId)) {
        issues.push({ level: "warning", text: "Annotation references a missing source candidate", annotationId: item.id });
      }
      if (item.labelId === "spikes" && (!item.channelScope || item.channelScope.primarySourceIndex < 0 || item.channelScope.primarySourceIndex >= meta.channelLabels.length || !item.channelScope.sourceIndices.length)) {
        issues.push({ level: "warning", text: "Epileptiform spike is missing valid source-channel provenance", annotationId: item.id });
      }
    }
    const ictal = annotations.filter((item) => item.labelId === "ictal");
    for (const item of ictal) {
      if (item.end - item.start < 3) issues.push({ level: "warning", text: `Ictal interval is ${(item.end - item.start).toFixed(1)} s (<3 s)`, annotationId: item.id });
    }
    for (let i = 0; i < ictal.length; i += 1) for (let j = i + 1; j < ictal.length; j += 1) {
      if (Math.abs(ictal[i].start - ictal[j].start) < 30) issues.push({ level: "warning", text: "Possible duplicate ictal onsets within 30 s", annotationId: ictal[j].id });
    }
    const sleepStages = annotations.filter((item) => LABEL_BY_ID.get(item.labelId)?.category === "Sleep stage");
    for (let i = 0; i < sleepStages.length; i += 1) for (let j = i + 1; j < sleepStages.length; j += 1) {
      if (sleepStages[i].labelId !== sleepStages[j].labelId && sleepStages[i].start < sleepStages[j].end && sleepStages[j].start < sleepStages[i].end) {
        issues.push({ level: "warning", text: "Conflicting sleep stages share an epoch", annotationId: sleepStages[j].id });
      }
    }
    const draftCount = annotations.filter((item) => item.status === "draft").length;
    if (draftCount) issues.push({ level: "info", text: `${draftCount} draft label${draftCount === 1 ? "" : "s"} not yet committed` });
    if (badChannels.size) issues.push({ level: "info", text: `${badChannels.size} channel${badChannels.size === 1 ? "" : "s"} excluded from derived montages` });
    return issues;
  }, [annotations, badChannels, candidates, display.warnings, meta.assumptions, meta.channelLabels.length, meta.durationSec, meta.warnings, recoveryStatus]);

  const commitSelected = useCallback((force = false) => {
    if (!selectedAnnotation) return;
    const warnings: string[] = [];
    if (selectedAnnotation.end < selectedAnnotation.start) warnings.push("Offset must follow onset.");
    if (!selectedAnnotation.reviewer.trim()) warnings.push("Reviewer initials are required for committed provenance.");
    if (selectedAnnotation.labelId === "spikes" && !selectedAnnotation.channelScope) warnings.push("Epileptiform spikes require a source-channel scope.");
    if (selectedAnnotation.labelId === "ictal" && selectedAnnotation.end - selectedAnnotation.start < 3) warnings.push("Ictal duration is under 3 seconds.");
    const duplicate = annotations.some((item) => item.id !== selectedAnnotation.id && item.labelId === "ictal" && selectedAnnotation.labelId === "ictal" && Math.abs(item.start - selectedAnnotation.start) < 30);
    if (duplicate) warnings.push("Another ictal onset exists within 30 seconds.");
    if (warnings.length && !force) {
      setConfirmCommit(warnings);
      return;
    }
    const committedAt = new Date().toISOString();
    updateAnnotation(selectedAnnotation.id, {
      status: "committed",
      revisions: [...(selectedAnnotation.revisions ?? []), {
        revision: selectedAnnotation.revision + 1,
        committedAt,
        labelId: selectedAnnotation.labelId,
        start: selectedAnnotation.start,
        end: selectedAnnotation.end,
        confidence: selectedAnnotation.confidence,
        reviewer: selectedAnnotation.reviewer,
        notes: selectedAnnotation.notes,
        reliability: selectedAnnotation.reliability,
        origin: selectedAnnotation.origin,
        geometry: annotationGeometry(selectedAnnotation),
        track: selectedAnnotation.track,
        channels: [...selectedAnnotation.channels],
        channelScope: selectedAnnotation.channelScope ? {
          ...selectedAnnotation.channelScope,
          sourceIndices: [...selectedAnnotation.channelScope.sourceIndices],
          sourceLabels: [...selectedAnnotation.channelScope.sourceLabels],
        } : undefined,
        sourceHash,
        sourceContentHash: rawSourceHash,
        candidateId: selectedAnnotation.candidateId,
        displaySnapshot: {
          montage,
          filters: { ...filters },
          gain,
          snapMode,
          selectedSourceChannels: [...selectedChannels].sort((a, b) => a - b),
          badSourceChannels: [...badChannels].sort((a, b) => a - b),
        },
        sourceSnapshot: {
          format: meta.format,
          durationSec: meta.durationSec,
          sampleRates: [...meta.sampleRates],
          assumptions: [...(meta.assumptions ?? [])],
          warnings: [...meta.warnings],
          interpretation: sourceInterpretation ? { ...sourceInterpretation } : undefined,
        },
      }],
    });
    setConfirmCommit([]);
    if (selectedAnnotation.candidateId) {
      setCandidates((items) => items.map((item) => item.id === selectedAnnotation.candidateId ? { ...item, status: "reviewed" } : item));
    }
    setToast(`Revision committed by ${selectedAnnotation.reviewer || reviewer}`);
  }, [annotations, badChannels, filters, gain, meta, montage, rawSourceHash, reviewer, selectedAnnotation, selectedChannels, snapMode, sourceHash, sourceInterpretation, updateAnnotation]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(`neurotrace:draft:${sessionKey}`, JSON.stringify(annotations));
        localStorage.setItem(`neurotrace:project:${sessionKey}`, JSON.stringify({
          version: 2,
          annotations,
          candidates,
          activeCandidate,
          badChannels: [...badChannels],
          reviewer,
          recordingType,
          savedAt: new Date().toISOString(),
        }));
        setRecoveryStatus("saved");
      } catch {
        setRecoveryStatus("error");
        setToast("Local recovery failed — export a bundle before closing this session");
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [activeCandidate, annotations, badChannels, candidates, recordingType, reviewer, sessionKey]);

  useEffect(() => {
    let cancelled = false;
    const source = sourceRef.current;
    const indices = [...selectedChannels].sort((a, b) => a - b);
    const refreshWindow = async () => {
      await Promise.resolve();
      if (cancelled) return;
      if (!indices.length) {
        setDisplay({ data: [], labels: [], sampleRates: [], sourceIndices: [], primarySourceIndices: [], warnings: [] });
        setLoadingSignal(false);
        return;
      }
      setLoadingSignal(true);
      try {
        const windowData = await source.getWindow(viewStart, timebase, indices);
        if (cancelled) return;
        const filtered = applyDisplayFilters(windowData.data, windowData.sampleRates, filters);
        const labels = indices.map((index) => meta.channelLabels[index] ?? `Ch ${index + 1}`);
        const badDisplayPositions = new Set(indices.flatMap((sourceIndex, position) => badChannels.has(sourceIndex) ? [position] : []));
        const montageResult = buildMontage(
          filtered,
          labels,
          montage,
          badDisplayPositions,
          windowData.sampleRates,
        );
        const sourceIndices = montageResult.sourceIndices.map((contributors) => contributors.map((position) => indices[position]).filter((index) => index !== undefined));
        const primarySourceIndices = montageResult.primarySourceIndices.map((position) => indices[position] ?? -1);
        const sampleRates = montageResult.primarySourceIndices.map((position) => windowData.sampleRates[position] ?? primarySampleRate(meta));
        setDisplay({ data: montageResult.data, labels: montageResult.labels, sampleRates, sourceIndices, primarySourceIndices, warnings: montageResult.warnings });
        setFocusedChannel((current) => clamp(current, 0, Math.max(0, montageResult.labels.length - 1)));
        setLoadingSignal(false);
      } catch (error) {
        if (cancelled) return;
        setLoadingSignal(false);
        const message = error instanceof Error ? error.message : "Could not read this signal window";
        setDisplay({ data: [], labels: [], sampleRates: [], sourceIndices: [], primarySourceIndices: [], warnings: [message] });
        setToast(message);
      }
    };
    const timer = window.setTimeout(() => void refreshWindow(), 90);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [badChannels, filters, meta, montage, selectedChannels, timebase, viewStart]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setCursorTime((value) => {
        const next = value + 0.1;
        if (next > viewStart + timebase) setViewStartSafe((start) => start + timebase * 0.8);
        if (next >= meta.durationSec) {
          setPlaying(false);
          return meta.durationSec;
        }
        return next;
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [meta.durationSec, playing, setViewStartSafe, timebase, viewStart]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const width = rect.width;
      const height = rect.height;
      context.fillStyle = "#071216";
      context.fillRect(0, 0, width, height);

      const secondsPerGrid = timebase <= 10 ? 1 : timebase <= 30 ? 2 : timebase <= 60 ? 5 : 10;
      context.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      context.textAlign = "center";
      context.textBaseline = "top";
      for (let second = Math.ceil(viewStart / secondsPerGrid) * secondsPerGrid; second <= viewStart + timebase; second += secondsPerGrid) {
        const x = ((second - viewStart) / timebase) * width;
        context.strokeStyle = second % (secondsPerGrid * 5) === 0 ? "rgba(133,171,181,.20)" : "rgba(133,171,181,.09)";
        context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
        context.fillStyle = "rgba(167,190,197,.74)";
        context.fillText(formatClock(second), x, 5);
      }

      for (const item of annotations) {
        if (item.end < viewStart || item.start > viewStart + timebase) continue;
        const label = LABEL_BY_ID.get(item.labelId);
        if (!label) continue;
        const x1 = ((Math.max(item.start, viewStart) - viewStart) / timebase) * width;
        const geometry = annotationGeometry(item);
        const x2 = geometry === "point" ? x1 : ((Math.min(item.end, viewStart + timebase) - viewStart) / timebase) * width;
        context.globalAlpha = item.status === "suggestion" ? 0.07 : item.status === "draft" ? 0.11 : 0.075;
        context.fillStyle = label.color;
        context.fillRect(x1, 0, Math.max(geometry === "point" ? 2 : x2 - x1, 2), height);
        context.globalAlpha = 1;
        if (geometry === "point") {
          context.strokeStyle = label.color;
          context.setLineDash(item.status === "suggestion" ? [4, 4] : []);
          context.beginPath(); context.moveTo(x1, 20); context.lineTo(x1, height); context.stroke();
          context.setLineDash([]);
        }
      }

      const rows = Math.max(1, display.data.length);
      const rowHeight = height / rows;
      for (let channel = 0; channel < display.data.length; channel += 1) {
        const values = display.data[channel];
        const center = rowHeight * (channel + 0.5);
        context.strokeStyle = "rgba(116,153,162,.11)";
        context.beginPath(); context.moveTo(0, center); context.lineTo(width, center); context.stroke();
        if (!values.length) continue;
        const scale = (rowHeight * 0.36 * gain) / 100;
        const samplesPerPixel = values.length / Math.max(1, width);
        context.strokeStyle = "#eaf5f2";
        context.lineWidth = 0.9;
        context.beginPath();
        for (let x = 0; x < width; x += 1) {
          const from = Math.floor(x * samplesPerPixel);
          const to = Math.max(from + 1, Math.min(values.length, Math.ceil((x + 1) * samplesPerPixel)));
          let min = Infinity;
          let max = -Infinity;
          for (let sample = from; sample < to; sample += 1) {
            const value = values[sample];
            if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); }
          }
          if (min !== Infinity) {
            context.moveTo(x, center - max * scale);
            context.lineTo(x, center - min * scale);
          }
        }
        context.stroke();
      }

      if (markOnset !== null) {
        const onsetX = ((markOnset - viewStart) / timebase) * width;
        context.strokeStyle = "#57dfb7";
        context.lineWidth = 2;
        context.setLineDash([7, 4]);
        context.beginPath(); context.moveTo(onsetX, 0); context.lineTo(onsetX, height); context.stroke();
        context.setLineDash([]);
      }
    };
    waveDrawRef.current = draw;
    draw();
  }, [annotations, display, gain, markOnset, timebase, viewStart]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => waveDrawRef.current());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const timeFromPointer = useCallback((event: { clientX: number }, element: HTMLElement, bypass = false) => {
    const rect = element.getBoundingClientRect();
    const raw = viewStart + clamp((event.clientX - rect.left) / rect.width, 0, 1) * timebase;
    const focusedRate = display.sampleRates[focusedChannel] ?? primarySampleRate(meta);
    return clamp(snapTime(raw, snapMode, focusedRate, bypass), 0, meta.durationSec);
  }, [display.sampleRates, focusedChannel, meta, snapMode, timebase, viewStart]);

  const onWavePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const time = timeFromPointer(event, event.currentTarget, event.altKey);
    const rect = event.currentTarget.getBoundingClientRect();
    const row = clamp(Math.floor(((event.clientY - rect.top) / rect.height) * Math.max(1, display.data.length)), 0, Math.max(0, display.data.length - 1));
    const values = display.data[row];
    const sample = values?.length ? clamp(Math.floor(((time - viewStart) / timebase) * values.length), 0, values.length - 1) : 0;
    pointerRef.current = { startX: event.clientX, startTime: time, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    setCursorTime(time);
    setCursorLocked(true);
    setFocusedChannel(row);
    setCursorAmplitude(values?.[sample] ?? 0);
  };

  const onWavePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!pointerRef.current) return;
    const time = timeFromPointer(event, event.currentTarget, event.altKey);
    const rect = event.currentTarget.getBoundingClientRect();
    const row = clamp(Math.floor(((event.clientY - rect.top) / rect.height) * Math.max(1, display.data.length)), 0, Math.max(0, display.data.length - 1));
    const values = display.data[row];
    const sample = values?.length ? clamp(Math.floor(((time - viewStart) / timebase) * values.length), 0, values.length - 1) : 0;
    if (Math.abs(event.clientX - pointerRef.current.startX) > 3) {
      pointerRef.current.moved = true;
    }
    pendingCursorRef.current = {
      time,
      row,
      amplitude: values?.[sample] ?? 0,
      selection: pointerRef.current.moved
        ? { start: Math.min(pointerRef.current.startTime, time), end: Math.max(pointerRef.current.startTime, time) }
        : undefined,
    };
    if (cursorFrameRef.current !== null) return;
    cursorFrameRef.current = window.requestAnimationFrame(() => {
      const pending = pendingCursorRef.current;
      cursorFrameRef.current = null;
      if (!pending) return;
      setCursorTime(pending.time);
      setFocusedChannel(pending.row);
      setCursorAmplitude(pending.amplitude);
      if (pending.selection) setSelection(pending.selection);
    });
  };

  const onWavePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const pointer = pointerRef.current;
    pointerRef.current = null;
    if (!pointer) return;
    if (cursorFrameRef.current !== null) {
      window.cancelAnimationFrame(cursorFrameRef.current);
      cursorFrameRef.current = null;
    }
    pendingCursorRef.current = null;
    const time = timeFromPointer(event, event.currentTarget, event.altKey);
    setCursorTime(time);
    setCursorLocked(true);
    if (activeTool === "seizure" && !pointer.moved) {
      if (markOnset === null) {
        setMarkOnset(time);
        setToast(`Onset placed at ${formatClock(time, true)} — click offset`);
      } else if (time <= markOnset) {
        setToast("Offset must be after onset");
      } else {
        addAnnotation(LABEL_BY_ID.get("ictal")!, markOnset, time);
        setMarkOnset(null);
        setActiveTool("cursor");
      }
    } else if (pointer.moved) {
      setSelection({ start: Math.min(pointer.startTime, time), end: Math.max(pointer.startTime, time) });
      setToast(`Selected ${Math.abs(time - pointer.startTime).toFixed(1)} s — choose a label`);
    } else {
      setSelection(null);
      setToast(`Cursor locked at ${formatClock(time, true)} — choose an instance label or press Esc`);
    }
  };

  const onLabelDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const labelId = event.dataTransfer.getData("application/x-neurotrace-label");
    const label = LABEL_BY_ID.get(labelId);
    if (!label) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const time = timeFromPointer(event, canvas, event.altKey);
    addAnnotation(label, time);
    setDragGhost(null);
  };

  const onLabelDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const labelId = event.dataTransfer.types.includes("application/x-neurotrace-label") ? "drag" : "";
    const canvas = canvasRef.current;
    if (labelId && canvas) setDragGhost((current) => ({ labelId: current?.labelId ?? "", time: timeFromPointer(event, canvas, event.altKey) }));
  };

  useEffect(() => {
    const applyPreview = () => {
      const drag = dragAnnotationRef.current;
      const patch = pendingAnnotationDragRef.current;
      dragFrameRef.current = null;
      if (!drag || !patch) return;
      setAnnotationDragPreview({ id: drag.id, patch });
    };
    const onMove = (event: PointerEvent) => {
      const drag = dragAnnotationRef.current;
      const timeline = timelineRef.current;
      if (!drag || !timeline) return;
      const delta = ((event.clientX - drag.originX) / timeline.getBoundingClientRect().width) * timebase;
      const label = LABEL_BY_ID.get(drag.original.labelId);
      const originalGeometry = annotationGeometry(drag.original);
      const dragSampleRate = drag.original.channelScope
        ? meta.sampleRates[drag.original.channelScope.primarySourceIndex] ?? primarySampleRate(meta)
        : display.sampleRates[focusedChannel] ?? primarySampleRate(meta);
      let geometry = originalGeometry;
      let track = drag.original.track;
      if (drag.mode === "move" && ["instance", "windowed"].includes(drag.original.track)) {
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-track-id]")?.dataset.trackId;
        if (target === "instance" || target === "windowed") {
          track = target;
          geometry = target === "instance"
            ? "point"
            : label?.geometry === "window"
              ? "window"
              : "interval";
        }
      }
      const duration = geometry === "point"
        ? 0
        : drag.original.track === "instance" && track === "windowed"
          ? Math.max(30, label?.defaultDuration ?? 30)
          : drag.original.end - drag.original.start;
      let start = drag.original.start;
      let end = drag.original.end;
      if (drag.mode === "move") {
        start = clamp(snapTime(drag.original.start + delta, snapMode, dragSampleRate), 0, Math.max(0, meta.durationSec - duration));
        end = geometry === "point" ? start : start + duration;
      } else if (drag.mode === "start") {
        start = clamp(snapTime(drag.original.start + delta, snapMode, dragSampleRate), 0, end - (geometry === "point" ? 0 : 0.1));
      } else {
        end = clamp(snapTime(drag.original.end + delta, snapMode, dragSampleRate), start + (geometry === "point" ? 0 : 0.1), meta.durationSec);
      }
      const normalized = normalizeAnnotationGeometry({ ...drag.original, start, end, track, geometry }, meta.durationSec);
      pendingAnnotationDragRef.current = {
        start: normalized.start,
        end: normalized.end,
        track: normalized.track,
        geometry: normalized.geometry,
      };
      drag.moved = normalized.start !== drag.original.start
        || normalized.end !== drag.original.end
        || normalized.track !== drag.original.track
        || normalized.geometry !== drag.original.geometry;
      if (dragFrameRef.current === null) dragFrameRef.current = window.requestAnimationFrame(applyPreview);
    };
    const onUp = () => {
      const drag = dragAnnotationRef.current;
      if (!drag) return;
      if (dragFrameRef.current !== null) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }
      const patch = pendingAnnotationDragRef.current;
      if (drag.moved && patch) {
        undoRef.current.push(drag.snapshot);
        if (undoRef.current.length > 100) undoRef.current.shift();
        redoRef.current = [];
        setAnnotations((current) => current.map((item) => item.id === drag.id
          ? normalizeAnnotationGeometry({ ...item, ...patch, status: item.status === "committed" ? "draft" : item.status, revision: item.revision + 1, updatedAt: new Date().toISOString() }, meta.durationSec)
          : item));
        if (patch.track !== drag.original.track) {
          setToast(patch.track === "instance"
            ? "Converted to a single-moment instance label"
            : "Converted to a windowed duration label");
        }
      }
      setAnnotationDragPreview(null);
      pendingAnnotationDragRef.current = null;
      dragAnnotationRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
    };
  }, [display.sampleRates, focusedChannel, meta, snapMode, timebase]);

  const startAnnotationDrag = (event: ReactPointerEvent, item: Annotation, mode: "move" | "start" | "end") => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedAnnotationId(item.id);
    if (annotationGeometry(item) === "session") {
      setToast("Entire-session labels always span the full recording");
      return;
    }
    pendingAnnotationDragRef.current = null;
    setAnnotationDragPreview(null);
    dragAnnotationRef.current = { id: item.id, mode, originX: event.clientX, original: { ...item }, snapshot: annotationsRef.current, moved: false };
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const resize = contextResizeRef.current;
      if (!resize) return;
      setContextTrackHeight(clamp(resize.startHeight + event.clientY - resize.startY, 44, 220));
    };
    const onUp = () => {
      contextResizeRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const jumpTo = useCallback((time: number) => {
    const start = clamp(time - timebase / 2, 0, Math.max(0, meta.durationSec - timebase));
    setViewStart(start);
    setCursorTime(time);
  }, [meta.durationSec, timebase]);

  const onViewerWheel = useCallback((event: WheelEvent) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    event.preventDefault();
    const rect = viewer.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) {
      const anchor = viewStart + clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1) * timebase;
      zoomTimeWindow(event.deltaY < 0 ? "in" : "out", anchor);
      return;
    }
    const rawDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.width : 1;
    wheelDeltaRef.current += rawDelta * unit;
    wheelWidthRef.current = Math.max(1, rect.width);
    if (wheelFrameRef.current !== null) return;
    wheelFrameRef.current = window.requestAnimationFrame(() => {
      const seconds = (wheelDeltaRef.current / wheelWidthRef.current) * timebase;
      wheelDeltaRef.current = 0;
      wheelFrameRef.current = null;
      setViewStartSafe((current) => current + seconds);
    });
  }, [setViewStartSafe, timebase, viewStart, zoomTimeWindow]);

  useLayoutEffect(() => {
    viewerWheelRef.current = onViewerWheel;
  }, [onViewerWheel]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const handleWheel = (event: WheelEvent) => viewerWheelRef.current(event);
    viewer.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    return () => viewer.removeEventListener("wheel", handleWheel, { capture: true });
  }, []);

  useEffect(() => () => {
    if (wheelFrameRef.current !== null) window.cancelAnimationFrame(wheelFrameRef.current);
    if (cursorFrameRef.current !== null) window.cancelAnimationFrame(cursorFrameRef.current);
  }, []);

  const selectCandidate = useCallback((index: number) => {
    if (!candidates[index]) return;
    setActiveCandidate(index);
    setCandidates((items) => items.map((item, itemIndex) => {
      if (itemIndex === index && (item.status === "queued" || item.status === "active")) return { ...item, status: "active" };
      if (itemIndex !== index && item.status === "active") return { ...item, status: "queued" };
      return item;
    }));
    jumpTo(candidates[index].time);
  }, [candidates, jumpTo]);

  const skipActiveCandidate = useCallback(() => {
    const current = candidates[activeCandidate];
    if (!current) return;
    setCandidates((items) => items.map((item, index) => index === activeCandidate ? { ...item, status: "skipped" } : item));
    const nextIndex = candidates.findIndex((item, index) => index > activeCandidate && item.status !== "reviewed" && item.status !== "skipped");
    if (nextIndex >= 0) selectCandidate(nextIndex);
    else setToast("Candidate skipped — no later unresolved instances");
  }, [activeCandidate, candidates, selectCandidate]);

  const loadSource = useCallback(async (source: SignalSource, file: File, interpretation?: Record<string, unknown>) => {
    sourceRef.current = source;
    const nextMeta = sourceMeta(source);
    let lastProgressBucket = -1;
    setToast("Computing full source SHA-256…");
    const contentHash = await sha256Blob(file, {
      onProgress: (bytesHashed, totalBytes) => {
        const bucket = totalBytes ? Math.floor((bytesHashed / totalBytes) * 10) : 10;
        if (bucket !== lastProgressBucket) {
          lastProgressBucket = bucket;
          setToast(`Verifying source integrity… ${Math.min(100, bucket * 10)}%`);
        }
      },
    });
    const interpretationMaterial = interpretation ? JSON.stringify(interpretation) : undefined;
    const interpretationHash = interpretationMaterial
      ? await sha256Blob(new Blob([`neurotrace-interpretation-v1\n${contentHash}\n${interpretationMaterial}`]))
      : contentHash;
    const nextKey = interpretationHash.slice(0, 32);
    setMeta(nextMeta);
    setSessionKey(nextKey);
    setRawSourceHash(contentHash);
    setSourceHash(interpretationHash);
    setSourceInterpretation(interpretation ?? null);
    setSelectedChannels(new Set(nextMeta.channelLabels.slice(0, 18).map((_, index) => index)));
    setBadChannels(new Set());
    setViewStart(0);
    setCursorTime(0);
    setTimebase(Math.min(20, Math.max(5, nextMeta.durationSec)));
    setCandidates([]);
    setActiveCandidate(0);
    setSelectedAnnotationId(null);
    setRecordingType(nextMeta.channelLabels.length > 64 ? "SEEG / iEEG" : "Scalp EEG");
    let restored: Annotation[] = [];
    try {
      const projectJson = localStorage.getItem(`neurotrace:project:${nextKey}`);
      if (projectJson) {
        const project = JSON.parse(projectJson) as {
          annotations?: unknown;
          candidates?: Candidate[];
          activeCandidate?: number;
          badChannels?: number[];
          reviewer?: string;
          recordingType?: string;
        };
        restored = migrateAnnotationList(project.annotations, nextMeta.durationSec, nextMeta.channelLabels.length);
        if (Array.isArray(project.candidates)) {
          const restoredCandidates = migrateCandidateList(project.candidates, nextMeta.durationSec);
          setCandidates(restoredCandidates);
          if (Number.isInteger(project.activeCandidate) && restoredCandidates.length) {
            setActiveCandidate(clamp(project.activeCandidate as number, 0, restoredCandidates.length - 1));
          }
        }
        if (Array.isArray(project.badChannels)) {
          setBadChannels(new Set(project.badChannels.filter((index) => Number.isInteger(index) && index >= 0 && index < nextMeta.channelLabels.length)));
        }
        if (typeof project.reviewer === "string") setReviewer(project.reviewer);
        if (typeof project.recordingType === "string") setRecordingType(project.recordingType);
      } else {
        const cached = localStorage.getItem(`neurotrace:draft:${nextKey}`);
        if (cached) restored = migrateAnnotationList(JSON.parse(cached), nextMeta.durationSec, nextMeta.channelLabels.length);
      }
    } catch {
      try {
        const cached = localStorage.getItem(`neurotrace:draft:${nextKey}`);
        if (cached) restored = migrateAnnotationList(JSON.parse(cached), nextMeta.durationSec, nextMeta.channelLabels.length);
      } catch { /* local recovery is optional */ }
    }
    setAnnotations(restored);
    undoRef.current = [];
    redoRef.current = [];
    setToast(restored.length
      ? `Recovered ${restored.length} labels and local review state`
      : `${nextMeta.format} recording ready — ${nextMeta.channelLabels.length} channels${nextMeta.warnings.length ? ` · ${nextMeta.warnings.length} source warning${nextMeta.warnings.length === 1 ? "" : "s"}` : ""}`);
    setShowImport(false);
  }, []);

  const importFiles = async (files: File[]) => {
    if (!files.length) return;
    setImportBusy(true);
    setShowImport(true);
    try {
      const edf = files.find((file) => /\.edf$/i.test(file.name));
      const dat = files.find((file) => /\.dat$/i.test(file.name));
      const datStem = dat?.name.replace(/\.dat$/i, "").toLowerCase();
      const mat = dat
        ? files.find((file) => /\.mat$/i.test(file.name) && file.name.replace(/\.mat$/i, "").toLowerCase() === datStem)
        : files.find((file) => /\.mat$/i.test(file.name));
      if (edf) {
        const source = await EDFSource.create(edf);
        await loadSource(source, edf);
        const importedCandidates = source.events
          .filter((event) => event.timeSec >= 0 && event.timeSec < source.meta.durationSec)
          .map((event, index): Candidate => ({
            id: `edf-cand-${index}-${Math.round(event.timeSec * 1000)}`,
            time: event.timeSec,
            label: event.label,
            source: "bronze",
            status: index === 0 ? "active" : "queued",
          }));
        if (importedCandidates.length) {
          setCandidates((restored) => importedCandidates.map((candidate) => {
            const prior = restored.find((item) => item.id === candidate.id);
            return prior ? { ...candidate, status: prior.status } : candidate;
          }));
          setViewStart(clamp(importedCandidates[0].time - 10, 0, Math.max(0, source.meta.durationSec - 20)));
          setCursorTime(importedCandidates[0].time);
          setCursorLocked(true);
        }
      } else if (dat) {
        let legacyMetadata: LegacyMatMetadata | null = null;
        if (mat) {
          try {
            legacyMetadata = await parseLegacyMatMetadata(mat);
            setDatMapping({
              sampleRate: legacyMetadata?.sampleRate ?? 0,
              channelCount: legacyMetadata?.channelCount || legacyMetadata?.channelLabels.length || 0,
              physicalScale: 1,
            });
          } catch (error) {
            setToast(`Companion MAT needs manual mapping: ${error instanceof Error ? error.message : "metadata could not be read"}`);
          }
        }
        if (!legacyMetadata) setDatMapping({ sampleRate: 0, channelCount: 0, physicalScale: 1 });
        setPendingDat(dat);
        setPendingLegacyMatFile(mat ?? null);
        setPendingLegacyMeta(legacyMetadata);
        setShowImport(true);
        if (legacyMetadata) setToast(`Legacy MAT + DAT mapped — ${legacyMetadata.events.length} candidate event${legacyMetadata.events.length === 1 ? "" : "s"} found`);
        else if (!mat) setToast("Raw DAT detected — confirm channel mapping");
      } else if (mat) {
        await loadSource(await MatSource.create(mat), mat);
      } else {
        throw new Error("Choose an EDF, self-contained MAT, or paired MAT + DAT recording.");
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "This recording could not be opened");
      setShowImport(true);
    } finally {
      setImportBusy(false);
    }
  };

  const confirmDatImport = async () => {
    if (!pendingDat) return;
    setImportBusy(true);
    try {
      const companionMatHash = pendingLegacyMatFile
        ? await sha256Blob(pendingLegacyMatFile)
        : null;
      const source = await RawDatSource.create(pendingDat, {
        ...datMapping,
        channelLabels: pendingLegacyMeta?.channelLabels.length === datMapping.channelCount ? pendingLegacyMeta.channelLabels : undefined,
        channelUnits: "µV",
        warnings: [
          ...(pendingLegacyMeta?.warnings ?? []),
          "Physical scale is reviewer-confirmed mapping metadata; the headerless DAT does not encode calibration.",
        ],
        assumptions: [
          `confirmed sample rate ${datMapping.sampleRate} Hz`,
          `confirmed channel count ${datMapping.channelCount}`,
          `confirmed physical scale ${datMapping.physicalScale} µV/count`,
        ],
      });
      const interpretation = {
        kind: "raw-int16-le",
        companion_mat_sha256: companionMatHash,
        sample_rate_hz: datMapping.sampleRate,
        channel_count: datMapping.channelCount,
        physical_scale_uv_per_count: datMapping.physicalScale,
        layout: "sample-major channel-interleaved signed int16 little-endian",
      };
      await loadSource(source, pendingDat, interpretation);
      if (pendingLegacyMeta?.events.length) {
        const importedCandidates = pendingLegacyMeta.events
          .map((event, index): Candidate => ({
            id: `cand-${index}-${Math.round(event.timeSec * 1000)}`,
            time: event.timeSec,
            label: event.label,
            source: "bronze",
            status: index === 0 ? "active" : "queued",
          }));
        setCandidates((restored) => importedCandidates.map((candidate) => {
          const prior = restored.find((item) => item.id === candidate.id);
          return prior ? { ...candidate, status: prior.status } : candidate;
        }));
        if (importedCandidates[0]) {
          const importedWindow = Math.min(20, Math.max(5, source.meta.durationSec));
          setViewStart(clamp(importedCandidates[0].time - importedWindow / 2, 0, Math.max(0, source.meta.durationSec - importedWindow)));
          setCursorTime(clamp(importedCandidates[0].time, 0, source.meta.durationSec));
        }
      }
      setPendingDat(null);
      setPendingLegacyMatFile(null);
      setPendingLegacyMeta(null);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Raw binary mapping failed");
    } finally {
      setImportBusy(false);
    }
  };

  const exportBundle = () => {
    if (meta.details?.discontinuous === true) {
      setRightPanelOpen(true);
      setRightTab("qc");
      setShowExport(false);
      setToast("Export blocked: EDF+D gaps need a discontinuous time-axis conversion before model-ready export");
      return;
    }
    const sampleRate = primarySampleRate(meta);
    const uniformSampleRate = meta.sampleRates.length > 0 && meta.sampleRates.every((rate) => Math.abs(rate - sampleRate) < 1e-9);
    const patientId = patientLabel(meta);
    const recordingId = recordingLabel(meta);
    const base = recordingId.replace(/[^a-zA-Z0-9_-]+/g, "_");
    const committed = annotations.filter((item) => item.status === "committed");
    const eventsTsv = [["annotation_id", "onset", "duration", "trial_type", "geometry", "track", "confidence", "origin", "reviewer", "candidate_id", "source_event_label", "source_event_time", "relative_onset", "relative_offset", "primary_channel", "source_channel_indices", "reference_contributors", "montage", "notes"].join("\t"), ...committed.map((item) => {
      const label = LABEL_BY_ID.get(item.labelId);
      const candidate = candidates.find((entry) => entry.id === item.candidateId);
      return [
        item.id,
        item.start.toFixed(6),
        Math.max(0, item.end - item.start).toFixed(6),
        label?.name ?? item.labelId,
        annotationGeometry(item),
        item.track,
        item.confidence,
        item.origin,
        item.reviewer,
        item.candidateId ?? "",
        candidate?.label ?? "",
        candidate?.time.toFixed(6) ?? "",
        candidate ? (item.start - candidate.time).toFixed(6) : "",
        candidate ? (item.end - candidate.time).toFixed(6) : "",
        item.channelScope ? meta.channelLabels[item.channelScope.primarySourceIndex] ?? item.channelScope.displayLabel : item.channels.map((index) => meta.channelLabels[index]).join(","),
        item.channelScope?.sourceIndices.join(",") ?? item.channels.join(","),
        item.channelScope?.sourceIndices.filter((index) => index !== item.channelScope?.primarySourceIndex).map((index) => meta.channelLabels[index] ?? `Ch ${index + 1}`).join(",") ?? "",
        item.channelScope?.montage ?? "",
        item.notes,
      ].map(tsvCell).join("\t");
    })].join("\n");
    const channelsTsv = ["name\ttype\tunits\tsampling_frequency\tstatus\tstatus_description", ...meta.channelLabels.map((name, index) => [name, recordingType.includes("SEEG") ? "SEEG" : "EEG", meta.channelUnits[index] ?? "uV", meta.sampleRates[index] ?? sampleRate, badChannels.has(index) ? "bad" : "good", badChannels.has(index) ? "Reviewer-excluded channel" : ""].map(tsvCell).join("\t"))].join("\n");
    const windowRows = ["patient_id,session_id,start_sec,end_sec,start_sample,end_sample,sample_basis,entire_session_context,timed_context,windowed_labels,instance_labels,next_seizure_sec,windowed_confidence,instance_confidence,windowed_origins,instance_origins,bad_channel_mask,split"];
    const seizureStarts = committed.filter((item) => item.labelId === "ictal").map((item) => item.start).sort((a, b) => a - b);
    const entireSessionContext = committed
      .filter((item) => item.track === "context" && annotationGeometry(item) === "session")
      .map((item) => item.labelId);
    for (let start = 0; start < meta.durationSec; start += 30) {
      const end = Math.min(meta.durationSec, start + 30);
      const relevant = committed.filter((item) => annotationOverlapsWindow(item, start, end));
      const timedContext = relevant.filter((item) => item.track === "context" && annotationGeometry(item) !== "session");
      const windowedLabels = relevant.filter((item) => item.track === "windowed");
      const instanceLabels = relevant.filter((item) => item.track === "instance");
      const nextSeizure = seizureStarts.find((time) => time >= end);
      const windowedConfidence = windowedLabels.length ? Math.round(windowedLabels.reduce((sum, item) => sum + item.confidence, 0) / windowedLabels.length) : "";
      const instanceConfidence = instanceLabels.length ? Math.round(instanceLabels.reduce((sum, item) => sum + item.confidence, 0) / instanceLabels.length) : "";
      windowRows.push([
        patientId,
        recordingId,
        start.toFixed(3),
        end.toFixed(3),
        uniformSampleRate ? Math.round(start * sampleRate) : "",
        uniformSampleRate ? Math.round(end * sampleRate) : "",
        uniformSampleRate ? `${sampleRate} Hz universal` : "mixed channel rates; seconds authoritative",
        [...new Set(entireSessionContext)].join("|"),
        [...new Set(timedContext.map((item) => item.labelId))].join("|"),
        [...new Set(windowedLabels.map((item) => item.labelId))].join("|"),
        [...new Set(instanceLabels.map((item) => item.labelId))].join("|"),
        nextSeizure === undefined ? "" : (nextSeizure - end).toFixed(3),
        windowedConfidence,
        instanceConfidence,
        [...new Set(windowedLabels.map((item) => item.origin))].join("|"),
        [...new Set(instanceLabels.map((item) => item.origin))].join("|"),
        [...badChannels].join("|"),
        "unassigned",
      ].map(csvCell).join(","));
    }
    const candidateEventsTsv = [["candidate_id", "source_event_time", "source_event_label", "status", "source", "linked_annotation_ids", "linked_annotation_statuses", "relative_onsets", "relative_offsets"].join("\t"), ...candidates.map((candidate) => {
      const linked = annotations.filter((item) => item.candidateId === candidate.id);
      return [
        candidate.id,
        candidate.time.toFixed(6),
        candidate.label,
        candidate.status,
        candidate.source,
        linked.map((item) => item.id).join("|"),
        linked.map((item) => item.status).join("|"),
        linked.map((item) => (item.start - candidate.time).toFixed(6)).join("|"),
        linked.map((item) => (item.end - candidate.time).toFixed(6)).join("|"),
      ].map(tsvCell).join("\t");
    })].join("\n");
    const recordingJson = JSON.stringify({
      patient_id: patientId,
      session_id: recordingId,
      recording_type: recordingType,
      format: meta.format,
      duration_seconds: meta.durationSec,
      sampling_frequency: uniformSampleRate ? sampleRate : null,
      channel_sampling_frequencies: meta.sampleRates,
      start_time: meta.startedAt ? meta.startedAt.toISOString().replace(/Z$/, "") : undefined,
      start_time_timezone: meta.format === "edf" || meta.format === "edf+" ? "unspecified in EDF source" : "source-defined or unspecified",
      source_content_sha256: rawSourceHash,
      session_interpretation_sha256: sourceHash,
      source_hash: sourceHash,
      source_hash_method: "full-file SHA-256; session identity additionally includes raw interpretation when applicable",
      source_interpretation: sourceInterpretation,
      display_snapshot: { montage, filters, gain, snapMode },
      local_processing: true,
      generated_at: new Date().toISOString(),
    }, null, 2);
    const ontology = JSON.stringify({ version: "neurotrace-1.0.0", labels: LABELS }, null, 2);
    const annotationsJsonl = annotations.map((item) => {
      const annotationRate = item.channelScope
        ? meta.sampleRates[item.channelScope.primarySourceIndex]
        : uniformSampleRate
          ? sampleRate
          : undefined;
      return JSON.stringify({
        ...item,
        label: LABEL_BY_ID.get(item.labelId)?.name,
        start_sample: annotationRate ? Math.round(item.start * annotationRate) : null,
        end_sample: annotationRate ? Math.round(item.end * annotationRate) : null,
        sample_rate_basis_hz: annotationRate ?? null,
        source_content_sha256: rawSourceHash,
        session_interpretation_sha256: sourceHash,
        source_hash: sourceHash,
      });
    }).join("\n");
    const qcReport = JSON.stringify({ generated_at: new Date().toISOString(), issues: qcIssues, bad_channels: [...badChannels].map((index) => meta.channelLabels[index]), drafts_excluded_from_events_tsv: annotations.filter((item) => item.status === "draft").length }, null, 2);
    const manifest = JSON.stringify({ schema: "neurotrace-forecasting-manifest/1.1", patient: patientId, recording_type: recordingType, session: recordingId, files: ["events.tsv", "candidate_events.tsv", "channels.tsv", "recording.json", "annotations.jsonl", "windows.csv", "ontology.json", "qc_report.json"], leakage_guard: "Assign train/validation/test split by patient; current split is unassigned." }, null, 2);
    const readme = "NeuroTrace model-ready annotation bundle\n\nRaw EEG is not included. Seconds are authoritative. Sample positions are only emitted when a universal or annotation-specific channel rate exists. Only committed labels appear in events.tsv; drafts and suggestions remain in annotations.jsonl for audit. candidate_events.tsv preserves source-event lineage and relative timing. Review recording.json and qc_report.json before training. Group dataset splits by patient to prevent leakage.\n";
    const zip = createStoredZip([
      { name: `${base}/events.tsv`, content: eventsTsv },
      { name: `${base}/candidate_events.tsv`, content: candidateEventsTsv },
      { name: `${base}/channels.tsv`, content: channelsTsv },
      { name: `${base}/recording.json`, content: recordingJson },
      { name: `${base}/annotations.jsonl`, content: annotationsJsonl },
      { name: `${base}/windows.csv`, content: windowRows.join("\n") },
      { name: `${base}/ontology.json`, content: ontology },
      { name: `${base}/qc_report.json`, content: qcReport },
      { name: `${base}/manifest.json`, content: manifest },
      { name: `${base}/README.txt`, content: readme },
    ]);
    downloadBlob(`${base}_model_ready.zip`, zip);
    setShowExport(false);
    setToast(`Exported ${committed.length} committed labels + ${Math.ceil(meta.durationSec / 30)} training windows`);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const zoomModifier = event.metaKey || event.ctrlKey;
      const zoomInKey = ["+", "="].includes(event.key) || ["Equal", "NumpadAdd"].includes(event.code);
      const zoomOutKey = ["-", "_"].includes(event.key) || ["Minus", "NumpadSubtract"].includes(event.code);
      if (zoomModifier && (zoomInKey || zoomOutKey)) {
        event.preventDefault();
        event.stopPropagation();
        zoomTimeWindow(zoomInKey ? "in" : "out", cursorLocked ? cursorTime : undefined);
        return;
      }
      if (event.key === "Escape" && (showShortcuts || showImport || showSessionMap || confirmCommit.length)) {
        event.preventDefault();
        if (showShortcuts) setShowShortcuts(false);
        else if (showSessionMap) setShowSessionMap(false);
        else if (showImport && !importBusy) setShowImport(false);
        else if (confirmCommit.length) setConfirmCommit([]);
        setSelectedAnnotationId(null);
        setSelection(null);
        setMarkOnset(null);
        setCursorLocked(false);
        setDragGhost(null);
        setActiveTool("cursor");
        return;
      }
      if (showShortcuts || showImport || showSessionMap || confirmCommit.length) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (dragAnnotationRef.current) {
          dragAnnotationRef.current = null;
          pendingAnnotationDragRef.current = null;
        }
        setAnnotationDragPreview(null);
        (event.target as HTMLElement | null)?.blur?.();
        setSelectedAnnotationId(null);
        setSelection(null);
        setMarkOnset(null);
        setCursorLocked(false);
        setDragGhost(null);
        setActiveTool("cursor");
        setToast("Selection and pinned cursor cleared");
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select")) return;
      const lower = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && lower === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault(); setViewStartSafe((value) => value - (event.shiftKey ? 10 : 1));
      } else if (event.key === "ArrowRight") {
        event.preventDefault(); setViewStartSafe((value) => value + (event.shiftKey ? 10 : 1));
      } else if (event.key === "PageDown") {
        event.preventDefault(); setViewStartSafe((value) => value + timebase);
      } else if (event.key === "PageUp") {
        event.preventDefault(); setViewStartSafe((value) => value - timebase);
      } else if (lower === "u") {
        if (event.shiftKey) redo();
        else undo();
      } else if (lower === "i") {
        setMarkOnset(cursorTime); setActiveTool("seizure"); setToast(`Onset placed at ${formatClock(cursorTime, true)} — press O at offset`);
      } else if (lower === "o" && markOnset !== null) {
        if (cursorTime > markOnset) { addAnnotation(LABEL_BY_ID.get("ictal")!, markOnset, cursorTime); setMarkOnset(null); setActiveTool("cursor"); }
        else setToast("Offset must be after onset");
      } else if (lower === "s" || event.key === "Enter" || event.code === "Space") {
        if (event.code === "Space") event.preventDefault();
        commitSelected();
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedAnnotationId) {
        event.preventDefault(); deleteAnnotation(selectedAnnotationId);
      } else if (lower === "n" && candidates.length) {
        selectCandidate(Math.min(candidates.length - 1, activeCandidate + 1));
      } else if (lower === "p" && candidates.length) {
        selectCandidate(Math.max(0, activeCandidate - 1));
      } else if (lower === "k" && candidates.length) {
        skipActiveCandidate();
      } else if (lower === "b" && selectedChannels.size) {
        const originalIndex = display.primarySourceIndices[focusedChannel] ?? [...selectedChannels][0];
        setBadChannels((current) => {
          const next = new Set(current);
          if (next.has(originalIndex)) next.delete(originalIndex);
          else next.add(originalIndex);
          return next;
        });
        setToast(`${meta.channelLabels[originalIndex] ?? "Focused source channel"} quality updated`);
      } else if (event.key === "?") {
        setShowShortcuts(true);
      } else if (/^[1-9]$/.test(event.key)) {
        const label = LABELS.find((item) => item.shortcut === event.key);
        if (label && (cursorLocked || selection || label.geometry === "session")) addAnnotation(label, selection?.start ?? cursorTime, selection?.end);
        else if (label) setToast("Click the waveform to pin a time, then choose a label");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activeCandidate, addAnnotation, candidates, commitSelected, confirmCommit.length, cursorLocked, cursorTime, deleteAnnotation, display.primarySourceIndices, focusedChannel, importBusy, markOnset, meta.channelLabels, redo, selectCandidate, selectedAnnotationId, selectedChannels, selection, setViewStartSafe, showImport, showSessionMap, showShortcuts, skipActiveCandidate, timebase, undo, zoomTimeWindow]);

  const overviewLeft = (viewStart / Math.max(1, meta.durationSec)) * 100;
  const overviewWidth = Math.min(100, (timebase / Math.max(1, meta.durationSec)) * 100);
  const activeLabelGroups = ["Seizure", "Rhythmic / periodic", "Sleep stage", "Quality", "Instance"] as const;
  const filteredLabels = LABELS.filter((label) => !label.hidden && label.name.toLowerCase().includes(paletteSearch.toLowerCase()));
  const entireSessionContexts = filteredLabels.filter((label) => label.track === "context" && label.geometry === "session");
  const windowContexts = filteredLabels.filter((label) => label.track === "context" && label.geometry !== "session");
  const renderAnnotations = useMemo(() => annotationDragPreview
    ? annotations.map((item) => item.id === annotationDragPreview.id
      ? normalizeAnnotationGeometry({ ...item, ...annotationDragPreview.patch }, meta.durationSec)
      : item)
    : annotations, [annotationDragPreview, annotations, meta.durationSec]);
  const visibleAnnotations = useMemo(
    () => renderAnnotations.filter((item) => annotationOverlapsWindow(item, viewStart, viewStart + timebase)),
    [renderAnnotations, timebase, viewStart],
  );
  const contextLaneLayout = useMemo(
    () => assignAnnotationLanes(visibleAnnotations.filter((item) => item.track === "context")),
    [visibleAnnotations],
  );
  const contextLaneCapacity = Math.max(1, Math.floor((contextTrackHeight - 8) / 32));
  const contextLaneStep = contextLaneLayout.laneCount <= contextLaneCapacity
    ? 32
    : contextLaneCapacity > 1
      ? Math.max(8, (contextTrackHeight - 36) / (contextLaneCapacity - 1))
      : 0;
  const placePaletteLabel = (label: LabelDefinition) => {
    if (!cursorLocked && !selection && label.geometry !== "session") {
      setToast("Click the waveform to pin a time, then choose a label");
      return;
    }
    addAnnotation(label, selection?.start ?? cursorTime, selection?.end);
  };
  const tracks: Array<{ id: TrackId; label: string }> = [
    { id: "context", label: "Context" },
    { id: "windowed", label: "Windowed Labels" },
    { id: "instance", label: "Instance Labels" },
  ];
  const gridDivisions = timebase <= 30 ? Math.max(2, Math.ceil(timebase / 5)) : 10;

  return (
    <main className="neuro-app" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      if (event.dataTransfer.files.length) importFiles([...event.dataTransfer.files]);
    }}>
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /><i /></span>
          <div><strong>NEUROTRACE</strong><span>Clinical EEG Studio</span></div>
        </div>
        <div className="session-identity">
          <span className="session-patient">{patientLabel(meta)}</span>
          <span className="slash">/</span>
          <span>{recordingLabel(meta)}</span>
          <span className="session-format">{recordingType}</span>
        </div>
        <div className="top-actions">
          <button className="button secondary" onClick={() => setShowImport(true)}>Load recording</button>
          <div className="menu-wrap">
            <button className="button primary" onClick={() => setShowExport((value) => !value)}>Export <span aria-hidden="true">⌄</span></button>
            {showExport && <div className="popover export-popover">
              <strong>Model-ready bundle</strong>
              <p>BIDS-style events and channels, full provenance, 30-second windows, ontology, manifest, and QC report.</p>
              <button className="button primary wide" onClick={exportBundle}>Download .zip</button>
              <small>Raw EEG is never included.</small>
            </div>}
          </div>
        </div>
      </header>

      <div className={`workspace-grid ${leftPanelOpen ? "" : "left-collapsed"} ${rightPanelOpen ? "" : "right-collapsed"}`}>
        <aside className="left-sidebar">
          <section className="sidebar-section session-card">
            <div className="section-heading"><span>Session</span><button aria-label="Open session map" onClick={() => setShowSessionMap(true)}>↗</button></div>
            <div className="file-row"><span className="file-type">{meta.format}</span><div><strong title={meta.name}>{shortFileName(meta.name)}</strong><small>{formatClock(meta.durationSec)} · {meta.channelLabels.length} ch · {primarySampleRate(meta)} Hz</small></div></div>
            <div className="session-detail-grid">
              <div><span>Started</span><strong>{formatSessionStart(meta.startedAt)}</strong></div>
              <div><span>Source</span><strong className="hash-text" title={sourceHash}>{sourceHashDisplay}</strong></div>
            </div>
            <label className="compact-field"><span>Recording type</span><select value={recordingType} onChange={(event) => setRecordingType(event.target.value)}><option>SEEG / iEEG</option><option>Scalp EEG</option><option>Simultaneous scalp + iEEG</option><option>Other ephys</option></select></label>
            <label className="compact-field reviewer-field"><span>Reviewer initials</span><input value={reviewer} maxLength={12} onChange={(event) => setReviewer(event.target.value.toUpperCase())} /></label>
          </section>

          <section className="sidebar-section queue-section">
            <div className="section-heading"><span>Instance queue</span><small>{candidates.filter((item) => item.status === "reviewed").length}/{candidates.length}</small></div>
            <div className="queue-list">
              {candidates.length ? candidates.map((candidate, index) => <button key={candidate.id} className={`queue-item ${index === activeCandidate ? "active" : ""}`} onClick={() => selectCandidate(index)}>
                <span className={`queue-status ${candidate.status}`} />
                <span className="queue-copy"><strong>{candidate.label}</strong><small>{formatClock(candidate.time, true)}</small></span>
                <span className="queue-arrow">›</span>
              </button>) : <div className="empty-queue"><strong>No imported candidates</strong><p>Review freely or add the cursor position.</p><button onClick={() => setCandidates([{ id: makeId("cand"), time: cursorTime, label: "Manual review target", source: "gold", status: "active" }])}>+ Add {formatClock(cursorTime, true)}</button></div>}
            </div>
            {candidates.length > 0 && <div className="queue-actions"><button onClick={skipActiveCandidate}>Skip current <kbd>K</kbd></button><button onClick={() => selectCandidate(Math.min(candidates.length - 1, activeCandidate + 1))}>Next <kbd>N</kbd></button></div>}
          </section>

          <section className="sidebar-section channel-section">
            <div className="section-heading"><span>Channels</span><small>{selectedChannels.size}/{meta.channelLabels.length}</small></div>
            <div className="channel-tools"><input aria-label="Search channels" placeholder="Find contact…" value={channelSearch} onChange={(event) => setChannelSearch(event.target.value)} /><button onClick={() => setSelectedChannels(new Set(meta.channelLabels.map((_, index) => index)))}>All</button></div>
            <div className="channel-list">
              {meta.channelLabels.map((name, index) => ({ name, index })).filter(({ name }) => name.toLowerCase().includes(channelSearch.toLowerCase())).map(({ name, index }) => <label key={`${name}-${index}`} className={`channel-row ${badChannels.has(index) ? "bad" : ""}`}>
                <input type="checkbox" checked={selectedChannels.has(index)} onChange={() => setSelectedChannels((current) => {
                  const next = new Set(current);
                  if (next.has(index)) next.delete(index);
                  else next.add(index);
                  return next;
                })} />
                <span className="channel-name">{name}</span>
                <span className="channel-unit">{meta.channelUnits[index] ?? "µV"}</span>
                <button type="button" title={badChannels.has(index) ? "Restore channel" : "Mark bad"} onClick={(event) => {
                  event.preventDefault();
                  setBadChannels((current) => {
                    const next = new Set(current);
                    if (next.has(index)) next.delete(index);
                    else next.add(index);
                    return next;
                  });
                }}>{badChannels.has(index) ? "BAD" : "···"}</button>
              </label>)}
            </div>
          </section>
        </aside>

        <section className="review-surface">
          <div className="viewer-toolbar">
            <button className={`compact-toggle panel-toggle ${leftPanelOpen ? "active" : ""}`} aria-pressed={leftPanelOpen} title={`${leftPanelOpen ? "Hide" : "Show"} session and channels panel`} onClick={() => setLeftPanelOpen((value) => !value)}><span aria-hidden="true">☰</span><b>Session</b></button>
            <button className={`compact-toggle panel-toggle ${rightPanelOpen ? "active" : ""}`} aria-pressed={rightPanelOpen} title={`${rightPanelOpen ? "Hide" : "Show"} labels and QC panel`} onClick={() => setRightPanelOpen((value) => !value)}><span aria-hidden="true">▤</span><b>Labels / QC</b></button>
            <div className="transport-group">
              <button aria-label="Previous page" onClick={() => setViewStartSafe((value) => value - timebase)}>‹</button>
              <button className={`play-button ${playing ? "playing" : ""}`} aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying((value) => !value)}>{playing ? "Ⅱ" : "▶"}</button>
              <button aria-label="Next page" onClick={() => setViewStartSafe((value) => value + timebase)}>›</button>
            </div>
            <div className="toolbar-divider" />
            <div className="toolbar-spacer" />
            <label className="toolbar-select"><span>Montage</span><select value={montage} onChange={(event) => setMontage(event.target.value as MontageMode)}><option value="referential">Recorded reference</option><option value="average">Average reference</option><option value="bipolar">Anatomical bipolar</option></select></label>
            <button className={`compact-toggle ${showFilters ? "active" : ""}`} onClick={() => setShowFilters((value) => !value)}><span className="filter-glyph">≋</span> Filters <i>{filters.enabled ? `${filters.highPassHz}–${filters.lowPassHz} · ${filters.notchHz}Hz` : "Raw"}</i></button>
            <div className="time-window-control"><span>Window</span><button aria-label="Zoom out in time" title="Zoom out · Ctrl/⌘ −" onClick={() => zoomTimeWindow("out")}>−</button><label><input aria-label="Visible seconds" type="number" min="1" max="300" step="1" value={Number(timebase.toFixed(1))} onChange={(event) => setTimeWindow(Number(event.target.value))} /><b>s</b></label><button aria-label="Zoom in in time" title="Zoom in · Ctrl/⌘ +" onClick={() => zoomTimeWindow("in")}>+</button></div>
            <div className="gain-control"><span>Gain</span><button onClick={() => setGain((value) => Math.max(0.25, value / 1.25))}>−</button><b>{gain.toFixed(1)}×</b><button onClick={() => setGain((value) => Math.min(8, value * 1.25))}>+</button></div>
          </div>

          {showFilters && <div className="filter-drawer">
            <div><strong>Display filters</strong><span>Raw samples remain unchanged</span></div>
            <label>High-pass <input type="number" min="0" step="0.1" value={filters.highPassHz} onChange={(event) => setFilters((current) => ({ ...current, highPassHz: Number(event.target.value) }))} /> Hz</label>
            <label>Low-pass <input type="number" min="1" step="1" value={filters.lowPassHz} onChange={(event) => setFilters((current) => ({ ...current, lowPassHz: Number(event.target.value) }))} /> Hz</label>
            <label>Notch <select value={filters.notchHz} onChange={(event) => setFilters((current) => ({ ...current, notchHz: Number(event.target.value) as 0 | 50 | 60 }))}><option value="0">Off</option><option value="50">50 Hz</option><option value="60">60 Hz</option></select></label>
            <label className="switch-label"><input type="checkbox" checked={filters.enabled} onChange={(event) => setFilters((current) => ({ ...current, enabled: event.target.checked }))} /><span /> Enabled</label>
            <button onClick={() => setFilters({ ...DEFAULT_FILTERS, enabled: false })}>Reset to raw</button>
          </div>}

          <div className="overview-block">
            <div className="overview-label"><span>FULL SESSION</span><strong>{formatClock(viewStart)} — {formatClock(viewStart + timebase)}</strong></div>
            <div className="overview-track" ref={overviewRef} onPointerDown={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              jumpTo(((event.clientX - rect.left) / rect.width) * meta.durationSec);
            }}>
              <div className="overview-wave" aria-hidden="true">{Array.from({ length: 110 }, (_, index) => <i key={index} style={{ height: `${18 + ((index * 37) % 33) + (index > 13 && index < 19 ? 30 : 0)}%` }} />)}</div>
              {annotations.filter((item) => item.labelId === "ictal").map((item) => <span key={item.id} className="overview-event" style={{ left: `${(item.start / meta.durationSec) * 100}%`, width: `${Math.max(0.2, ((item.end - item.start) / meta.durationSec) * 100)}%` }} />)}
              <div className="overview-viewport" style={{ left: `${overviewLeft}%`, width: `${Math.max(overviewWidth, 0.55)}%` }}><i /><i /></div>
            </div>
            <div className="overview-time"><span>00:00</span><span>{formatClock(meta.durationSec / 2)}</span><span>{formatClock(meta.durationSec)}</span></div>
          </div>

          <div ref={viewerRef} className={`signal-and-tracks ${spectrogramOpen ? "with-spectrogram" : ""}`} onDragOver={onLabelDragOver} onDrop={onLabelDrop} onDragLeave={() => setDragGhost(null)}>
            <div className="waveform-wrap">
              <div className="channel-rail" style={{ gridTemplateRows: `repeat(${Math.max(1, display.labels.length)}, 1fr)` }}>
                {display.labels.map((label, index) => <button key={`${label}-${index}`} className={focusedChannel === index ? "focused" : ""} onClick={() => setFocusedChannel(index)}><strong>{label}</strong><span>{formatAmplitude(display.data[index]?.[Math.floor(display.data[index].length / 2)] ?? 0)}</span></button>)}
              </div>
              <div className="canvas-shell">
                <canvas ref={canvasRef} aria-label="EEG waveform" onPointerDown={onWavePointerDown} onPointerMove={onWavePointerMove} onPointerUp={onWavePointerUp} />
                {selection && <div className="wave-selection" style={{
                  left: `${((Math.max(viewStart, selection.start) - viewStart) / timebase) * 100}%`,
                  width: `${Math.max(0, ((Math.min(viewStart + timebase, selection.end) - Math.max(viewStart, selection.start)) / timebase) * 100)}%`,
                }} />}
                {activeCandidateItem && activeCandidateItem.time >= viewStart && activeCandidateItem.time <= viewStart + timebase && <div className="candidate-cursor" style={{ left: `${((activeCandidateItem.time - viewStart) / timebase) * 100}%` }}><span>Candidate</span></div>}
                {cursorLocked && cursorTime >= viewStart && cursorTime <= viewStart + timebase && <div className="wave-cursor pinned" style={{ left: `${((cursorTime - viewStart) / timebase) * 100}%` }}><span>{formatClock(cursorTime, true)}</span></div>}
                {loadingSignal && <div className="signal-loading"><span /> Reading signal window…</div>}
                {dragGhost && <div className="drop-ghost" style={{ left: `${((dragGhost.time - viewStart) / timebase) * 100}%` }}><span>{formatClock(dragGhost.time, true)}</span></div>}
                {!display.data.length && !loadingSignal && <div className="no-channels"><strong>No visible channels</strong><span>Select channels in the left panel.</span></div>}
              </div>
            </div>

            {spectrogramOpen && <SpectrogramPanel data={display.data[focusedChannel]} sampleRate={display.sampleRates[focusedChannel] || primarySampleRate(meta)} start={viewStart} cursor={cursorTime} label={display.labels[focusedChannel] || "Focused channel"} />}

            <div className="timeline" ref={timelineRef}>
              {tracks.map((track) => <div className={`timeline-row ${track.id === "context" ? "context-row" : ""}`} key={track.id} style={track.id === "context" ? { height: contextTrackHeight } : undefined}>
                <div className="track-label"><span className={`track-icon ${track.id}`} />{track.label}</div>
                <div className="track-lane" data-track-id={track.id}>
                  <div className="window-grid">{Array.from({ length: gridDivisions }, (_, index) => <i key={index} />)}</div>
                  {visibleAnnotations.filter((item) => item.track === track.id).map((item) => {
                    const label = LABEL_BY_ID.get(item.labelId)!;
                    const geometry = annotationGeometry(item);
                    const point = geometry === "point";
                    const visibleStart = point ? item.start : Math.max(item.start, viewStart);
                    const visibleEnd = point ? item.end : Math.min(item.end, viewStart + timebase);
                    const left = ((visibleStart - viewStart) / timebase) * 100;
                    const width = point ? 0 : Math.max(0.7, ((visibleEnd - visibleStart) / timebase) * 100);
                    const sourceLane = track.id === "context" ? contextLaneLayout.lanes.get(item.id) ?? 0 : 0;
                    const displayLane = Math.min(sourceLane, contextLaneCapacity - 1);
                    const top = track.id === "context" ? 5 + displayLane * contextLaneStep : 5;
                    const sharedStyle = { left: `${left}%`, top, "--label-color": label.color } as React.CSSProperties;
                    return point ? <button key={item.id} className={`event-pin ${track.id === "context" ? "context-pin" : ""} ${selectedAnnotationId === item.id ? "selected" : ""}`} style={sharedStyle} onPointerDown={(event) => startAnnotationDrag(event, item, "move")} onClick={() => setSelectedAnnotationId(item.id)} title={`${label.name} · ${formatClock(item.start, true)} · drag to move${track.id === "instance" ? " or move up to convert" : ""}`}><i /><span>{label.short}</span></button> : <div key={item.id} className={`annotation-block ${track.id === "context" ? "context-annotation" : ""} ${geometry === "session" ? "session-label" : ""} ${item.status} ${selectedAnnotationId === item.id ? "selected" : ""}`} style={{ ...sharedStyle, width: `${width}%` }} onPointerDown={(event) => startAnnotationDrag(event, item, "move")} onClick={() => setSelectedAnnotationId(item.id)} title={`${label.name} · ${formatClock(item.start, true)}–${formatClock(item.end, true)} · drag to move${track.id === "windowed" ? " or move down to convert" : ""}`}>
                      {geometry === "interval" && <button className="resize-handle start" aria-label="Resize start" onPointerDown={(event) => startAnnotationDrag(event, item, "start")} />}
                      <strong>{label.short}</strong><span>{(item.end - item.start).toFixed(1)}s</span>
                      {geometry === "interval" && <button className="resize-handle end" aria-label="Resize end" onPointerDown={(event) => startAnnotationDrag(event, item, "end")} />}
                    </div>;
                  })}
                </div>
                {track.id === "context" && <button className="context-resize-handle" aria-label="Resize context track" title="Drag to resize the context track" onPointerDown={(event) => {
                  event.preventDefault();
                  contextResizeRef.current = { startY: event.clientY, startHeight: contextTrackHeight };
                }} />}
              </div>)}
            </div>
          </div>

          <footer className="command-strip">
            <div className="cursor-readout"><span className="crosshair-mini">⌖</span><strong>{formatClock(cursorTime, true)}</strong><span>{display.labels[focusedChannel] ?? "—"}</span><span>{formatAmplitude(cursorAmplitude)}</span><span>sample {Math.round(cursorTime * (display.sampleRates[focusedChannel] ?? primarySampleRate(meta))).toLocaleString()}</span></div>
            <div className="command-status"><span className="status-dot" />{toast}</div>
            <div className="strip-actions"><button onClick={undo}>U <span>Undo</span></button><button onClick={redo}>⇧U <span>Redo</span></button><button onClick={() => setSpectrogramOpen((value) => !value)} className={spectrogramOpen ? "active" : ""}>W <span>Spectrum</span></button><button onClick={() => setShowShortcuts(true)}>? <span>Controls</span></button><label>Snap <select value={snapMode} onChange={(event) => setSnapMode(event.target.value as "1s" | "100ms" | "sample")}><option value="1s">1 s</option><option value="100ms">100 ms</option><option value="sample">Sample</option></select></label></div>
          </footer>
        </section>

        <aside className="right-sidebar">
          <div className="right-tabs"><button className={rightTab === "labels" ? "active" : ""} onClick={() => setRightTab("labels")}>Labels</button><button className={rightTab === "qc" ? "active" : ""} onClick={() => setRightTab("qc")}>QC <span>{qcIssues.length}</span></button></div>
          {rightTab === "labels" ? <>
            <section className="context-palette-section">
              <div className="palette-heading"><div><strong>Context palette</strong><span>Clinical facts that may coexist</span></div></div>
              <input className="palette-search" placeholder="Search ontology…" value={paletteSearch} onChange={(event) => setPaletteSearch(event.target.value)} />
              <div className="context-palette-groups">
                {[{ name: "Entire-session context", labels: entireSessionContexts }, { name: "Window context", labels: windowContexts }].map((group) => group.labels.length ? <div className="context-palette-group" key={group.name}>
                  <span>{group.name}</span>
                  <div>{group.labels.map((label) => <button key={label.id} className="context-chip" draggable onDragStart={(event) => {
                    event.dataTransfer.setData("application/x-neurotrace-label", label.id);
                    event.dataTransfer.effectAllowed = "copy";
                    setDragGhost({ labelId: label.id, time: cursorTime });
                  }} onDragEnd={() => setDragGhost(null)} onClick={() => placePaletteLabel(label)} style={{ "--label-color": label.color } as React.CSSProperties} title={`${label.geometry === "session" ? "Applies to the entire recording" : "Place as clinical context"} · drag or click`}>
                    <span className="context-glyph">{label.geometry === "session" ? "▰" : label.geometry === "point" ? "◆" : "↔"}</span>
                    <span className="context-copy"><strong>{label.name}</strong><small>{label.geometry === "session" ? "Full recording" : label.geometry === "point" ? "Single clinical moment" : "Timed context"}</small></span>
                  </button>)}</div>
                </div> : null)}
              </div>
            </section>
            <section className="palette-section label-palette-section">
              <div className="palette-heading"><div><strong>Label palette</strong><span>Model targets and signal labels</span></div></div>
              <div className="palette-groups">
                {activeLabelGroups.map((category) => {
                  const group = filteredLabels.filter((label) => label.category === category);
                  if (!group.length) return null;
                  return <div className="palette-group" key={category}><span>{category}</span><div>{group.map((label) => <button key={label.id} draggable onDragStart={(event) => { event.dataTransfer.setData("application/x-neurotrace-label", label.id); event.dataTransfer.effectAllowed = "copy"; setDragGhost({ labelId: label.id, time: cursorTime }); }} onDragEnd={() => setDragGhost(null)} onClick={() => placePaletteLabel(label)} style={{ "--label-color": label.color } as React.CSSProperties} title={`Drag to waveform${label.shortcut ? ` · shortcut ${label.shortcut}` : ""}`}><i />{label.name}{label.shortcut && <kbd>{label.shortcut}</kbd>}</button>)}</div></div>;
                })}
              </div>
            </section>
            <section className="inspector-section">
              <div className="inspector-heading"><strong>{selectedAnnotation ? "Annotation inspector" : "Selection inspector"}</strong>{selectedAnnotation && <span className={`revision-state ${selectedAnnotation.status}`}>{selectedAnnotation.status}</span>}</div>
              {selectedAnnotation ? <div className="inspector-form">
                <div className="selected-label" style={{ "--label-color": LABEL_BY_ID.get(selectedAnnotation.labelId)?.color } as React.CSSProperties}><i /><div><strong>{LABEL_BY_ID.get(selectedAnnotation.labelId)?.name}</strong><span>{selectedGeometry} label · {selectedAnnotation.track} track · revision {selectedAnnotation.revision}</span></div></div>
                <div className="time-fields"><label><span>Start (s)</span><input type="number" step="0.001" value={selectedAnnotation.start} disabled={selectedGeometry === "session"} onChange={(event) => updateAnnotation(selectedAnnotation.id, { start: clamp(Number(event.target.value), 0, selectedGeometry === "interval" ? selectedAnnotation.end : meta.durationSec) })} /></label><label><span>End (s)</span><input type="number" step="0.001" value={selectedAnnotation.end} disabled={selectedGeometry !== "interval"} onChange={(event) => updateAnnotation(selectedAnnotation.id, { end: clamp(Number(event.target.value), selectedAnnotation.start, meta.durationSec) })} /></label></div>
                <div className="duration-line"><span>{formatClock(selectedAnnotation.start, true)}</span><i /><span>{(selectedAnnotation.end - selectedAnnotation.start).toFixed(3)} s</span></div>
                <label className="form-field"><span>Reviewer</span><input value={selectedAnnotation.reviewer} onChange={(event) => updateAnnotation(selectedAnnotation.id, { reviewer: event.target.value })} /></label>
                <label className="confidence-field"><span>Confidence <strong>{selectedAnnotation.confidence}%</strong></span><input type="range" min="0" max="100" value={selectedAnnotation.confidence} onChange={(event) => updateAnnotation(selectedAnnotation.id, { confidence: Number(event.target.value) }, false)} /></label>
                <label className="form-field"><span>Clinical / review note</span><textarea rows={3} placeholder="Evidence, uncertainty, or rationale…" value={selectedAnnotation.notes} onChange={(event) => updateAnnotation(selectedAnnotation.id, { notes: event.target.value }, false)} /></label>
                <div className="inspector-actions"><button className="button primary" onClick={() => commitSelected()}>{selectedAnnotation.status === "committed" ? "Save revision" : "Commit label"}</button><button className="icon-danger" onClick={() => deleteAnnotation(selectedAnnotation.id)} title="Delete annotation" aria-label="Delete annotation">🗑</button></div>
                <div className="snapshot-note"><span>DISPLAY SNAPSHOT</span><strong>{montage === "bipolar" ? "Bipolar" : montage === "average" ? "Average ref" : "Recorded ref"} · {filters.enabled ? `${filters.highPassHz}–${filters.lowPassHz} Hz · ${filters.notchHz} Hz notch` : "Raw"}</strong><small>Stored with exported revision; raw samples unchanged.</small></div>
              </div> : <div className="selection-empty">
                <div className="selection-graphic"><span /><span /></div>
                <strong>{selection ? `${(selection.end - selection.start).toFixed(1)} second selection` : "Select or place a label"}</strong>
                <p>Drag a label onto the waveform, paint an interval, or click any timeline item to inspect it.</p>
              </div>}
            </section>
          </> : <QcPanel issues={qcIssues} annotations={annotations} badChannels={badChannels} meta={meta} recoveryStatus={recoveryStatus} onSelect={(id) => { setSelectedAnnotationId(id); setRightTab("labels"); }} />}
        </aside>
      </div>

      {showImport && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !importBusy) setShowImport(false); }}>
        <div className="modal import-modal">
          <button className="modal-close" onClick={() => setShowImport(false)} aria-label="Close">×</button>
          <span className="modal-eyebrow">OPEN A RECORDING</span>
          <h2>Bring the signal to the labels.</h2>
          <p>EDF/EDF+ streams by time window. Self-contained MATLAB v5 matrices are mapped locally. Legacy Buzcode sessions can pair a MAT with its same-basename DAT.</p>
          <button className={`drop-zone ${importBusy ? "busy" : ""}`} onClick={() => fileInputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); importFiles([...event.dataTransfer.files]); }}>
            <span className="upload-mark">⇧</span><strong>{importBusy ? "Reading headers…" : "Drop EDF, MAT, or MAT + DAT"}</strong><small>or choose files · recordings never leave this browser</small>
          </button>
          <input ref={fileInputRef} hidden type="file" multiple accept=".edf,.mat,.dat" onChange={(event: ChangeEvent<HTMLInputElement>) => importFiles([...(event.target.files ?? [])])} />
          {pendingDat && <div className="dat-mapper">
            <div><span className="file-type">DAT</span><div><strong>{pendingDat.name}</strong><small>Signed int16 · little-endian</small></div></div>
            <p>{pendingLegacyMeta ? `Companion MAT metadata found ${pendingLegacyMeta.channelLabels.length || pendingLegacyMeta.channelCount || 0} channels and ${pendingLegacyMeta.events.length} timestamped events. Every timing and scale value remains unverified until you confirm it here.` : "Enter and confirm the raw binary layout. Zero means the timing/channel mapping is still unknown; the recording cannot open until those fields are verified."}</p>
            <div className="mapper-fields"><label><span>Sample rate</span><input type="number" value={datMapping.sampleRate} onChange={(event) => setDatMapping((current) => ({ ...current, sampleRate: Number(event.target.value) }))} /><small>Hz</small></label><label><span>Channels</span><input type="number" value={datMapping.channelCount} onChange={(event) => setDatMapping((current) => ({ ...current, channelCount: Number(event.target.value) }))} /></label><label><span>Scale</span><input type="number" step="0.001" value={datMapping.physicalScale} onChange={(event) => setDatMapping((current) => ({ ...current, physicalScale: Number(event.target.value) }))} /><small>µV/count</small></label></div>
            <button className="button primary wide" disabled={!(datMapping.sampleRate > 0) || !(datMapping.channelCount > 0) || !Number.isFinite(datMapping.physicalScale)} onClick={confirmDatImport}>Confirm mapping &amp; open DAT</button>
          </div>}
          <div className="format-cards"><div><strong>EDF / EDF+</strong><span>Calibrated signals, channel metadata, full recording timeline</span></div><div><strong>MAT v5</strong><span>Automatic largest-matrix detection with sampling-rate discovery</span></div><div><strong>MAT + DAT</strong><span>Manual binary confirmation for legacy Buzcode sessions</span></div></div>
          <div className="research-notice"><span>✦</span><p><strong>Research annotation workspace.</strong> Not for diagnosis or autonomous clinical decision-making. Hospital deployment still requires institutional privacy, security, and validation review.</p></div>
        </div>
      </div>}

      {confirmCommit.length > 0 && <div className="modal-backdrop"><div className="modal confirm-modal"><span className="warning-mark">!</span><h2>Review before committing</h2><p>The label is valid, but the QC engine found an advisory:</p><ul>{confirmCommit.map((warning) => <li key={warning}>{warning}</li>)}</ul><div className="modal-actions"><button className="button secondary" onClick={() => setConfirmCommit([])}>Return to label</button><button className="button primary" onClick={() => commitSelected(true)}>Commit with advisory</button></div></div></div>}

      {showShortcuts && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowShortcuts(false); }}><div className="modal shortcuts-modal"><button className="modal-close" onClick={() => setShowShortcuts(false)} aria-label="Close controls">×</button><span className="modal-eyebrow">CONTROLS &amp; HOTKEYS</span><h2>Move through EEG at signal speed.</h2><p className="controls-intro">Click the recording to pin a time. Drag the recording to select a span. Drag annotations to move, resize, or convert between windowed and instance geometry.</p><div className="shortcut-grid">{[["Ctrl/⌘ + / −", "Zoom only the visible EEG window"], ["Wheel / trackpad", "Move left or right in time"], ["Pinch / Ctrl-wheel", "Zoom around the pointer without page zoom"], ["Click waveform", "Pin the time cursor for one-click labeling"], ["Drag waveform", "Select a time span"], ["Drag between tracks", "Convert windowed ↔ instance"], ["← / →", "Pan 1 second"], ["⇧ ← / →", "Pan 10 seconds"], ["PgUp / PgDn", "Previous / next page"], ["Delete / ⌫", "Remove the selected label"], ["1–9", "Apply a numbered palette label"], ["S / Enter / Space", "Commit the selected label"], ["U / ⇧U", "Undo / redo"], ["N / P", "Next / previous candidate"], ["K", "Skip the current candidate"], ["I / O", "Ictal onset / offset"], ["B", "Toggle focused source-channel quality"], ["Panel buttons", "Show or hide either side panel"], ["Esc", "Unselect and release the pinned cursor"]].map(([key, action]) => <div key={key}><kbd>{key}</kbd><span>{action}</span></div>)}</div></div></div>}

      {showSessionMap && <SessionMap
        meta={meta}
        annotations={annotations}
        candidates={candidates}
        onClose={() => setShowSessionMap(false)}
        onOpenAnnotation={(item) => {
          setSelectedAnnotationId(item.id);
          jumpTo(item.start);
          setRightTab("labels");
          setShowSessionMap(false);
        }}
        onOpenCandidate={(candidate) => {
          const index = candidates.findIndex((item) => item.id === candidate.id);
          if (index >= 0) selectCandidate(index);
          setShowSessionMap(false);
        }}
      />}
    </main>
  );
}

function SpectrogramPanel({ data, sampleRate, start, cursor, label }: { data?: Float32Array; sampleRate: number; start: number; cursor: number; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas || !data?.length || !sampleRate) return;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const width = rect.width;
      const height = rect.height;
      ctx.fillStyle = "#071216"; ctx.fillRect(0, 0, width, height);
      const windowSize = Math.min(256, 2 ** Math.floor(Math.log2(Math.max(32, sampleRate))));
      const frames = Math.min(90, Math.max(12, Math.floor((data.length - windowSize) / Math.max(1, windowSize / 4))));
      const hop = Math.max(1, Math.floor((data.length - windowSize) / Math.max(1, frames - 1)));
      const maxHz = Math.min(150, sampleRate / 2);
      const bins = 56;
      const powers: number[][] = Array.from({ length: bins }, () => Array(frames).fill(0));
      for (let frame = 0; frame < frames; frame += 1) {
        const offset = frame * hop;
        for (let bin = 0; bin < bins; bin += 1) {
          const frequency = Math.exp(Math.log(1) + (bin / (bins - 1)) * Math.log(Math.max(1.01, maxHz)));
          let re = 0; let im = 0;
          for (let sample = 0; sample < windowSize; sample += 1) {
            const value = data[offset + sample] ?? 0;
            const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * sample) / Math.max(1, windowSize - 1));
            const angle = (2 * Math.PI * frequency * sample) / sampleRate;
            re += value * hann * Math.cos(angle);
            im -= value * hann * Math.sin(angle);
          }
          powers[bin][frame] = Math.log10(re * re + im * im + 1e-9);
        }
      }
      const flat = powers.flat().sort((a, b) => a - b);
      const low = flat[Math.floor(flat.length * 0.08)] ?? 0;
      const high = flat[Math.floor(flat.length * 0.97)] ?? low + 1;
      for (let bin = 0; bin < bins; bin += 1) for (let frame = 0; frame < frames; frame += 1) {
        const value = clamp((powers[bin][frame] - low) / Math.max(1e-6, high - low), 0, 1);
        const hue = 220 - value * 170;
        ctx.fillStyle = `hsl(${hue} 76% ${18 + value * 48}%)`;
        const x = (frame / frames) * width;
        const y = height - ((bin + 1) / bins) * height;
        ctx.fillRect(x, y, width / frames + 1, height / bins + 1);
      }
      ctx.strokeStyle = "rgba(255,255,255,.28)";
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillStyle = "rgba(235,245,243,.72)";
      ctx.textAlign = "left";
      [1, 10, 30, 70, 150].filter((hz) => hz <= maxHz).forEach((hz) => {
        const normalized = Math.log(hz) / Math.log(Math.max(1.01, maxHz));
        const y = height - normalized * height;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); ctx.fillText(`${hz} Hz`, 5, y - 2);
      });
    };
    draw();
    const observer = new ResizeObserver(draw); observer.observe(canvas); return () => observer.disconnect();
  }, [data, sampleRate]);
  const duration = data?.length && sampleRate ? data.length / sampleRate : 1;
  const cursorLeft = clamp(((cursor - start) / duration) * 100, 0, 100);
  return <div className="spectrogram-panel"><div className="spectrogram-label"><strong>{label}</strong><span>1–{Math.min(150, Math.floor(sampleRate / 2))} Hz · log power · display only</span></div><div className="spectrogram-canvas-shell"><canvas ref={ref} /><i className="spectrogram-cursor" style={{ left: `${cursorLeft}%` }} /></div></div>;
}

function QcPanel({ issues, annotations, badChannels, meta, recoveryStatus, onSelect }: { issues: Array<{ level: "warning" | "info"; text: string; annotationId?: string }>; annotations: Annotation[]; badChannels: Set<number>; meta: RecordingMeta; recoveryStatus: "saved" | "error"; onSelect: (id: string) => void }) {
  const committed = annotations.filter((item) => item.status === "committed").length;
  const drafts = annotations.filter((item) => item.status === "draft").length;
  const warningCount = issues.filter((item) => item.level === "warning").length;
  const score = Math.max(0, 100 - warningCount * 8);
  return <div className="qc-panel">
    <section className="qc-score"><div className="score-ring"><strong>{score}</strong><span>QC</span></div><div><strong>Export readiness</strong><span>{warningCount ? `${warningCount} warning${warningCount === 1 ? "" : "s"} need review` : "All integrity checks passed"}</span></div></section>
    <section className="qc-metrics"><div><strong>{committed}</strong><span>Committed</span></div><div><strong>{drafts}</strong><span>Drafts</span></div><div><strong>{badChannels.size}</strong><span>Bad ch</span></div></section>
    <section className="qc-checks"><div className="qc-heading"><strong>Checks</strong><span>{issues.length} findings</span></div>{issues.length ? issues.map((issue, index) => <button key={`${issue.text}-${index}`} onClick={() => issue.annotationId && onSelect(issue.annotationId)}><i className={issue.level} /><div><strong>{issue.level === "warning" ? "Advisory" : "Review note"}</strong><span>{issue.text}</span></div><b>›</b></button>) : <div className="qc-clean"><span>✓</span><strong>No integrity conflicts</strong><p>Bounds, provenance, sleep exclusivity, and duplicate checks passed.</p></div>}</section>
    <section className="file-qc"><div className="qc-heading"><strong>Source integrity</strong><span>{meta.format}</span></div><ul>{meta.warnings.length ? meta.warnings.map((warning) => <li key={warning} className="source-warning"><span>!</span>{warning}</li>) : <li><span>✓</span> No parser assumptions reported</li>}<li><span>✓</span> {meta.channelLabels.length} named channels retained</li><li><span>✓</span> Raw source remains immutable</li>{recoveryStatus === "saved" ? <li><span>✓</span> Local project recovery saved</li> : <li className="source-warning"><span>!</span>Local recovery unavailable; export now</li>}</ul></section>
  </div>;
}

function SessionMap({
  meta,
  annotations,
  candidates,
  onClose,
  onOpenAnnotation,
  onOpenCandidate,
}: {
  meta: RecordingMeta;
  annotations: Annotation[];
  candidates: Candidate[];
  onClose: () => void;
  onOpenAnnotation: (annotation: Annotation) => void;
  onOpenCandidate: (candidate: Candidate) => void;
}) {
  const [hovered, setHovered] = useState<{ kind: "annotation"; item: Annotation } | { kind: "candidate"; item: Candidate } | null>(null);
  const [selected, setSelected] = useState<{ kind: "annotation"; item: Annotation } | { kind: "candidate"; item: Candidate } | null>(null);
  const inspected = hovered ?? selected;
  const rows: Array<{ id: string; label: string; matches: (annotation: Annotation) => boolean }> = [
    { id: "session", label: "Entire-session context", matches: (item) => item.track === "context" && annotationGeometry(item) === "session" },
    { id: "context", label: "Window context", matches: (item) => item.track === "context" && annotationGeometry(item) !== "session" },
    { id: "windowed", label: "Windowed labels", matches: (item) => item.track === "windowed" },
    { id: "instance", label: "Instance labels", matches: (item) => item.track === "instance" },
  ];
  return <div className="modal-backdrop map-backdrop"><div className="session-map-modal">
    <header><div><span className="modal-eyebrow">MODEL-READY SESSION MAP</span><h2>{patientLabel(meta)} <i>/</i> {recordingLabel(meta)}</h2><p>{meta.channelLabels.length} channels · {formatClock(meta.durationSec)} · {primarySampleRate(meta)} Hz</p></div><button onClick={onClose} aria-label="Close session map">×</button></header>
    <div className="map-equation"><span>entire-session context</span><b>＋</b><span>window context</span><b>＋</b><span>windowed labels</span><b>＋</b><span>instance labels</span><b>→</b><strong>training data</strong></div>
    <div className={`map-inspection ${inspected ? "active" : ""}`}>
      {inspected?.kind === "annotation" ? <>
        <i style={{ background: LABEL_BY_ID.get(inspected.item.labelId)?.color }} />
        <div><strong>{LABEL_BY_ID.get(inspected.item.labelId)?.name ?? inspected.item.labelId}</strong><span>{annotationGeometry(inspected.item) === "point" ? formatClock(inspected.item.start, true) : `${formatClock(inspected.item.start, true)} → ${formatClock(inspected.item.end, true)}`} · {inspected.item.status} · {inspected.item.reviewer || "reviewer unset"}</span></div>
        <button onClick={() => onOpenAnnotation(inspected.item)}>Open in viewer</button>
      </> : inspected?.kind === "candidate" ? <>
        <i className="candidate-mark" />
        <div><strong>{inspected.item.label}</strong><span>{formatClock(inspected.item.time, true)} · suggested instance · {inspected.item.status}</span></div>
        <button onClick={() => onOpenCandidate(inspected.item)}>Review candidate</button>
      </> : <><div><strong>Explore the map</strong><span>Hover for details. Click an item to keep its details here.</span></div></>}
    </div>
    <div className="map-timeline">
      <div className="map-ruler">{[0, .25, .5, .75, 1].map((fraction) => <span key={fraction} style={{ left: `${fraction * 100}%` }}>{formatClock(meta.durationSec * fraction)}</span>)}</div>
      {rows.map((row) => {
        const rowAnnotations = annotations.filter(row.matches);
        const laneLayout = assignAnnotationLanes(rowAnnotations);
        const annotationLaneCount = Math.min(8, laneLayout.laneCount);
        const candidateLaneCount = row.id === "instance" && candidates.length ? Math.min(3, candidates.length) : 0;
        const rowHeight = 12 + (annotationLaneCount + candidateLaneCount) * 29;
        return <div className={`map-row ${row.id}`} key={row.id} style={{ minHeight: rowHeight }}><strong>{row.label}</strong><div style={{ minHeight: rowHeight }}>{rowAnnotations.map((item) => {
          const label = LABEL_BY_ID.get(item.labelId);
          if (!label) return null;
          const point = annotationGeometry(item) === "point";
          const payload = { kind: "annotation" as const, item };
          const lane = Math.min(laneLayout.lanes.get(item.id) ?? 0, annotationLaneCount - 1);
          return <button key={item.id} className={point ? "map-instance" : ""} aria-label={`${label.name} at ${formatClock(item.start, true)}`} title={`${label.name} · ${formatClock(item.start, true)}${point ? "" : `–${formatClock(item.end, true)}`}`} style={{ top: 6 + lane * 29, left: `${(item.start / meta.durationSec) * 100}%`, width: `${point ? .2 : Math.max(.35, ((item.end - item.start) / meta.durationSec) * 100)}%`, background: label.color }} onMouseEnter={() => setHovered(payload)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(payload)} onBlur={() => setHovered(null)} onClick={() => setSelected(payload)}>{point ? "" : label.short}</button>;
        })}{row.id === "instance" && candidates.map((item, index) => {
          const payload = { kind: "candidate" as const, item };
          const lane = annotationLaneCount + (index % Math.max(1, candidateLaneCount));
          return <button key={item.id} className="map-candidate" style={{ top: 6 + lane * 29, left: `${(item.time / meta.durationSec) * 100}%` }} title={`Suggested instance · ${item.label}`} aria-label={`${item.label} suggested at ${formatClock(item.time, true)}`} onMouseEnter={() => setHovered(payload)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(payload)} onBlur={() => setHovered(null)} onClick={() => setSelected(payload)} />;
        })}</div></div>;
      })}
    </div>
    <footer><div className="geometry-legend"><span><i className="duration" />Duration</span><span><i className="point" />Single moment</span><span><i className="suggestion" />Suggested instance</span></div><button className="button primary" onClick={onClose}>Return to review</button></footer>
  </div></div>;
}
