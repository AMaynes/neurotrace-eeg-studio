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
type PlacementIntent = "native" | "instance" | "windowed" | "context-instance" | "context-window";

type LabelDefinition = {
  id: string;
  name: string;
  short: string;
  color: string;
  geometry: Geometry;
  track: TrackId;
  defaultDuration: number;
  category: "Context" | "Seizure" | "Rhythmic / periodic" | "Ictal pathology" | "Sleep stage" | "Other";
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
  uncertainty: number;
};

type ControlBindings = {
  undo: string;
  redo: string;
  commit: string;
  nextCandidate: string;
  previousCandidate: string;
  ictalOnset: string;
  ictalOffset: string;
  toggleBadChannel: string;
};

type SessionTab = {
  id: string;
  title: string;
  hasRecording: boolean;
  recoveryStatus: "saved" | "error";
};

type DisplayWindow = {
  data: Float32Array[];
  labels: string[];
  sampleRates: number[];
  sourceIndices: number[][];
  primarySourceIndices: number[];
  warnings: string[];
};

type SessionWorkspaceSnapshot = {
  hasRecording: boolean;
  source: SignalSource;
  meta: RecordingMeta;
  sessionKey: string;
  recordingType: string;
  reviewer: string;
  viewStart: number;
  timebase: number;
  gain: number;
  montage: MontageMode;
  filters: DisplayFilterSettings;
  selectedChannels: number[];
  badChannels: number[];
  focusedChannel: number;
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  selection: { start: number; end: number } | null;
  cursorTime: number;
  cursorAmplitude: number;
  cursorLocked: boolean;
  snapMode: "1s" | "100ms" | "sample";
  spectrogramOpen: boolean;
  expandedChannels: boolean;
  candidates: Candidate[];
  activeCandidate: number;
  sourceHash: string;
  rawSourceHash: string;
  sourceInterpretation: Record<string, unknown> | null;
  recoveryStatus: "saved" | "error";
  undo: Annotation[][];
  redo: Annotation[][];
};

const LABELS: LabelDefinition[] = [
  { id: "session-context", name: "Entire-session context", short: "SESSION", color: "#8db7f3", geometry: "session", track: "context", defaultDuration: 0, category: "Context" },
  { id: "laterality", name: "Lateralization / locality", short: "LOCALITY", color: "#b99cf7", geometry: "session", track: "context", defaultDuration: 0, category: "Context" },
  { id: "note", name: "Other", short: "OTHER", color: "#8db7f3", geometry: "interval", track: "context", defaultDuration: 5, category: "Context" },
  { id: "medication", name: "Medication", short: "MED", color: "#78d5c8", geometry: "interval", track: "context", defaultDuration: 30, category: "Context" },
  { id: "ictal", name: "Ictal", short: "ICTAL", color: "#ff6b7b", geometry: "interval", track: "windowed", defaultDuration: 12, category: "Seizure", shortcut: "1" },
  { id: "preictal", name: "Pre-ictal", short: "PRE", color: "#f3a85f", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Seizure", shortcut: "2" },
  { id: "postictal", name: "Post-ictal", short: "POST", color: "#d887ef", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Seizure", shortcut: "3" },
  { id: "gpd", name: "GPDs — generalized periodic discharges", short: "GPD", color: "#f3bb5f", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Rhythmic / periodic", shortcut: "4" },
  { id: "lpd", name: "LPDs — lateralized periodic discharges", short: "LPD", color: "#f0a758", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Rhythmic / periodic", shortcut: "5" },
  { id: "bipd", name: "BIPDs — bilateral independent periodic discharges", short: "BIPD", color: "#df9163", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Rhythmic / periodic", shortcut: "6" },
  { id: "grda", name: "GRDA — generalized rhythmic delta activity", short: "GRDA", color: "#e7c765", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Rhythmic / periodic", shortcut: "7" },
  { id: "lrda", name: "LRDA — lateralized rhythmic delta activity", short: "LRDA", color: "#d8b159", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Rhythmic / periodic", shortcut: "8" },
  { id: "gsw", name: "GSW — generalized spike-and-wave / sharp-and-wave", short: "GSW", color: "#f6cf6a", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Rhythmic / periodic", shortcut: "9" },
  { id: "wake", name: "W — Wake", short: "W", color: "#67d7a2", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Sleep stage" },
  { id: "sleep-unspecified", name: "Sleep", short: "SLEEP", color: "#668fc4", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Sleep stage" },
  { id: "n1", name: "N1 sleep", short: "N1", color: "#79c7f5", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Sleep stage" },
  { id: "n2", name: "N2 sleep", short: "N2", color: "#67aef8", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Sleep stage" },
  { id: "n3", name: "N3 sleep", short: "N3", color: "#768eea", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Sleep stage" },
  { id: "rem", name: "REM sleep", short: "REM", color: "#9b83ee", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Sleep stage" },
  { id: "spikes", name: "Spikes", short: "SPIKE", color: "#f6cf6a", geometry: "point", track: "instance", defaultDuration: 0, category: "Ictal pathology" },
  { id: "slowing", name: "Slowing", short: "SLOW", color: "#e6a45c", geometry: "interval", track: "windowed", defaultDuration: 10, category: "Ictal pathology" },
  { id: "suppression", name: "Suppression", short: "SUPPR", color: "#d17a70", geometry: "interval", track: "windowed", defaultDuration: 10, category: "Ictal pathology" },
  { id: "normal", name: "Normal", short: "NORMAL", color: "#69c992", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Other" },
  { id: "abnormal", name: "Abnormal", short: "ABNORMAL", color: "#e58f62", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Other" },
  { id: "artifact", name: "Artifact", short: "ARTIFACT", color: "#a9b2b8", geometry: "interval", track: "windowed", defaultDuration: 8, category: "Other" },
  { id: "uncertain", name: "Unknown", short: "UNKNOWN", color: "#a88cf4", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Other" },
  { id: "clinical", name: "Clinical Observation", short: "OBS", color: "#ff8e96", geometry: "point", track: "context", defaultDuration: 0, category: "Context" },
  { id: "rpp-unspecified", name: "RPP / IIC unspecified", short: "RPP?", color: "#b6a05d", geometry: "interval", track: "windowed", defaultDuration: 30, category: "Rhythmic / periodic", hidden: true },
];

const LABEL_BY_ID = new Map(LABELS.map((label) => [label.id, label]));
const CHANNEL_RAIL_HEADER_HEIGHT = 28;
const PALETTE_BUTTON_NAMES: Record<string, string> = {
  preictal: "Pre",
  ictal: "Ictal",
  postictal: "Post",
  spikes: "Spikes",
  slowing: "Slowing",
  suppression: "Suppression",
  wake: "Wake",
  "sleep-unspecified": "Sleep",
  rem: "REM",
  normal: "Normal",
  abnormal: "Abnormal",
  artifact: "Artifact",
  uncertain: "Unknown",
};

function annotationGeometry(annotation: Pick<Annotation, "geometry" | "labelId">): Geometry {
  const geometry = annotation.geometry ?? LABEL_BY_ID.get(annotation.labelId)?.geometry ?? "point";
  return geometry === "window" ? "interval" : geometry;
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
    return [{
      ...candidate,
      label: candidate.label.trim(),
      uncertainty: Math.round(clamp(Number.isFinite(candidate.uncertainty) ? candidate.uncertainty : 100, 0, 100)),
    }];
  });
}

const DEFAULT_FILTERS: DisplayFilterSettings = {
  highPassHz: 0.5,
  lowPassHz: 70,
  notchHz: 60,
  enabled: true,
};

const DEFAULT_CONTROLS: ControlBindings = {
  undo: "u",
  redo: "u",
  commit: "s",
  nextCandidate: "n",
  previousCandidate: "p",
  ictalOnset: "i",
  ictalOffset: "o",
  toggleBadChannel: "b",
};

const CONTROL_OPTIONS = "abcdefghijklmnopqrstuvwxyz".split("");

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
    return new DemoSource({ name: "blank-session", durationSec: 1, sampleRate: 256 });
  }, []);
  const sourceRef = useRef<SignalSource>(demoSource);
  const sessionSnapshotsRef = useRef<Map<string, SessionWorkspaceSnapshot>>(new Map());
  const activeSessionIdRef = useRef("initial-session");
  const importBusyRef = useRef(false);
  const flushSessionRef = useRef<() => void>(() => {});
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overviewRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const waveDrawRef = useRef<() => void>(() => {});
  const viewerWheelRef = useRef<(event: WheelEvent) => void>(() => {});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const annotationsRef = useRef<Annotation[]>([]);
  const undoRef = useRef<Annotation[][]>([]);
  const redoRef = useRef<Annotation[][]>([]);
  const pointerRef = useRef<{ startX: number; startTime: number; moved: boolean } | null>(null);
  const wheelFrameRef = useRef<number | null>(null);
  const wheelDeltaRef = useRef(0);
  const wheelWidthRef = useRef(1);
  const displayRequestIdRef = useRef(0);
  const displayAppliedRequestIdRef = useRef(0);
  const displayRefreshPendingRef = useRef<(() => Promise<void>) | null>(null);
  const displayRefreshActiveRef = useRef(false);
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
  const [hasRecording, setHasRecording] = useState(false);
  const [sessionTabs, setSessionTabs] = useState<SessionTab[]>([
    { id: "initial-session", title: "Session 1", hasRecording: false, recoveryStatus: "saved" },
  ]);
  const [activeSessionId, setActiveSessionId] = useState("initial-session");
  const [sessionKey, setSessionKey] = useState("blank-initial-session");
  const [recordingType, setRecordingType] = useState("Scalp EEG");
  const [viewStart, setViewStart] = useState(0);
  const [timebase, setTimebase] = useState(20);
  const [gain, setGain] = useState(1);
  const [montage, setMontage] = useState<MontageMode>("referential");
  const [filters, setFilters] = useState<DisplayFilterSettings>(DEFAULT_FILTERS);
  const [selectedChannels, setSelectedChannels] = useState<Set<number>>(() => new Set());
  const [badChannels, setBadChannels] = useState<Set<number>>(() => new Set());
  const [focusedChannel, setFocusedChannel] = useState(0);
  const [display, setDisplay] = useState<DisplayWindow>({ data: [], labels: [], sampleRates: [], sourceIndices: [], primarySourceIndices: [], warnings: [] });
  const [loadingSignal, setLoadingSignal] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationDragPreview, setAnnotationDragPreview] = useState<{ id: string; patch: Pick<Annotation, "start" | "end" | "track" | "geometry"> } | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [cursorTime, setCursorTime] = useState(0);
  const [cursorAmplitude, setCursorAmplitude] = useState(0);
  const [cursorLocked, setCursorLocked] = useState(false);
  const [activeTool, setActiveTool] = useState<"cursor" | "seizure">("cursor");
  const [markOnset, setMarkOnset] = useState<number | null>(null);
  const [snapMode, setSnapMode] = useState<"1s" | "100ms" | "sample">("100ms");
  const [playing, setPlaying] = useState(false);
  const [spectrogramOpen, setSpectrogramOpen] = useState(false);
  const [expandedChannels, setExpandedChannels] = useState(false);
  const [paletteSearch, setPaletteSearch] = useState("");
  const [channelSearch, setChannelSearch] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [activeCandidate, setActiveCandidate] = useState(0);
  const [toast, setToast] = useState("Blank session ready — load a recording");
  const [importBusy, setImportBusy] = useState(false);
  const [dragGhost, setDragGhost] = useState<{ labelId: string; time: number } | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showChannels, setShowChannels] = useState(false);
  const [showSessionMap, setShowSessionMap] = useState(false);
  const [sessionMapTab, setSessionMapTab] = useState<"map" | "qc">("map");
  const [showSessionContextPicker, setShowSessionContextPicker] = useState(false);
  const [showPatientInfo, setShowPatientInfo] = useState(false);
  const [showAnnotationEditor, setShowAnnotationEditor] = useState(false);
  const [queueDetailTarget, setQueueDetailTarget] = useState<{ kind: "annotation" | "candidate"; id: string } | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [bottomTracksOpen, setBottomTracksOpen] = useState(true);
  const [contextTrackHeight, setContextTrackHeight] = useState(76);
  const [pendingDat, setPendingDat] = useState<File | null>(null);
  const [pendingLegacyMatFile, setPendingLegacyMatFile] = useState<File | null>(null);
  const [pendingLegacyMeta, setPendingLegacyMeta] = useState<LegacyMatMetadata | null>(null);
  const [datMapping, setDatMapping] = useState({ sampleRate: 0, channelCount: 0, physicalScale: 1 });
  const [confirmCommit, setConfirmCommit] = useState<string[]>([]);
  const [reviewer, setReviewer] = useState("");
  const [sourceHash, setSourceHash] = useState("");
  const [rawSourceHash, setRawSourceHash] = useState("");
  const [sourceInterpretation, setSourceInterpretation] = useState<Record<string, unknown> | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<"saved" | "error">("saved");
  const [controlBindings, setControlBindings] = useState<ControlBindings>(DEFAULT_CONTROLS);

  const selectedAnnotation = annotations.find((item) => item.id === selectedAnnotationId) ?? null;
  const selectedGeometry = selectedAnnotation ? annotationGeometry(selectedAnnotation) : null;
  const instanceQueueEntries = useMemo(() => {
    const linkedCandidateIds = new Set(annotations.flatMap((item) => item.candidateId ? [item.candidateId] : []));
    const annotationEntries = annotations
      .filter((item) => item.track === "instance" || (item.track === "context" && annotationGeometry(item) !== "session"))
      .map((item) => ({
        kind: "annotation" as const,
        id: item.id,
        time: item.start,
        label: LABEL_BY_ID.get(item.labelId)?.name ?? item.labelId,
        detail: item.track === "context" ? "Context event" : "Instance label",
        status: item.status,
        uncertainty: Math.round(clamp(100 - item.confidence, 0, 100)),
      }));
    const candidateEntries = candidates
      .filter((item) => !linkedCandidateIds.has(item.id))
      .map((item) => ({
        kind: "candidate" as const,
        id: item.id,
        time: item.time,
        label: item.label,
        detail: "File event",
        status: item.status,
        uncertainty: item.uncertainty,
      }));
    return [...annotationEntries, ...candidateEntries].sort((a, b) => a.time - b.time || a.label.localeCompare(b.label));
  }, [annotations, candidates]);
  const activeQueueIndex = useMemo(() => {
    const selectedIndex = selectedAnnotationId
      ? instanceQueueEntries.findIndex((item) => item.kind === "annotation" && item.id === selectedAnnotationId)
      : -1;
    if (selectedIndex >= 0) return selectedIndex;
    const candidate = candidates[activeCandidate];
    const candidateIndex = candidate
      ? instanceQueueEntries.findIndex((item) => item.kind === "candidate" && item.id === candidate.id)
      : -1;
    return candidateIndex >= 0 ? candidateIndex : instanceQueueEntries.length ? 0 : -1;
  }, [activeCandidate, candidates, instanceQueueEntries, selectedAnnotationId]);
  const queueDetailEntry = queueDetailTarget
    ? instanceQueueEntries.find((item) => item.kind === queueDetailTarget.kind && item.id === queueDetailTarget.id) ?? null
    : null;
  const queueDetailAnnotation = queueDetailTarget?.kind === "annotation"
    ? annotations.find((item) => item.id === queueDetailTarget.id) ?? null
    : null;
  const queueDetailCandidate = queueDetailTarget?.kind === "candidate"
    ? candidates.find((item) => item.id === queueDetailTarget.id) ?? null
    : null;
  const queueDetailLabel = queueDetailAnnotation ? LABEL_BY_ID.get(queueDetailAnnotation.labelId) : null;
  const sourceHashDisplay = sourceHash.startsWith("demo:")
    ? sourceHash
    : `${sourceHash.slice(0, 8)}…${sourceHash.slice(-4)}`;

  useLayoutEffect(() => {
    annotationsRef.current = annotations;
  }, [annotations]);

  useLayoutEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    try {
      const savedReviewer = localStorage.getItem("neurotrace:reviewer");
      const savedControls = localStorage.getItem("neurotrace:controls");
      // Local reviewer identity is external persisted state and is restored once after hydration.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (savedReviewer) setReviewer(savedReviewer);
      if (savedControls) {
        const parsed = JSON.parse(savedControls) as Partial<ControlBindings>;
        setControlBindings({
          ...DEFAULT_CONTROLS,
          ...Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string" && /^[a-z]$/i.test(value as string))),
        });
      }
    } catch { /* local preferences are optional */ }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("neurotrace:reviewer", reviewer);
      localStorage.setItem("neurotrace:controls", JSON.stringify(controlBindings));
    } catch { /* local preferences are optional */ }
  }, [controlBindings, reviewer]);

  const storeActiveSession = useCallback(() => {
    const snapshot: SessionWorkspaceSnapshot = {
      hasRecording,
      source: sourceRef.current,
      meta,
      sessionKey,
      recordingType,
      reviewer,
      viewStart,
      timebase,
      gain,
      montage,
      filters: { ...filters },
      selectedChannels: [...selectedChannels],
      badChannels: [...badChannels],
      focusedChannel,
      annotations,
      selectedAnnotationId,
      selection,
      cursorTime,
      cursorAmplitude,
      cursorLocked,
      snapMode,
      spectrogramOpen,
      expandedChannels,
      candidates,
      activeCandidate,
      sourceHash,
      rawSourceHash,
      sourceInterpretation,
      recoveryStatus,
      undo: undoRef.current,
      redo: redoRef.current,
    };
    if (snapshot.hasRecording) {
      try {
        localStorage.setItem(`neurotrace:draft:${snapshot.sessionKey}`, JSON.stringify(snapshot.annotations));
        localStorage.setItem(`neurotrace:project:${snapshot.sessionKey}`, JSON.stringify({
          version: 2,
          annotations: snapshot.annotations,
          candidates: snapshot.candidates,
          activeCandidate: snapshot.activeCandidate,
          badChannels: snapshot.badChannels,
          reviewer: snapshot.reviewer,
          recordingType: snapshot.recordingType,
          savedAt: new Date().toISOString(),
        }));
        snapshot.recoveryStatus = "saved";
      } catch {
        snapshot.recoveryStatus = "error";
      }
    }
    sessionSnapshotsRef.current.set(activeSessionId, snapshot);
    setSessionTabs((current) => current.map((tab) => tab.id === activeSessionId
      ? { ...tab, hasRecording: snapshot.hasRecording, recoveryStatus: snapshot.recoveryStatus }
      : tab));
  }, [activeCandidate, activeSessionId, annotations, badChannels, candidates, cursorAmplitude, cursorLocked, cursorTime, expandedChannels, filters, focusedChannel, gain, hasRecording, meta, montage, rawSourceHash, recordingType, recoveryStatus, reviewer, selectedAnnotationId, selectedChannels, selection, sessionKey, snapMode, sourceHash, sourceInterpretation, spectrogramOpen, timebase, viewStart]);

  useLayoutEffect(() => {
    flushSessionRef.current = storeActiveSession;
  }, [storeActiveSession]);

  useEffect(() => {
    const flush = () => flushSessionRef.current();
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  const applySessionSnapshot = useCallback((snapshot: SessionWorkspaceSnapshot) => {
    if (wheelFrameRef.current !== null) window.cancelAnimationFrame(wheelFrameRef.current);
    if (cursorFrameRef.current !== null) window.cancelAnimationFrame(cursorFrameRef.current);
    if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
    wheelFrameRef.current = null;
    cursorFrameRef.current = null;
    dragFrameRef.current = null;
    wheelDeltaRef.current = 0;
    pointerRef.current = null;
    pendingCursorRef.current = null;
    contextResizeRef.current = null;
    sourceRef.current = snapshot.source;
    setHasRecording(snapshot.hasRecording);
    setMeta(snapshot.meta);
    setSessionKey(snapshot.sessionKey);
    setRecordingType(snapshot.recordingType);
    setReviewer(snapshot.reviewer);
    setViewStart(snapshot.viewStart);
    setTimebase(snapshot.timebase);
    setGain(snapshot.gain);
    setMontage(snapshot.montage);
    setFilters({ ...snapshot.filters });
    setSelectedChannels(new Set(snapshot.selectedChannels));
    setBadChannels(new Set(snapshot.badChannels));
    setFocusedChannel(snapshot.focusedChannel);
    setDisplay({ data: [], labels: [], sampleRates: [], sourceIndices: [], primarySourceIndices: [], warnings: [] });
    setAnnotations(snapshot.annotations);
    setSelectedAnnotationId(snapshot.selectedAnnotationId);
    setSelection(snapshot.selection);
    setCursorTime(snapshot.cursorTime);
    setCursorAmplitude(snapshot.cursorAmplitude);
    setCursorLocked(snapshot.cursorLocked);
    setSnapMode(snapshot.snapMode);
    setSpectrogramOpen(snapshot.spectrogramOpen);
    setExpandedChannels(snapshot.expandedChannels ?? false);
    setCandidates(snapshot.candidates);
    setActiveCandidate(snapshot.activeCandidate);
    setSourceHash(snapshot.sourceHash);
    setRawSourceHash(snapshot.rawSourceHash);
    setSourceInterpretation(snapshot.sourceInterpretation);
    setRecoveryStatus(snapshot.recoveryStatus);
    setPlaying(false);
    setMarkOnset(null);
    setActiveTool("cursor");
    setDragGhost(null);
    setAnnotationDragPreview(null);
    dragAnnotationRef.current = null;
    pendingAnnotationDragRef.current = null;
    setPendingDat(null);
    setPendingLegacyMatFile(null);
    setPendingLegacyMeta(null);
    setDatMapping({ sampleRate: 0, channelCount: 0, physicalScale: 1 });
    setShowImport(false);
    setShowFilters(false);
    setConfirmCommit([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    undoRef.current = snapshot.undo;
    redoRef.current = snapshot.redo;
  }, []);

  const switchSession = useCallback((id: string) => {
    if (importBusy || id === activeSessionId) return;
    storeActiveSession();
    const snapshot = sessionSnapshotsRef.current.get(id);
    if (!snapshot) return;
    setActiveSessionId(id);
    applySessionSnapshot(snapshot);
    setToast(snapshot.hasRecording ? "Session restored" : "Blank session ready — load a recording");
  }, [activeSessionId, applySessionSnapshot, importBusy, storeActiveSession]);

  const createBlankSession = useCallback(() => {
    if (importBusy) return;
    storeActiveSession();
    const id = makeId("session");
    const nextNumber = sessionTabs.length + 1;
    const snapshot: SessionWorkspaceSnapshot = {
      hasRecording: false,
      source: demoSource,
      meta: sourceMeta(demoSource),
      sessionKey: `blank-${id}`,
      recordingType: "Scalp EEG",
      reviewer,
      viewStart: 0,
      timebase: 20,
      gain: 1,
      montage: "referential",
      filters: { ...DEFAULT_FILTERS },
      selectedChannels: [],
      badChannels: [],
      focusedChannel: 0,
      annotations: [],
      selectedAnnotationId: null,
      selection: null,
      cursorTime: 0,
      cursorAmplitude: 0,
      cursorLocked: false,
      snapMode: "100ms",
      spectrogramOpen: false,
      expandedChannels: false,
      candidates: [],
      activeCandidate: 0,
      sourceHash: "",
      rawSourceHash: "",
      sourceInterpretation: null,
      recoveryStatus: "saved",
      undo: [],
      redo: [],
    };
    sessionSnapshotsRef.current.set(id, snapshot);
    setSessionTabs((current) => [...current, { id, title: `Session ${nextNumber}`, hasRecording: false, recoveryStatus: "saved" }]);
    setActiveSessionId(id);
    applySessionSnapshot(snapshot);
    setToast("Blank session ready — load a recording");
  }, [applySessionSnapshot, demoSource, importBusy, reviewer, sessionTabs.length, storeActiveSession]);

  const closeSession = useCallback((id: string) => {
    if (importBusy || sessionTabs.length <= 1) return;
    if (id === activeSessionId) storeActiveSession();
    const closingSnapshot = sessionSnapshotsRef.current.get(id);
    if (closingSnapshot?.hasRecording && closingSnapshot.recoveryStatus === "error") {
      setToast("This session could not be saved locally — export it before closing the tab");
      return;
    }
    const closingIndex = sessionTabs.findIndex((tab) => tab.id === id);
    const remaining = sessionTabs.filter((tab) => tab.id !== id);
    sessionSnapshotsRef.current.delete(id);
    setSessionTabs(remaining);
    if (id !== activeSessionId) {
      setToast("Session tab closed; its local recovery remains available");
      return;
    }
    const target = remaining[Math.min(Math.max(0, closingIndex), remaining.length - 1)];
    const snapshot = target ? sessionSnapshotsRef.current.get(target.id) : undefined;
    if (!target || !snapshot) return;
    setActiveSessionId(target.id);
    applySessionSnapshot(snapshot);
    setToast(snapshot.hasRecording ? "Session restored" : "Blank session ready — load a recording");
  }, [activeSessionId, applySessionSnapshot, importBusy, sessionTabs, storeActiveSession]);

  const updateControlBinding = useCallback((binding: keyof ControlBindings, value: string) => {
    setControlBindings((current) => {
      const next = { ...current };
      const conflict = (Object.entries(current) as Array<[keyof ControlBindings, string]>).find(([key, assigned]) =>
        key !== binding
        && assigned === value
        && !([key, binding].includes("undo") && [key, binding].includes("redo")));
      if (conflict) next[conflict[0]] = current[binding];
      next[binding] = value;
      return next;
    });
  }, []);

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

  const addAnnotation = useCallback((label: LabelDefinition, time: number, explicitEnd?: number, intent: PlacementIntent = "native") => {
    if (!hasRecording) {
      setToast("Load a recording before placing labels");
      return;
    }
    const samplingRate = display.sampleRates[focusedChannel] ?? primarySampleRate(meta);
    const geometry: Geometry = intent === "instance" || intent === "context-instance"
      ? "point"
      : intent === "windowed" || intent === "context-window"
        ? "interval"
        : label.geometry;
    const track: TrackId = intent === "context-instance" || intent === "context-window"
      ? "context"
      : intent === "instance"
        ? "instance"
        : intent === "windowed"
          ? "windowed"
          : label.track;
    let start = clamp(snapTime(Math.min(time, explicitEnd ?? time), snapMode, samplingRate), 0, meta.durationSec);
    let end = geometry === "point" ? start : explicitEnd ?? start + label.defaultDuration;
    end = clamp(snapTime(Math.max(end, start), snapMode, samplingRate), start, meta.durationSec);
    if (geometry === "window") {
      const windowStart = Math.floor(start / 30) * 30;
      end = Math.min(meta.durationSec, windowStart + 30);
      time = windowStart;
    } else if (geometry === "session") {
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
    const candidateMatches = geometry !== "session" && activeSourceCandidate && activeSourceCandidate.status !== "skipped" && activeSourceCandidate.status !== "conflict" && (
      geometry === "point"
        ? Math.abs(activeSourceCandidate.time - start) <= 1
        : explicitEnd !== undefined
          ? activeSourceCandidate.time >= start && activeSourceCandidate.time <= end
          : Math.abs(activeSourceCandidate.time - start) <= 1
    );
    const next = normalizeAnnotationGeometry({
      id: makeId("ann"),
      labelId: label.id,
      start: geometry === "window" || geometry === "session" ? time : start,
      end,
      track,
      geometry,
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
    const sleepOverlapCount = label.category === "Sleep stage" && track === "windowed" && geometry !== "point"
      ? annotationsRef.current.filter((item) => {
        const existing = LABEL_BY_ID.get(item.labelId);
        return existing?.category === "Sleep stage"
          && item.track === "windowed"
          && annotationGeometry(item) !== "point"
          && annotationOverlapsWindow(item, next.start, next.end);
      }).length
      : 0;
    commitMutation((current) => {
      if (!sleepOverlapCount) return [...current, next];
      const adjusted = current.flatMap((item) => {
        const existing = LABEL_BY_ID.get(item.labelId);
        if (existing?.category !== "Sleep stage"
          || item.track !== "windowed"
          || annotationGeometry(item) === "point"
          || !annotationOverlapsWindow(item, next.start, next.end)) return [item];
        const pieces: Annotation[] = [];
        const changedAt = new Date().toISOString();
        if (item.start < next.start) pieces.push(normalizeAnnotationGeometry({
          ...item,
          end: next.start,
          geometry: "interval",
          status: "draft",
          revision: item.revision + 1,
          updatedAt: changedAt,
        }, meta.durationSec));
        if (item.end > next.end) pieces.push(normalizeAnnotationGeometry({
          ...item,
          id: makeId("ann"),
          start: next.end,
          geometry: "interval",
          status: "draft",
          candidateId: undefined,
          revision: item.revision + 1,
          createdAt: changedAt,
          updatedAt: changedAt,
        }, meta.durationSec));
        return pieces;
      });
      return [...adjusted, next];
    });
    setSelectedAnnotationId(next.id);
    setCursorTime(next.start);
    setCursorLocked(true);
    setSelection(null);
    setToast(sleepOverlapCount
      ? `${label.name} applied to the selected window; overlapping sleep stages were trimmed`
      : geometry === "interval" && explicitEnd !== undefined
        ? `${label.name} applied to ${formatClock(next.start, true)}–${formatClock(next.end, true)} — draft`
        : `${label.name} placed at ${formatClock(next.start, true)} — draft`);
  }, [activeCandidate, candidates, commitMutation, display, focusedChannel, hasRecording, meta, montage, reviewer, snapMode]);

  const placePaletteLabel = useCallback((label: LabelDefinition) => {
    if (!hasRecording) {
      setToast("Load a recording before placing labels");
      return;
    }
    if (!cursorLocked && !selection && label.geometry !== "session") {
      setToast("Click the waveform to pin a time, or drag to select a window");
      return;
    }
    const intent: PlacementIntent = label.geometry === "session"
      ? "native"
      : label.category === "Context"
        ? selection
          ? "context-window"
          : "context-instance"
        : selection
          ? "windowed"
          : "instance";
    addAnnotation(label, selection?.start ?? cursorTime, selection?.end, intent);
  }, [addAnnotation, cursorLocked, cursorTime, hasRecording, selection]);

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

  const updateQueueUncertainty = useCallback((kind: "annotation" | "candidate", id: string, value: number) => {
    const uncertainty = Math.round(clamp(Number.isFinite(value) ? value : 0, 0, 100));
    if (kind === "annotation") {
      updateAnnotation(id, { confidence: 100 - uncertainty });
      return;
    }
    setCandidates((items) => items.map((item) => item.id === id ? { ...item, uncertainty } : item));
  }, [updateAnnotation]);

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
        issues.push({ level: "warning", text: "Annotation references a missing source file event", annotationId: item.id });
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
    if (!hasRecording) return;
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
        setSessionTabs((current) => current.map((tab) => tab.id === activeSessionId ? { ...tab, hasRecording: true, recoveryStatus: "saved" } : tab));
      } catch {
        setRecoveryStatus("error");
        setSessionTabs((current) => current.map((tab) => tab.id === activeSessionId ? { ...tab, hasRecording: true, recoveryStatus: "error" } : tab));
        setToast("Local recovery failed — export a bundle before closing this session");
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [activeCandidate, activeSessionId, annotations, badChannels, candidates, hasRecording, recordingType, reviewer, sessionKey]);

  useEffect(() => {
    const requestId = ++displayRequestIdRef.current;
    const source = sourceRef.current;
    const indices = [...selectedChannels].sort((a, b) => a - b);
    const refreshWindow = async () => {
      if (!hasRecording || !indices.length) {
        displayAppliedRequestIdRef.current = requestId;
        setDisplay({ data: [], labels: [], sampleRates: [], sourceIndices: [], primarySourceIndices: [], warnings: [] });
        setLoadingSignal(false);
        return;
      }
      setLoadingSignal(true);
      try {
        const filterPadSec = filters.enabled
          ? Math.min(12, Math.max(2, filters.highPassHz > 0 ? 3 / filters.highPassHz : 2))
          : 0;
        const paddedStart = Math.max(0, viewStart - filterPadSec);
        const paddedEnd = Math.min(meta.durationSec, viewStart + timebase + filterPadSec);
        const windowData = await source.getWindow(paddedStart, Math.max(0, paddedEnd - paddedStart), indices);
        if (sourceRef.current !== source || requestId <= displayAppliedRequestIdRef.current) return;
        const paddedFiltered = applyDisplayFilters(windowData.data, windowData.sampleRates, filters);
        const filtered = paddedFiltered.map((channel, position) => {
          const sampleRate = windowData.sampleRates[position] ?? primarySampleRate(meta);
          const cropStart = clamp(Math.round((viewStart - paddedStart) * sampleRate), 0, channel.length);
          const requestedSamples = Math.max(0, Math.round(timebase * sampleRate));
          return channel.slice(cropStart, Math.min(channel.length, cropStart + requestedSamples));
        });
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
        displayAppliedRequestIdRef.current = requestId;
        setDisplay({ data: montageResult.data, labels: montageResult.labels, sampleRates, sourceIndices, primarySourceIndices, warnings: montageResult.warnings });
        setFocusedChannel((current) => clamp(current, 0, Math.max(0, montageResult.labels.length - 1)));
        setLoadingSignal(false);
      } catch (error) {
        if (sourceRef.current !== source || requestId <= displayAppliedRequestIdRef.current) return;
        displayAppliedRequestIdRef.current = requestId;
        setLoadingSignal(false);
        const message = error instanceof Error ? error.message : "Could not read this signal window";
        setDisplay({ data: [], labels: [], sampleRates: [], sourceIndices: [], primarySourceIndices: [], warnings: [message] });
        setToast(message);
      }
    };
    displayRefreshPendingRef.current = refreshWindow;
    if (!displayRefreshActiveRef.current) {
      displayRefreshActiveRef.current = true;
      const pumpLatestWindow = async () => {
        while (displayRefreshPendingRef.current) {
          const refresh = displayRefreshPendingRef.current;
          displayRefreshPendingRef.current = null;
          await refresh();
        }
        displayRefreshActiveRef.current = false;
      };
      void pumpLatestWindow();
    }
  }, [badChannels, filters, hasRecording, meta, montage, selectedChannels, timebase, viewStart]);

  useEffect(() => {
    if (!hasRecording || !playing) return;
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
  }, [hasRecording, meta.durationSec, playing, setViewStartSafe, timebase, viewStart]);

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
        if (geometry === "session") continue;
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
      const plotTop = CHANNEL_RAIL_HEADER_HEIGHT;
      const plotHeight = Math.max(1, height - plotTop);
      const rowHeight = plotHeight / rows;
      for (let channel = 0; channel < display.data.length; channel += 1) {
        const values = display.data[channel];
        const rowTop = plotTop + rowHeight * channel;
        const center = rowTop + rowHeight * 0.5;
        if (channel === focusedChannel) {
          context.fillStyle = "rgba(87, 223, 183, .065)";
          context.fillRect(0, rowTop, width, rowHeight);
          context.strokeStyle = "rgba(87, 223, 183, .28)";
          context.strokeRect(.5, rowTop + .5, width - 1, Math.max(1, rowHeight - 1));
        }
        context.strokeStyle = "rgba(116,153,162,.11)";
        context.beginPath(); context.moveTo(0, center); context.lineTo(width, center); context.stroke();
        if (!values.length) continue;
        let baselineSum = 0;
        let baselineCount = 0;
        for (const value of values) {
          if (!Number.isFinite(value)) continue;
          baselineSum += value;
          baselineCount += 1;
        }
        const baseline = baselineCount ? baselineSum / baselineCount : 0;
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
            context.moveTo(x, center - (max - baseline) * scale);
            context.lineTo(x, center - (min - baseline) * scale);
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
  }, [annotations, display, focusedChannel, gain, markOnset, timebase, viewStart]);

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
    const rowCount = Math.max(1, display.data.length);
    const plotHeight = Math.max(1, rect.height - CHANNEL_RAIL_HEADER_HEIGHT);
    const row = clamp(Math.floor(clamp((event.clientY - rect.top - CHANNEL_RAIL_HEADER_HEIGHT) / plotHeight, 0, .999999) * rowCount), 0, Math.max(0, display.data.length - 1));
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
    const rowCount = Math.max(1, display.data.length);
    const plotHeight = Math.max(1, rect.height - CHANNEL_RAIL_HEADER_HEIGHT);
    const row = clamp(Math.floor(clamp((event.clientY - rect.top - CHANNEL_RAIL_HEADER_HEIGHT) / plotHeight, 0, .999999) * rowCount), 0, Math.max(0, display.data.length - 1));
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
    } else if (pointer.moved && Math.abs(time - pointer.startTime) > 0) {
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
    const intent: PlacementIntent = label.geometry === "session"
      ? "native"
      : label.category === "Context"
        ? selection
          ? "context-window"
          : "context-instance"
        : selection
          ? "windowed"
          : "instance";
    addAnnotation(label, selection?.start ?? time, selection?.end, intent);
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
          geometry = target === "instance" ? "point" : "interval";
        }
      }
      const duration = geometry === "point"
        ? 0
        : drag.original.track === "instance" && track === "windowed"
          ? Math.min(
            meta.durationSec,
            Math.max(1, Math.min(label?.defaultDuration ?? 5, timebase / 4)),
          )
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
      setContextTrackHeight(clamp(resize.startHeight - (event.clientY - resize.startY), 44, 420));
    };
    const onUp = () => {
      contextResizeRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
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
    const rect = viewer.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const anchor = viewStart + clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1) * timebase;
      zoomTimeWindow(event.deltaY < 0 ? "in" : "out", anchor);
      return;
    }
    const overExpandedChannels = expandedChannels
      && event.target instanceof Element
      && Boolean(event.target.closest(".waveform-wrap.channel-scroll-mode"));
    if (overExpandedChannels && Math.abs(event.deltaY) > Math.abs(event.deltaX) && !event.shiftKey) {
      return;
    }
    event.preventDefault();
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
  }, [expandedChannels, setViewStartSafe, timebase, viewStart, zoomTimeWindow]);

  useLayoutEffect(() => {
    viewerWheelRef.current = onViewerWheel;
  }, [onViewerWheel]);

  useEffect(() => {
    if (!hasRecording) return;
    const viewer = viewerRef.current;
    if (!viewer) return;
    const handleWheel = (event: WheelEvent) => viewerWheelRef.current(event);
    viewer.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    return () => viewer.removeEventListener("wheel", handleWheel, { capture: true });
  }, [hasRecording]);

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

  const selectInstanceQueueEntry = useCallback((index: number) => {
    const entry = instanceQueueEntries[index];
    if (!entry) return;
    if (entry.kind === "candidate") {
      const candidateIndex = candidates.findIndex((item) => item.id === entry.id);
      if (candidateIndex >= 0) selectCandidate(candidateIndex);
      setSelectedAnnotationId(null);
      setToast(`File event: ${entry.label}`);
      return;
    }
    const annotation = annotations.find((item) => item.id === entry.id);
    if (!annotation) return;
    setSelectedAnnotationId(annotation.id);
    setCursorTime(annotation.start);
    setCursorLocked(true);
    jumpTo(annotation.start);
    setToast(`${entry.detail}: ${entry.label}`);
  }, [annotations, candidates, instanceQueueEntries, jumpTo, selectCandidate]);

  const loadSource = useCallback(async (source: SignalSource, file: File, interpretation?: Record<string, unknown>) => {
    const targetSessionId = activeSessionId;
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
    const duplicateEntry = [...sessionSnapshotsRef.current.entries()].find(([id, snapshot]) =>
      id !== targetSessionId && snapshot.hasRecording && snapshot.sourceHash === interpretationHash);
    if (duplicateEntry) {
      storeActiveSession();
      const [duplicateId, duplicateSnapshot] = duplicateEntry;
      setActiveSessionId(duplicateId);
      applySessionSnapshot(duplicateSnapshot);
      setToast("That recording is already open — switched to its existing session");
      return false;
    }
    let restored: Annotation[] = [];
    let restoredCandidates: Candidate[] = [];
    let restoredActiveCandidate = 0;
    let restoredBadChannels: number[] = [];
    let restoredReviewer: string | null = null;
    let restoredRecordingType = nextMeta.channelLabels.length > 64 ? "SEEG / iEEG" : "Scalp EEG";
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
          restoredCandidates = migrateCandidateList(project.candidates, nextMeta.durationSec);
          if (Number.isInteger(project.activeCandidate) && restoredCandidates.length) {
            restoredActiveCandidate = clamp(project.activeCandidate as number, 0, restoredCandidates.length - 1);
          }
        }
        if (Array.isArray(project.badChannels)) {
          restoredBadChannels = project.badChannels.filter((index) => Number.isInteger(index) && index >= 0 && index < nextMeta.channelLabels.length);
        }
        if (typeof project.reviewer === "string") restoredReviewer = project.reviewer;
        if (typeof project.recordingType === "string") restoredRecordingType = project.recordingType;
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
    if (activeSessionIdRef.current !== targetSessionId) {
      throw new Error("The active session changed while the recording was opening. Load it again in the intended tab.");
    }
    sourceRef.current = source;
    setHasRecording(true);
    setSessionTabs((current) => current.map((tab) => tab.id === targetSessionId
      ? { ...tab, title: shortFileName(nextMeta.name.replace(/\.[^.]+$/, ""), 22), hasRecording: true, recoveryStatus: "saved" }
      : tab));
    setMeta(nextMeta);
    setSessionKey(nextKey);
    setRawSourceHash(contentHash);
    setSourceHash(interpretationHash);
    setSourceInterpretation(interpretation ?? null);
    setSelectedChannels(new Set(nextMeta.channelLabels.slice(0, 18).map((_, index) => index)));
    setBadChannels(new Set(restoredBadChannels));
    setDisplay({ data: [], labels: [], sampleRates: [], sourceIndices: [], primarySourceIndices: [], warnings: [] });
    setViewStart(0);
    setCursorTime(0);
    setCursorLocked(false);
    setSelection(null);
    setMarkOnset(null);
    setActiveTool("cursor");
    setAnnotationDragPreview(null);
    setTimebase(Math.min(20, Math.max(5, nextMeta.durationSec)));
    setCandidates(restoredCandidates);
    setActiveCandidate(restoredActiveCandidate);
    setSelectedAnnotationId(null);
    setRecordingType(restoredRecordingType);
    if (restoredReviewer) setReviewer(restoredReviewer);
    setAnnotations(restored);
    undoRef.current = [];
    redoRef.current = [];
    setToast(restored.length
      ? `Recovered ${restored.length} labels and local review state`
      : `${nextMeta.format} recording ready — ${nextMeta.channelLabels.length} channels${nextMeta.warnings.length ? ` · ${nextMeta.warnings.length} source warning${nextMeta.warnings.length === 1 ? "" : "s"}` : ""}`);
    setShowImport(false);
    return true;
  }, [activeSessionId, applySessionSnapshot, storeActiveSession]);

  const importFiles = async (files: File[]) => {
    if (!files.length || importBusyRef.current) return;
    importBusyRef.current = true;
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
        const opened = await loadSource(source, edf);
        if (!opened) return;
        const importedCandidates = source.events
          .filter((event) => event.timeSec >= 0 && event.timeSec < source.meta.durationSec)
          .map((event, index): Candidate => ({
            id: `edf-cand-${index}-${Math.round(event.timeSec * 1000)}`,
            time: event.timeSec,
            label: event.label,
            source: "bronze",
            status: "queued",
            uncertainty: 100,
          }));
        if (importedCandidates.length) {
          setCandidates((restored) => importedCandidates.map((candidate) => {
            const prior = restored.find((item) => item.id === candidate.id);
            return prior ? { ...candidate, status: prior.status, uncertainty: prior.uncertainty } : candidate;
          }));
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
        if (legacyMetadata) setToast(`Legacy MAT + DAT mapped — ${legacyMetadata.events.length} file event${legacyMetadata.events.length === 1 ? "" : "s"} found`);
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
      importBusyRef.current = false;
      setImportBusy(false);
    }
  };

  const confirmDatImport = async () => {
    if (!pendingDat || importBusyRef.current) return;
    importBusyRef.current = true;
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
      const opened = await loadSource(source, pendingDat, interpretation);
      if (!opened) return;
      if (pendingLegacyMeta?.events.length) {
        const importedCandidates = pendingLegacyMeta.events
          .map((event, index): Candidate => ({
            id: `cand-${index}-${Math.round(event.timeSec * 1000)}`,
            time: event.timeSec,
            label: event.label,
            source: "bronze",
            status: "queued",
            uncertainty: 100,
          }));
        setCandidates((restored) => importedCandidates.map((candidate) => {
          const prior = restored.find((item) => item.id === candidate.id);
          return prior ? { ...candidate, status: prior.status, uncertainty: prior.uncertainty } : candidate;
        }));
      }
      setPendingDat(null);
      setPendingLegacyMatFile(null);
      setPendingLegacyMeta(null);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Raw binary mapping failed");
    } finally {
      importBusyRef.current = false;
      setImportBusy(false);
    }
  };

  const exportBundle = () => {
    if (meta.details?.discontinuous === true) {
      setSessionMapTab("qc");
      setShowSessionMap(true);
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
    setToast(`Exported ${committed.length} committed labels + ${Math.ceil(meta.durationSec / 30)} training windows`);
  };

  useEffect(() => {
    const modalOpen = showHelp || showSettings || showChannels || showImport || showSessionMap || showPatientInfo || showAnnotationEditor || queueDetailEntry || confirmCommit.length > 0;
    if (!modalOpen) return;
    const modal = document.querySelector<HTMLElement>(".modal-backdrop [role='dialog'], .modal-backdrop .session-map-modal, .modal-backdrop .confirm-modal");
    if (!modal) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = [
      document.querySelector<HTMLElement>(".topbar"),
      document.querySelector<HTMLElement>(".workspace-grid"),
    ].filter((element): element is HTMLElement => Boolean(element));
    background.forEach((element) => element.setAttribute("inert", ""));
    const focusableSelector = "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";
    const focusFrame = window.requestAnimationFrame(() => {
      const firstFocusable = [...modal.querySelectorAll<HTMLElement>(focusableSelector)].find((element) => element.offsetParent !== null);
      (firstFocusable ?? modal).focus();
    });
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = [...modal.querySelectorAll<HTMLElement>(focusableSelector)].filter((element) => element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        modal.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapFocus, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", trapFocus, true);
      background.forEach((element) => element.removeAttribute("inert"));
      previousFocus?.focus();
    };
  }, [confirmCommit.length, queueDetailEntry, showAnnotationEditor, showChannels, showHelp, showImport, showPatientInfo, showSessionMap, showSettings]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const zoomModifier = event.metaKey || event.ctrlKey;
      const zoomInKey = ["+", "="].includes(event.key) || ["Equal", "NumpadAdd"].includes(event.code);
      const zoomOutKey = ["-", "_"].includes(event.key) || ["Minus", "NumpadSubtract"].includes(event.code);
      const modalOpen = showHelp || showSettings || showChannels || showImport || showSessionMap || showPatientInfo || showAnnotationEditor || queueDetailEntry || confirmCommit.length > 0;
      if (modalOpen && zoomModifier && (zoomInKey || zoomOutKey)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key === "Escape" && modalOpen) {
        event.preventDefault();
        if (showHelp) setShowHelp(false);
        else if (showSettings) setShowSettings(false);
        else if (showChannels) setShowChannels(false);
        else if (showSessionMap) setShowSessionMap(false);
        else if (showPatientInfo) setShowPatientInfo(false);
        else if (showAnnotationEditor) setShowAnnotationEditor(false);
        else if (queueDetailEntry) setQueueDetailTarget(null);
        else if (showImport && !importBusy) setShowImport(false);
        else if (confirmCommit.length) setConfirmCommit([]);
        setSelectedAnnotationId(null);
        setSelection(null);
        setMarkOnset(null);
        setCursorLocked(false);
        setDragGhost(null);
        setShowSessionContextPicker(false);
        setActiveTool("cursor");
        return;
      }
      if (modalOpen) return;
      if (zoomModifier && (zoomInKey || zoomOutKey)) {
        event.preventDefault();
        event.stopPropagation();
        if (hasRecording) zoomTimeWindow(zoomInKey ? "in" : "out", cursorLocked ? cursorTime : undefined);
        return;
      }
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
        setShowSessionContextPicker(false);
        setActiveTool("cursor");
        setToast("Selection and pinned cursor cleared");
        return;
      }
      if (!hasRecording) {
        if (event.key === "?") setShowHelp(true);
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
      } else if (lower === controlBindings.redo && event.shiftKey) {
        redo();
      } else if (lower === controlBindings.undo && !event.shiftKey) {
        undo();
      } else if (lower === controlBindings.ictalOnset) {
        setMarkOnset(cursorTime); setActiveTool("seizure"); setToast(`Onset placed at ${formatClock(cursorTime, true)} — press ${controlBindings.ictalOffset.toUpperCase()} at offset`);
      } else if (lower === controlBindings.ictalOffset && markOnset !== null) {
        if (cursorTime > markOnset) { addAnnotation(LABEL_BY_ID.get("ictal")!, markOnset, cursorTime); setMarkOnset(null); setActiveTool("cursor"); }
        else setToast("Offset must be after onset");
      } else if (lower === controlBindings.commit || event.key === "Enter" || event.code === "Space") {
        if (event.code === "Space") event.preventDefault();
        commitSelected();
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedAnnotationId) {
        event.preventDefault(); deleteAnnotation(selectedAnnotationId);
      } else if (lower === controlBindings.nextCandidate && instanceQueueEntries.length) {
        selectInstanceQueueEntry(Math.min(instanceQueueEntries.length - 1, activeQueueIndex + 1));
      } else if (lower === controlBindings.previousCandidate && instanceQueueEntries.length) {
        selectInstanceQueueEntry(Math.max(0, activeQueueIndex - 1));
      } else if (lower === controlBindings.toggleBadChannel && selectedChannels.size) {
        const originalIndex = display.primarySourceIndices[focusedChannel];
        if (originalIndex === undefined || originalIndex < 0) {
          setToast("Choose a displayed source-derived channel before changing channel quality");
          return;
        }
        setBadChannels((current) => {
          const next = new Set(current);
          if (next.has(originalIndex)) next.delete(originalIndex);
          else next.add(originalIndex);
          return next;
        });
        setToast(`${meta.channelLabels[originalIndex] ?? "Focused source channel"} quality updated`);
      } else if (event.key === "?") {
        setShowHelp(true);
      } else if (/^[1-9]$/.test(event.key)) {
        const label = LABELS.find((item) => item.shortcut === event.key);
        if (label) placePaletteLabel(label);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activeCandidate, activeQueueIndex, addAnnotation, candidates, commitSelected, confirmCommit.length, controlBindings, cursorLocked, cursorTime, deleteAnnotation, display.primarySourceIndices, focusedChannel, hasRecording, importBusy, instanceQueueEntries, markOnset, meta.channelLabels, placePaletteLabel, queueDetailEntry, redo, selectInstanceQueueEntry, selectedAnnotationId, selectedChannels, setViewStartSafe, showAnnotationEditor, showChannels, showHelp, showImport, showPatientInfo, showSessionMap, showSettings, timebase, undo, zoomTimeWindow]);

  const overviewLeft = (viewStart / Math.max(1, meta.durationSec)) * 100;
  const overviewWidth = Math.min(100, (timebase / Math.max(1, meta.durationSec)) * 100);
  const activeLabelGroups = [
    { label: "Sz", ids: ["preictal", "ictal", "postictal"] },
    { label: "IIIC", ids: ["gpd", "lpd", "bipd", "grda", "lrda", "gsw"] },
    { label: "Ictal Pathology", ids: ["spikes", "slowing", "suppression"] },
    { label: "Wake / Sleep", ids: ["wake", "sleep-unspecified", "rem", "n1", "n2", "n3"] },
    { label: "Other", ids: ["normal", "abnormal", "artifact", "uncertain"] },
  ] as const;
  const filteredLabels = LABELS.filter((label) => !label.hidden && label.name.toLowerCase().includes(paletteSearch.toLowerCase()));
  const entireSessionContexts = filteredLabels.filter((label) => label.track === "context" && label.geometry === "session");
  const rightContextLabels = ["clinical", "medication", "note"]
    .map((id) => LABEL_BY_ID.get(id))
    .filter((label): label is LabelDefinition => label !== undefined && label.name.toLowerCase().includes(paletteSearch.toLowerCase()));
  const sessionContextAnnotations = annotations.filter((item) => item.track === "context" && annotationGeometry(item) === "session");
  const filteredChannelOptions = meta.channelLabels
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => name.toLowerCase().includes(channelSearch.toLowerCase()));
  const controlRows: Array<{ key: keyof ControlBindings; label: string; modifier?: string }> = [
    { key: "undo", label: "Undo" },
    { key: "redo", label: "Redo", modifier: "Shift" },
    { key: "commit", label: "Commit selected label" },
    { key: "nextCandidate", label: "Next queued event" },
    { key: "previousCandidate", label: "Previous queued event" },
    { key: "ictalOnset", label: "Set ictal onset" },
    { key: "ictalOffset", label: "Set ictal offset" },
    { key: "toggleBadChannel", label: "Toggle focused channel quality" },
  ];
  const renderAnnotations = useMemo(() => annotationDragPreview
    ? annotations.map((item) => item.id === annotationDragPreview.id
      ? normalizeAnnotationGeometry({ ...item, ...annotationDragPreview.patch }, meta.durationSec)
      : item)
    : annotations, [annotationDragPreview, annotations, meta.durationSec]);
  const visibleAnnotations = useMemo(
    () => renderAnnotations.filter((item) => annotationOverlapsWindow(item, viewStart, viewStart + timebase)),
    [renderAnnotations, timebase, viewStart],
  );
  const bottomAnnotations = useMemo(
    () => visibleAnnotations.filter((item) => annotationGeometry(item) !== "session"),
    [visibleAnnotations],
  );
  const contextLaneLayout = useMemo(
    () => assignAnnotationLanes(bottomAnnotations.filter((item) => item.track === "context")),
    [bottomAnnotations],
  );
  const contextLaneHeight = 34;
  const contextLaneCapacity = Math.max(1, Math.floor((contextTrackHeight - 10) / contextLaneHeight));
  const contextLaneStep = contextLaneLayout.laneCount <= contextLaneCapacity
    ? contextLaneHeight
    : contextLaneCapacity > 1
      ? Math.max(10, (contextTrackHeight - contextLaneHeight - 10) / (contextLaneCapacity - 1))
      : 0;
  const tracks: Array<{ id: TrackId; label: string }> = [
    { id: "context", label: "Context Labels" },
    { id: "windowed", label: "ePhys Window Labels" },
    { id: "instance", label: "ePhys Instance Labels" },
  ];
  const gridDivisions = timebase <= 30 ? Math.max(2, Math.ceil(timebase / 5)) : 10;

  return (
    <main className="neuro-app" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      if (!importBusyRef.current && event.dataTransfer.files.length) importFiles([...event.dataTransfer.files]);
    }}>
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /><i /></span>
          <div><strong>NEUROTRACE</strong><span>Clinical EEG Studio</span></div>
        </div>
        <nav className="session-tab-strip" role="tablist" aria-label="EEG sessions" onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || importBusy) return;
          event.preventDefault();
          const currentIndex = Math.max(0, sessionTabs.findIndex((tab) => tab.id === activeSessionId));
          const nextIndex = event.key === "Home"
            ? 0
            : event.key === "End"
              ? sessionTabs.length - 1
              : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + sessionTabs.length) % sessionTabs.length;
          const nextId = sessionTabs[nextIndex]?.id;
          if (!nextId) return;
          switchSession(nextId);
          window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-session-tab="${nextId}"]`)?.focus());
        }}>
          <div className="session-tabs">
            {sessionTabs.map((tab) => {
              const tabRecovery = tab.id === activeSessionId ? recoveryStatus : tab.recoveryStatus;
              const tabHasRecording = tab.id === activeSessionId ? hasRecording : tab.hasRecording;
              return <div className="session-tab-shell" key={tab.id}>
                <button
                  role="tab"
                  aria-selected={tab.id === activeSessionId}
                  aria-controls="active-session-workspace"
                  tabIndex={tab.id === activeSessionId ? 0 : -1}
                  data-session-tab={tab.id}
                  className={`session-tab ${tab.id === activeSessionId ? "active" : ""}`}
                  disabled={importBusy}
                  onClick={() => switchSession(tab.id)}
                  title={`${tab.title}${tabRecovery === "error" ? " · local recovery unavailable" : tabHasRecording ? " · locally recoverable" : " · blank"}`}
                ><span className={`session-tab-dot ${tabRecovery === "error" ? "error" : tabHasRecording ? "loaded" : "blank"}`} />{tab.title}</button>
                <button className="session-tab-close" disabled={importBusy || sessionTabs.length <= 1} aria-label={`Close ${tab.title}`} title={sessionTabs.length <= 1 ? "At least one session stays open" : `Close ${tab.title}`} onClick={() => closeSession(tab.id)}>×</button>
              </div>;
            })}
          </div>
          <button className="add-session-tab" disabled={importBusy} aria-label="Add blank session" title="Add blank session" onClick={createBlankSession}>+</button>
        </nav>
        <div className="top-actions utility-actions">
          <button className="utility-button" aria-label="Open Help" title="Help" onClick={() => setShowHelp(true)}><span aria-hidden="true">?</span></button>
          <button className="utility-button" aria-label="Open Settings" title="Settings" onClick={() => setShowSettings(true)}><span className="settings-glyph" aria-hidden="true">⚙</span></button>
        </div>
      </header>

      <div className={`workspace-grid ${leftPanelOpen ? "" : "left-collapsed"} ${rightPanelOpen ? "" : "right-collapsed"}`}>
        <aside className="left-sidebar">
          <section className="recording-summary">
            {hasRecording ? <>
              <div className="recording-file-line"><strong title={meta.name}>{shortFileName(meta.name)}</strong><span>File type: {meta.format.toUpperCase()}</span></div>
              <div className="recording-stats">{formatClock(meta.durationSec)} · {meta.channelLabels.length} ch · {primarySampleRate(meta)} Hz</div>
              <label className="recording-type-line"><span>Recording type:</span><select value={recordingType} onChange={(event) => setRecordingType(event.target.value)}><option>SEEG / iEEG</option><option>Scalp EEG</option><option>Simultaneous scalp + iEEG</option><option>Other ephys</option></select></label>
            </> : <button className="compact-load-recording" onClick={() => setShowImport(true)}>
              <span aria-hidden="true">＋</span>
              <strong>Load recording</strong>
              <small>EDF · MAT · MAT + DAT</small>
            </button>}
          </section>

          <button className="patient-info-disclosure" disabled={!hasRecording} onClick={() => setShowPatientInfo(true)}>
            <span>Open Patient Info {hasRecording && `(${patientLabel(meta)})`}</span><b aria-hidden="true">↗</b>
          </button>

          <button className="session-map-row" disabled={!hasRecording} onClick={() => {
            setSessionMapTab("map");
            setShowSessionMap(true);
          }}><span>Session Map</span><b aria-hidden="true">↗</b></button>

          <section className="session-labels-section">
            <div className="sidebar-centered-heading">
              <strong>Session Labels</strong>
              <span>{sessionContextAnnotations.length}</span>
              <div className="session-context-menu-wrap">
                <button className="sidebar-add-button" disabled={!hasRecording} aria-label="Add session label" title="Add entire-session context" onClick={() => setShowSessionContextPicker((value) => !value)}>＋</button>
                {showSessionContextPicker && <div className="session-context-picker" role="menu" aria-label="Entire-session context labels">
                  <strong>Add entire-session context</strong>
                  {entireSessionContexts.map((label) => <button key={label.id} role="menuitem" onClick={() => {
                    placePaletteLabel(label);
                    setShowSessionContextPicker(false);
                  }} style={{ "--label-color": label.color } as React.CSSProperties}><i />{label.name}</button>)}
                </div>}
              </div>
            </div>
            <div className="session-label-list">
              {sessionContextAnnotations.length ? sessionContextAnnotations.map((item) => {
                const label = LABEL_BY_ID.get(item.labelId);
                return <button key={item.id} className={selectedAnnotationId === item.id ? "active" : ""} onClick={() => {
                  setSelectedAnnotationId(item.id);
                }} style={{ "--label-color": label?.color } as React.CSSProperties}>
                  <i /><span><strong>{label?.name ?? item.labelId}</strong><small>{item.notes || "Entire recording"}</small></span>
                </button>;
              }) : <div className="empty-session-labels"><strong>No session labels</strong><span>Use + above to add one.</span></div>}
            </div>
          </section>

          <section className="queue-section">
            <div className="queue-heading">
              <button disabled={!instanceQueueEntries.length || activeQueueIndex <= 0} aria-label="Previous event or instance" title="Previous event or instance" onClick={() => selectInstanceQueueEntry(Math.max(0, activeQueueIndex - 1))}>‹</button>
              <div><strong>Instance Queue</strong><span>{instanceQueueEntries.length ? activeQueueIndex + 1 : 0}/{instanceQueueEntries.length}</span></div>
              <button disabled={!instanceQueueEntries.length || activeQueueIndex >= instanceQueueEntries.length - 1} aria-label="Next event or instance" title="Next event or instance" onClick={() => selectInstanceQueueEntry(Math.min(instanceQueueEntries.length - 1, activeQueueIndex + 1))}>›</button>
            </div>
            <div className="queue-list">
              {instanceQueueEntries.length ? instanceQueueEntries.map((entry, index) => <div key={`${entry.kind}-${entry.id}`} className={`queue-item ${index === activeQueueIndex ? "active" : ""}`}>
                <button className="queue-jump" onClick={() => selectInstanceQueueEntry(index)} aria-label={`Jump to ${entry.label}`}>
                  <span className={`queue-status ${entry.status}`} />
                  <span className="queue-copy"><strong>{entry.label}</strong><small>{formatClock(entry.time, true)} · {entry.detail}</small></span>
                </button>
                <label className="queue-uncertainty" title="Editable uncertainty percentage">
                  <input type="number" min="0" max="100" step="1" value={entry.uncertainty} aria-label={`Uncertainty for ${entry.label}`} onChange={(event) => updateQueueUncertainty(entry.kind, entry.id, Number(event.target.value))} />
                  <span>%</span>
                </label>
                <button className="queue-arrow" aria-label={`Open details for ${entry.label}`} title={`Open ${entry.label} details`} onClick={() => setQueueDetailTarget({ kind: entry.kind, id: entry.id })}>›</button>
              </div>) : <div className="empty-queue"><strong>No events or instance labels</strong><p>{hasRecording ? "File events, instance labels, and timed context appear here." : "Load a recording to begin."}</p></div>}
            </div>
          </section>
        </aside>

        <section className="review-surface" id="active-session-workspace" role="tabpanel">
          <div className="viewer-toolbar">
            <div className="panel-toggle-pair" aria-label="Workspace panels">
              <button className={`panel-icon-button ${leftPanelOpen ? "active" : ""}`} aria-label={`${leftPanelOpen ? "Hide" : "Show"} left panel`} aria-pressed={leftPanelOpen} title={`${leftPanelOpen ? "Hide" : "Show"} recording panel`} onClick={() => setLeftPanelOpen((value) => !value)}><span className="panel-glyph left" aria-hidden="true"><i /><i /><i /></span></button>
              <button className={`panel-icon-button ${rightPanelOpen ? "active" : ""}`} aria-label={`${rightPanelOpen ? "Hide" : "Show"} right panel`} aria-pressed={rightPanelOpen} title={`${rightPanelOpen ? "Hide" : "Show"} context and label panel`} onClick={() => setRightPanelOpen((value) => !value)}><span className="panel-glyph right" aria-hidden="true"><i /><i /><i /></span></button>
              <button className={`panel-bottom-button ${bottomTracksOpen ? "active" : ""}`} aria-label={`${bottomTracksOpen ? "Hide" : "Show"} bottom label tracks`} aria-pressed={bottomTracksOpen} title={`${bottomTracksOpen ? "Hide" : "Show"} bottom label tracks`} onClick={() => setBottomTracksOpen((value) => !value)}><span className="bottom-panel-glyph" aria-hidden="true"><i /><i /><i /></span></button>
            </div>
            <span className="toolbar-kicker">Signal tools</span>
            <button className={`spectrum-button ${spectrogramOpen ? "active" : ""}`} aria-label="Spectrum" disabled={!hasRecording} onClick={() => setSpectrogramOpen((value) => !value)}><span className="spectrum-glyph" aria-hidden="true"><i /><i /><i /><i /></span><b>Spectrum</b></button>
            <label className="toolbar-select"><span>Montage</span><select aria-label="Montage" disabled={!hasRecording} value={montage} onChange={(event) => setMontage(event.target.value as MontageMode)}><option value="referential">Recorded reference</option><option value="average">Average reference</option><option value="bipolar">Anatomical bipolar</option></select></label>
            <button className={`compact-toggle ${showFilters ? "active" : ""}`} aria-label="Filters" disabled={!hasRecording} onClick={() => setShowFilters((value) => !value)}><span className="filter-glyph">≋</span> Filters <i>{filters.enabled ? `${filters.highPassHz}–${filters.lowPassHz} · ${filters.notchHz}Hz` : "Raw"}</i></button>
            <div className="time-window-control" aria-label="Window"><span>Window</span><button disabled={!hasRecording} aria-label="Zoom out in time" title="Zoom out · Ctrl/⌘ −" onClick={() => zoomTimeWindow("out")}>−</button><label><input disabled={!hasRecording} aria-label="Visible seconds" type="number" min="1" max="300" step="1" value={Number(timebase.toFixed(1))} onChange={(event) => setTimeWindow(Number(event.target.value))} /><b>s</b></label><button disabled={!hasRecording} aria-label="Zoom in in time" title="Zoom in · Ctrl/⌘ +" onClick={() => zoomTimeWindow("in")}>+</button></div>
            <div className="gain-control" aria-label="Gain"><span>Gain</span><button disabled={!hasRecording} onClick={() => setGain((value) => Math.max(0.25, value / 1.25))}>−</button><b>{gain.toFixed(1)}×</b><button disabled={!hasRecording} onClick={() => setGain((value) => Math.min(8, value * 1.25))}>+</button></div>
            <div className="toolbar-spacer" />
            <div className="transport-group">
              <button disabled={!hasRecording} aria-label="Previous page" onClick={() => setViewStartSafe((value) => value - timebase)}>‹</button>
              <button disabled={!hasRecording} className={`play-button ${playing ? "playing" : ""}`} aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying((value) => !value)}>{playing ? "Ⅱ" : "▶"}</button>
              <button disabled={!hasRecording} aria-label="Next page" onClick={() => setViewStartSafe((value) => value + timebase)}>›</button>
            </div>
          </div>

          {hasRecording && showFilters && <div className="filter-drawer">
            <div><strong>Display filters</strong><span>Raw samples remain unchanged</span></div>
            <label>High-pass <input type="number" min="0" step="0.1" value={filters.highPassHz} onChange={(event) => setFilters((current) => ({ ...current, highPassHz: Number(event.target.value) }))} /> Hz</label>
            <label>Low-pass <input type="number" min="1" step="1" value={filters.lowPassHz} onChange={(event) => setFilters((current) => ({ ...current, lowPassHz: Number(event.target.value) }))} /> Hz</label>
            <label>Notch <select value={filters.notchHz} onChange={(event) => setFilters((current) => ({ ...current, notchHz: Number(event.target.value) as 0 | 50 | 60 }))}><option value="0">Off</option><option value="50">50 Hz</option><option value="60">60 Hz</option></select></label>
            <label className="switch-label"><input type="checkbox" checked={filters.enabled} onChange={(event) => setFilters((current) => ({ ...current, enabled: event.target.checked }))} /><span /> Enabled</label>
            <button onClick={() => setFilters({ ...DEFAULT_FILTERS, enabled: false })}>Reset to raw</button>
          </div>}

          {hasRecording ? <>
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
            <div className={`waveform-wrap ${expandedChannels ? "channel-scroll-mode" : ""}`} style={{ "--channel-content-height": `${Math.max(245, display.labels.length * 60 + 28)}px` } as React.CSSProperties}>
              <div className="channel-rail" style={{ gridTemplateRows: `repeat(${Math.max(1, display.labels.length)}, 1fr)` }}>
                <button className="channel-manager-button" aria-label="Add channels" title="Choose visible channels" onClick={() => setShowChannels(true)}>CH+</button>
                <button className={`channel-layout-button ${expandedChannels ? "active" : ""}`} aria-label={`${expandedChannels ? "Use compact" : "Use expanded scrollable"} channel layout`} aria-pressed={expandedChannels} title={`${expandedChannels ? "Compact channels" : "Expand channels and scroll vertically"}`} onClick={() => setExpandedChannels((value) => !value)}>E</button>
                {display.labels.map((label, index) => <button key={`${label}-${index}`} className={focusedChannel === index ? "focused" : ""} aria-pressed={focusedChannel === index} onClick={() => setFocusedChannel(index)}><strong>{label}</strong><span>{formatAmplitude(display.data[index]?.[Math.floor(display.data[index].length / 2)] ?? 0)}</span></button>)}
              </div>
              <div className="canvas-shell">
                <canvas ref={canvasRef} aria-label="EEG waveform" onPointerDown={onWavePointerDown} onPointerMove={onWavePointerMove} onPointerUp={onWavePointerUp} />
                {selection && <div className="wave-selection" style={{
                  left: `${((Math.max(viewStart, selection.start) - viewStart) / timebase) * 100}%`,
                  width: `${Math.max(0, ((Math.min(viewStart + timebase, selection.end) - Math.max(viewStart, selection.start)) / timebase) * 100)}%`,
                }} />}
                {cursorLocked && cursorTime >= viewStart && cursorTime <= viewStart + timebase && <div className="wave-cursor pinned" style={{ left: `${((cursorTime - viewStart) / timebase) * 100}%` }}><span>{formatClock(cursorTime, true)}</span></div>}
                {loadingSignal && <div className="signal-loading"><span /> Reading signal window…</div>}
                {dragGhost && <div className="drop-ghost" style={{ left: `${((dragGhost.time - viewStart) / timebase) * 100}%` }}><span>{formatClock(dragGhost.time, true)}</span></div>}
                {!display.data.length && !loadingSignal && <div className="no-channels"><strong>No visible channels</strong><span>Use CH+ to choose channels.</span></div>}
              </div>
            </div>

            {spectrogramOpen && <SpectrogramPanel data={display.data[focusedChannel]} sampleRate={display.sampleRates[focusedChannel] || primarySampleRate(meta)} start={viewStart} cursor={cursorTime} label={display.labels[focusedChannel] || "Focused channel"} />}

            {bottomTracksOpen && <div className="timeline" ref={timelineRef}>
              {tracks.map((track) => <div className={`timeline-row ${track.id === "context" ? "context-row" : ""}`} key={track.id} style={track.id === "context" ? { height: contextTrackHeight } : undefined}>
                <div className="track-label"><span className={`track-icon ${track.id}`} />{track.label}</div>
                <div className="track-lane" data-track-id={track.id}>
                  <div className="window-grid">{Array.from({ length: gridDivisions }, (_, index) => <i key={index} />)}</div>
                  {bottomAnnotations.filter((item) => item.track === track.id).map((item) => {
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
                {track.id === "context" && <button className="context-resize-handle" aria-label="Resize context track" title="Drag up to expand; drag down to shrink the context track" onPointerDown={(event) => {
                  event.preventDefault();
                  contextResizeRef.current = { startY: event.clientY, startHeight: contextTrackHeight };
                }} />}
              </div>)}
            </div>}
          </div>

          <footer className="command-strip">
            <div className="cursor-readout"><span className="crosshair-mini">⌖</span><strong>{formatClock(cursorTime, true)}</strong><span>{display.labels[focusedChannel] ?? "—"}</span><span>{formatAmplitude(cursorAmplitude)}</span><span>sample {Math.round(cursorTime * (display.sampleRates[focusedChannel] ?? primarySampleRate(meta))).toLocaleString()}</span></div>
            <div className="command-status"><span className="status-dot" /><span className="command-status-text">{toast}</span></div>
            {selectedAnnotation && <div className="annotation-command-actions">
              <button onClick={() => setShowAnnotationEditor(true)}>Edit label</button>
              <button className="trash-button" onClick={() => deleteAnnotation(selectedAnnotation.id)} title="Delete annotation" aria-label="Delete annotation">🗑</button>
            </div>}
          </footer>
          </> : <button className="recording-empty-state" onClick={() => setShowImport(true)}>
            <span className="empty-load-mark" aria-hidden="true">＋</span>
            <strong>Load a recording to begin</strong>
            <p>Open EDF / EDF+, MATLAB v5, or a paired MAT + DAT session.</p>
            <small>Click to choose files, or drop them anywhere in this workspace.</small>
          </button>}
        </section>

        <aside className="right-sidebar">
          <div className="ontology-search-row">
            <input className="palette-search" aria-label="Search label ontology" placeholder="Search ontology…" value={paletteSearch} onChange={(event) => setPaletteSearch(event.target.value)} />
          </div>
          <section className="compact-context-palette">
            <h2>Context Labels</h2>
            <p className="palette-kind">Context palette · click = instance · selected span = window</p>
            <div className="compact-context-only">
              {rightContextLabels.map((label) => <button key={label.id} className="compact-palette-button context" disabled={!hasRecording} draggable={hasRecording} onDragStart={(event) => {
                  event.dataTransfer.setData("application/x-neurotrace-label", label.id);
                  event.dataTransfer.effectAllowed = "copy";
                  setDragGhost({ labelId: label.id, time: cursorTime });
                }} onDragEnd={() => setDragGhost(null)} onClick={() => placePaletteLabel(label)} style={{ "--label-color": label.color } as React.CSSProperties} title={`${label.name} · ${label.geometry === "session" ? "entire recording" : label.geometry === "point" ? "single clinical moment" : "timed context"}`}>
                  <i />{label.name}
                </button>)}
            </div>
          </section>
          <section className="compact-ephys-palette">
            <h2>ePhys Labels</h2>
            <p><span className="palette-kind">Label palette</span> · click = instance · selected span = window</p>
            <div className="ontology-groups">
              {activeLabelGroups.map(({ label: groupLabel, ids }) => {
                const group = ids
                  .map((id) => LABEL_BY_ID.get(id))
                  .filter((label): label is LabelDefinition => label !== undefined && !label.hidden && label.name.toLowerCase().includes(paletteSearch.toLowerCase()));
                if (!group.length) return null;
                return <div className="ontology-group" data-category={groupLabel} key={groupLabel}><span>{groupLabel}:</span><div>{group.map((label) => <button className="compact-palette-button" key={label.id} disabled={!hasRecording} draggable={hasRecording} onDragStart={(event) => {
                  event.dataTransfer.setData("application/x-neurotrace-label", label.id);
                  event.dataTransfer.effectAllowed = "copy";
                  setDragGhost({ labelId: label.id, time: cursorTime });
                }} onDragEnd={() => setDragGhost(null)} onClick={() => placePaletteLabel(label)} style={{ "--label-color": label.color } as React.CSSProperties} title={`${label.name}${label.shortcut ? ` · shortcut ${label.shortcut}` : ""}`}>
                  <i />{PALETTE_BUTTON_NAMES[label.id] ?? label.short}
                </button>)}</div></div>;
              })}
            </div>
          </section>
        </aside>
      </div>

      {showImport && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !importBusy) setShowImport(false); }}>
        <div className="modal import-modal" role="dialog" aria-modal="true" aria-label="Load recording" tabIndex={-1}>
          <button className="modal-close" disabled={importBusy} onClick={() => setShowImport(false)} aria-label="Close">×</button>
          <span className="modal-eyebrow">OPEN A RECORDING</span>
          <h2>Bring the signal to the labels.</h2>
          <p>EDF/EDF+ streams by time window. Self-contained MATLAB v5 matrices are mapped locally. Legacy Buzcode sessions can pair a MAT with its same-basename DAT.</p>
          <button className={`drop-zone ${importBusy ? "busy" : ""}`} disabled={importBusy} onClick={() => fileInputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); importFiles([...event.dataTransfer.files]); }}>
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

      {showChannels && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowChannels(false); }}>
        <div className="modal channel-modal" role="dialog" aria-modal="true" aria-label="Channel controls" tabIndex={-1}>
          <button className="modal-close" onClick={() => setShowChannels(false)} aria-label="Close channel controls">×</button>
          <span className="modal-eyebrow">CHANNEL DISPLAY</span>
          <h2>Choose what appears in the recording.</h2>
          <div className="detected-channels"><strong>Detected channels:</strong><span>{meta.channelLabels.length} total · {selectedChannels.size} source channels selected · {badChannels.size} quality-excluded · {display.labels.length} displayed rows</span></div>
          <div className="channel-modal-tools">
            <input aria-label="Search detected channels" placeholder="Find a channel…" value={channelSearch} onChange={(event) => setChannelSearch(event.target.value)} />
            <button onClick={() => setSelectedChannels(new Set(meta.channelLabels.map((_, index) => index)))}>Enable all</button>
            <button onClick={() => setSelectedChannels(new Set())}>Disable all</button>
          </div>
          <div className="channel-toggle-list">
            {filteredChannelOptions.map(({ name, index }) => <div className={`channel-toggle-row ${badChannels.has(index) ? "bad" : ""}`} key={`${name}-${index}`}>
              <label>
                <input type="checkbox" checked={selectedChannels.has(index)} onChange={() => setSelectedChannels((current) => {
                  const next = new Set(current);
                  if (next.has(index)) next.delete(index);
                  else next.add(index);
                  return next;
                })} />
                <span className="channel-switch" aria-hidden="true" />
                <span className="channel-toggle-copy"><strong>{name}</strong><small>{meta.channelUnits[index] ?? "µV"} · source channel {index + 1}</small></span>
              </label>
              <button className={badChannels.has(index) ? "bad" : ""} onClick={() => setBadChannels((current) => {
                const next = new Set(current);
                if (next.has(index)) next.delete(index);
                else next.add(index);
                return next;
              })}>{badChannels.has(index) ? "Bad" : "Good"}</button>
            </div>)}
          </div>
          <p className="channel-modal-note">Montage labels may combine source channels. NeuroTrace keeps the original channel provenance with every channel-specific annotation.</p>
        </div>
      </div>}

      {showHelp && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowHelp(false); }}>
        <div className="modal help-modal" role="dialog" aria-modal="true" aria-label="Help" tabIndex={-1}>
          <button className="modal-close" onClick={() => setShowHelp(false)} aria-label="Close Help">×</button>
          <span className="modal-eyebrow">NEUROTRACE GUIDE</span>
          <h2>Everything in this workspace.</h2>
          <p className="controls-intro">The viewer is organized around a recording, its clinical context, time-window labels, and precise instance labels.</p>
          <div className="help-sections">
            {[
              ["Session tabs", "Each tab is an independent annotation workspace. Press + for a blank session, then load its recording."],
              ["Recording info", "Shows the source file and recording type. Open Patient Info for identifiers, reviewer, source integrity, replacement, and export controls."],
              ["Instance queue", "File events, instance labels, and non-session context events appear in time order. Select one or use the arrows to jump straight to it."],
              ["Signal tools", "Spectrum opens the focused-channel spectral view. Montage, filters, window, and gain only change the display; raw samples stay immutable."],
              ["CH+ channel manager", "Opens detected source channels. Toggle visibility and mark channel quality without losing source-channel provenance."],
              ["Waveform labeling", "Click once to pin a time, then click any ePhys label to create an instance there. Drag across time, then click a label to apply it to that exact window."],
              ["Annotation tracks", "Context may stack, windowed labels occupy spans, and instance labels mark single moments. Drag annotations to move them or between the two ePhys tracks to convert geometry."],
              ["Context Labels", "Clinical Observation, Medication, and Other are the three timed context tools. Whole-session labels are added only with + in the left Session Labels panel."],
              ["ePhys Labels", "The same ontology can describe a single instant or a selected window. Sleep stages, rhythmic/periodic patterns, seizure state, quality, and spikes are grouped here."],
              ["Inspector and deletion", "Select any annotation to edit timing, notes, reviewer, and confidence, commit a revision, or use the trash can. Delete/Backspace also removes the selection."],
              ["QC and session map", "QC checks source assumptions and label integrity. Session map gives a hoverable, clickable whole-recording view."],
              ["Navigation", "Trackpad or mouse-wheel movement pans through time. Pinch or Ctrl/⌘ +/- zooms only the EEG window. Escape clears the current interaction."],
            ].map(([title, copy], index) => <section key={title}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{title}</strong><p>{copy}</p></div></section>)}
          </div>
          <div className="research-notice"><span>✦</span><p><strong>Research annotation workspace.</strong> Not for diagnosis or autonomous clinical decision-making. Clinical deployment requires institutional validation and privacy review.</p></div>
        </div>
      </div>}

      {showSettings && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSettings(false); }}>
        <div className="modal settings-modal" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1}>
          <button className="modal-close" onClick={() => setShowSettings(false)} aria-label="Close Settings">×</button>
          <span className="modal-eyebrow">CONTROLS</span>
          <h2>Make the workspace feel natural.</h2>
          <p>Change the letter shortcuts below. Navigation, zoom, selection, deletion, and Escape remain fixed so the viewer always has a safe recovery path.</p>
          <section className="settings-section">
            <div className="settings-heading"><strong>Editable keyboard controls</strong><button onClick={() => setControlBindings(DEFAULT_CONTROLS)}>Restore defaults</button></div>
            <div className="binding-list">
              {controlRows.map((row) => <label key={row.key}><span>{row.label}</span><span className="binding-input">{row.modifier && <b>{row.modifier} +</b>}<select aria-label={`${row.label} shortcut`} value={controlBindings[row.key]} onChange={(event) => updateControlBinding(row.key, event.target.value)}>{CONTROL_OPTIONS.map((key) => <option key={key} value={key}>{key.toUpperCase()}</option>)}</select></span></label>)}
            </div>
            <small className="binding-note">Choosing a letter already in use swaps the two actions, so every shortcut remains reachable.</small>
          </section>
          <section className="settings-section interaction-settings">
            <div className="settings-heading"><strong>Pointer and timing controls</strong></div>
            <label><span>Label snapping</span><select value={snapMode} onChange={(event) => setSnapMode(event.target.value as "1s" | "100ms" | "sample")}><option value="1s">1 second</option><option value="100ms">100 milliseconds</option><option value="sample">Focused channel sample</option></select></label>
            <div className="fixed-control-grid">
              {[["Click", "Pin instance time"], ["Click + drag", "Select label window"], ["Wheel / trackpad", "Pan in time"], ["Pinch or ⌘ +/−", "EEG-only zoom"], ["Delete / ⌫", "Delete selected label"], ["Escape", "Clear selection and cursor"]].map(([key, action]) => <div key={key}><kbd>{key}</kbd><span>{action}</span></div>)}
            </div>
          </section>
        </div>
      </div>}

      {showPatientInfo && hasRecording && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowPatientInfo(false); }}>
        <div className="modal patient-info-modal" role="dialog" aria-modal="true" aria-label="Patient information" tabIndex={-1}>
          <button className="modal-close" onClick={() => setShowPatientInfo(false)} aria-label="Close patient information">×</button>
          <span className="modal-eyebrow">PATIENT &amp; SOURCE</span>
          <h2>Patient Information</h2>
          <p>Recording identifiers and source details remain inside this local review workspace.</p>
          <div className="patient-info-grid">
            <div><span>Patient</span><strong>{patientLabel(meta)}</strong></div>
            <div><span>Session</span><strong>{recordingLabel(meta)}</strong></div>
            <div><span>Recording start</span><strong>{formatSessionStart(meta.startedAt)}</strong></div>
            <div><span>Source integrity</span><strong className="hash-text" title={sourceHash}>{sourceHashDisplay}</strong></div>
            <div><span>Source channels</span><strong>{meta.channelLabels.length}</strong></div>
            <div><span>Quality excluded</span><strong>{badChannels.size}</strong></div>
            <label><span>Reviewer initials</span><input value={reviewer} maxLength={12} onChange={(event) => setReviewer(event.target.value.toUpperCase())} /></label>
          </div>
          <div className="patient-modal-actions">
            <button className="button secondary" onClick={() => {
              setShowPatientInfo(false);
              setShowImport(true);
            }}>Replace recording</button>
            <button className="button primary" onClick={() => {
              setShowPatientInfo(false);
              exportBundle();
            }}>Export model-ready bundle</button>
          </div>
        </div>
      </div>}

      {queueDetailEntry && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setQueueDetailTarget(null); }}>
        <div className="modal queue-detail-modal" role="dialog" aria-modal="true" aria-label={`${queueDetailEntry.label} details`} tabIndex={-1}>
          <button className="modal-close" onClick={() => setQueueDetailTarget(null)} aria-label="Close queue item details">×</button>
          <span className="modal-eyebrow">{queueDetailAnnotation?.track === "context" ? "TIMED CONTEXT" : queueDetailAnnotation ? "EPHYS INSTANCE" : "SOURCE FILE EVENT"}</span>
          <div className="queue-detail-heading" style={{ "--label-color": queueDetailLabel?.color ?? "#ff6b7b" } as React.CSSProperties}>
            <i />
            <div><h2>{queueDetailEntry.label}</h2><p>{queueDetailEntry.detail}</p></div>
            <span className={`revision-state ${queueDetailEntry.status}`}>{queueDetailEntry.status}</span>
          </div>
          <div className="queue-detail-grid">
            <div><span>Start</span><strong>{formatClock(queueDetailEntry.time, true)}</strong></div>
            <div><span>Geometry</span><strong>{queueDetailAnnotation ? annotationGeometry(queueDetailAnnotation) === "point" ? "Single moment" : "Timed window" : "Source event"}</strong></div>
            <div><span>Uncertainty</span><strong>{queueDetailEntry.uncertainty}%</strong></div>
            {queueDetailAnnotation && <div><span>Duration</span><strong>{annotationGeometry(queueDetailAnnotation) === "point" ? "Instant" : `${(queueDetailAnnotation.end - queueDetailAnnotation.start).toFixed(3)} s`}</strong></div>}
            {queueDetailAnnotation && <div><span>Reviewer</span><strong>{queueDetailAnnotation.reviewer || "Not assigned"}</strong></div>}
            {queueDetailCandidate && <div><span>Source status</span><strong>{queueDetailCandidate.status}</strong></div>}
            {queueDetailCandidate && <div><span>Source tier</span><strong>{queueDetailCandidate.source}</strong></div>}
          </div>
          <section className="queue-detail-notes">
            <span>{queueDetailAnnotation?.track === "context" ? "CONTEXT / NOTES" : "NOTES"}</span>
            <p>{queueDetailAnnotation?.notes?.trim() || (queueDetailAnnotation?.track === "context" ? `${queueDetailEntry.label} at ${formatClock(queueDetailEntry.time, true)}. No additional context note was entered.` : "No notes are attached to this item.")}</p>
          </section>
          {queueDetailAnnotation?.channelScope && <section className="queue-detail-source">
            <span>CHANNEL PROVENANCE</span>
            <strong>{queueDetailAnnotation.channelScope.displayLabel}</strong>
            <p>{queueDetailAnnotation.channelScope.sourceLabels.join(", ")} · {queueDetailAnnotation.channelScope.montage}</p>
          </section>}
          <div className="queue-detail-actions">
            <button className="button secondary" onClick={() => {
              const index = instanceQueueEntries.findIndex((item) => item.kind === queueDetailEntry.kind && item.id === queueDetailEntry.id);
              if (index >= 0) selectInstanceQueueEntry(index);
              setQueueDetailTarget(null);
            }}>Jump to location</button>
            {queueDetailAnnotation && <button className="button primary" onClick={() => {
              setSelectedAnnotationId(queueDetailAnnotation.id);
              setQueueDetailTarget(null);
              setShowAnnotationEditor(true);
            }}>Open annotation</button>}
          </div>
        </div>
      </div>}

      {showAnnotationEditor && selectedAnnotation && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowAnnotationEditor(false); }}>
        <div className="modal annotation-editor-modal" role="dialog" aria-modal="true" aria-label="Annotation editor" tabIndex={-1}>
          <button className="modal-close" onClick={() => setShowAnnotationEditor(false)} aria-label="Close annotation editor">×</button>
          <span className="modal-eyebrow">ANNOTATION EDITOR</span>
          <div className="annotation-editor-heading">
            <div className="selected-label" style={{ "--label-color": LABEL_BY_ID.get(selectedAnnotation.labelId)?.color } as React.CSSProperties}><i /><div><strong>{LABEL_BY_ID.get(selectedAnnotation.labelId)?.name}</strong><span>{selectedGeometry} label · {selectedAnnotation.track} track · revision {selectedAnnotation.revision}</span></div></div>
            <span className={`revision-state ${selectedAnnotation.status}`}>{selectedAnnotation.status}</span>
          </div>
          <div className="inspector-form">
            <div className="time-fields"><label><span>Start (s)</span><input type="number" step="0.001" value={selectedAnnotation.start} disabled={selectedGeometry === "session"} onChange={(event) => updateAnnotation(selectedAnnotation.id, { start: clamp(Number(event.target.value), 0, selectedGeometry === "interval" ? selectedAnnotation.end : meta.durationSec) })} /></label><label><span>End (s)</span><input type="number" step="0.001" value={selectedAnnotation.end} disabled={selectedGeometry !== "interval"} onChange={(event) => updateAnnotation(selectedAnnotation.id, { end: clamp(Number(event.target.value), selectedAnnotation.start, meta.durationSec) })} /></label></div>
            <div className="duration-line"><span>{formatClock(selectedAnnotation.start, true)}</span><i /><span>{(selectedAnnotation.end - selectedAnnotation.start).toFixed(3)} s</span></div>
            <label className="form-field"><span>Reviewer</span><input value={selectedAnnotation.reviewer} onChange={(event) => updateAnnotation(selectedAnnotation.id, { reviewer: event.target.value })} /></label>
            <label className="confidence-field"><span>Confidence <strong>{selectedAnnotation.confidence}%</strong></span><input type="range" min="0" max="100" value={selectedAnnotation.confidence} onChange={(event) => updateAnnotation(selectedAnnotation.id, { confidence: Number(event.target.value) }, false)} /></label>
            <label className="form-field"><span>Clinical / review note</span><textarea rows={4} placeholder="Evidence, uncertainty, or rationale…" value={selectedAnnotation.notes} onChange={(event) => updateAnnotation(selectedAnnotation.id, { notes: event.target.value }, false)} /></label>
            <div className="inspector-actions"><button className="button primary" onClick={() => {
              commitSelected();
              setShowAnnotationEditor(false);
            }}>{selectedAnnotation.status === "committed" ? "Save revision" : "Commit label"}</button><button className="icon-danger" onClick={() => {
              deleteAnnotation(selectedAnnotation.id);
              setShowAnnotationEditor(false);
            }} title="Delete annotation" aria-label="Delete annotation">🗑</button></div>
            <div className="snapshot-note"><span>DISPLAY SNAPSHOT</span><strong>{montage === "bipolar" ? "Bipolar" : montage === "average" ? "Average ref" : "Recorded ref"} · {filters.enabled ? `${filters.highPassHz}–${filters.lowPassHz} Hz · ${filters.notchHz} Hz notch` : "Raw"}</strong><small>Stored with the exported revision; raw samples remain unchanged.</small></div>
          </div>
        </div>
      </div>}

      {showSessionMap && <SessionMap
        meta={meta}
        annotations={annotations}
        tab={sessionMapTab}
        onTabChange={setSessionMapTab}
        issues={qcIssues}
        badChannels={badChannels}
        recoveryStatus={recoveryStatus}
        onClose={() => setShowSessionMap(false)}
        onOpenAnnotation={(item) => {
          setSelectedAnnotationId(item.id);
          jumpTo(item.start);
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
  tab,
  onTabChange,
  issues,
  badChannels,
  recoveryStatus,
  onClose,
  onOpenAnnotation,
}: {
  meta: RecordingMeta;
  annotations: Annotation[];
  tab: "map" | "qc";
  onTabChange: (tab: "map" | "qc") => void;
  issues: Array<{ level: "warning" | "info"; text: string; annotationId?: string }>;
  badChannels: Set<number>;
  recoveryStatus: "saved" | "error";
  onClose: () => void;
  onOpenAnnotation: (annotation: Annotation) => void;
}) {
  const [hovered, setHovered] = useState<{ kind: "annotation"; item: Annotation } | null>(null);
  const [selected, setSelected] = useState<{ kind: "annotation"; item: Annotation } | null>(null);
  const inspected = hovered ?? selected;
  const rows: Array<{ id: string; label: string; matches: (annotation: Annotation) => boolean }> = [
    { id: "session", label: "Entire-session context", matches: (item) => item.track === "context" && annotationGeometry(item) === "session" },
    { id: "context", label: "Context labels", matches: (item) => item.track === "context" && annotationGeometry(item) !== "session" },
    { id: "windowed", label: "ePhys window labels", matches: (item) => item.track === "windowed" },
    { id: "instance", label: "ePhys instance labels", matches: (item) => item.track === "instance" },
  ];
  return <div className="modal-backdrop map-backdrop"><div className="session-map-modal">
    <header><div><span className="modal-eyebrow">MODEL-READY SESSION MAP</span><h2>{patientLabel(meta)} <i>/</i> {recordingLabel(meta)}</h2><p>{meta.channelLabels.length} channels · {formatClock(meta.durationSec)} · {primarySampleRate(meta)} Hz</p></div><button onClick={onClose} aria-label="Close session map">×</button></header>
    <div className="session-map-tabs" role="tablist" aria-label="Session review views">
      <button role="tab" aria-selected={tab === "map"} className={tab === "map" ? "active" : ""} onClick={() => onTabChange("map")}>Session map</button>
      <button role="tab" aria-selected={tab === "qc"} className={tab === "qc" ? "active" : ""} onClick={() => onTabChange("qc")}>QC <span>{issues.length}</span></button>
    </div>
    {tab === "map" ? <div className="session-map-tab-panel" role="tabpanel">
      <div className="map-equation"><span>entire-session context</span><b>＋</b><span>context labels</span><b>＋</b><span>ePhys window labels</span><b>＋</b><span>ePhys instance labels</span><b>→</b><strong>training data</strong></div>
      <div className={`map-inspection ${inspected ? "active" : ""}`}>
      {inspected?.kind === "annotation" ? <>
        <i style={{ background: LABEL_BY_ID.get(inspected.item.labelId)?.color }} />
        <div><strong>{LABEL_BY_ID.get(inspected.item.labelId)?.name ?? inspected.item.labelId}</strong><span>{annotationGeometry(inspected.item) === "point" ? formatClock(inspected.item.start, true) : `${formatClock(inspected.item.start, true)} → ${formatClock(inspected.item.end, true)}`} · {inspected.item.status} · {inspected.item.reviewer || "reviewer unset"}</span></div>
        <button onClick={() => onOpenAnnotation(inspected.item)}>Open in viewer</button>
      </> : <><div><strong>Explore the map</strong><span>Hover for details. Click an item to keep its details here.</span></div></>}
      </div>
      <div className="map-timeline">
      <div className="map-ruler">{[0, .25, .5, .75, 1].map((fraction) => <span key={fraction} style={{ left: `${fraction * 100}%` }}>{formatClock(meta.durationSec * fraction)}</span>)}</div>
      {rows.map((row) => {
        const rowAnnotations = annotations.filter(row.matches);
        const laneLayout = assignAnnotationLanes(rowAnnotations);
        const annotationLaneCount = Math.min(8, laneLayout.laneCount);
        const rowHeight = 12 + annotationLaneCount * 29;
        return <div className={`map-row ${row.id}`} key={row.id} style={{ minHeight: rowHeight }}><strong>{row.label}</strong><div style={{ minHeight: rowHeight }}>{rowAnnotations.map((item) => {
          const label = LABEL_BY_ID.get(item.labelId);
          if (!label) return null;
          const point = annotationGeometry(item) === "point";
          const payload = { kind: "annotation" as const, item };
          const lane = Math.min(laneLayout.lanes.get(item.id) ?? 0, annotationLaneCount - 1);
          return <button key={item.id} className={point ? "map-instance" : ""} aria-label={`${label.name} at ${formatClock(item.start, true)}`} title={`${label.name} · ${formatClock(item.start, true)}${point ? "" : `–${formatClock(item.end, true)}`}`} style={{ top: 6 + lane * 29, left: `${(item.start / meta.durationSec) * 100}%`, width: `${point ? .2 : Math.max(.35, ((item.end - item.start) / meta.durationSec) * 100)}%`, background: label.color }} onMouseEnter={() => setHovered(payload)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(payload)} onBlur={() => setHovered(null)} onClick={() => setSelected(payload)}>{point ? "" : label.short}</button>;
        })}</div></div>;
      })}
      </div>
    </div> : <div className="session-map-qc" role="tabpanel"><QcPanel issues={issues} annotations={annotations} badChannels={badChannels} meta={meta} recoveryStatus={recoveryStatus} onSelect={(id) => {
      const annotation = annotations.find((item) => item.id === id);
      if (annotation) onOpenAnnotation(annotation);
    }} /></div>}
    <footer>{tab === "map" ? <div className="geometry-legend"><span><i className="duration" />Duration</span><span><i className="point" />Single moment</span></div> : <span className="qc-footer-note">{issues.length ? `${issues.length} QC finding${issues.length === 1 ? "" : "s"}` : "All integrity checks passed"}</span>}<button className="button primary" onClick={onClose}>Return to review</button></footer>
  </div></div>;
}
