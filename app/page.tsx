"use client";

/**
 * Overview & Purpose
 * Owns the interactive NeuroTrace workstation and coordinates recording review,
 * annotation, local recovery, QC, session navigation, and export.
 *
 * Architectural Relationships
 * Called by: The root application route through app/layout.tsx.
 * Calls: Browser signal sources in eeg-core.ts plus display-processing and
 * source-integrity workers for CPU-heavy clinical preparation and hashing.
 *
 * External Resources
 * Browser File/Blob APIs, localStorage, Canvas 2D, and public/og.png via layout metadata.
 *
 * Notes
 * React owns UI state on the main thread. File reads are asynchronous and stale
 * display requests are discarded so an older window cannot replace a newer one.
 */


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
  anatomicalChannelGroup,
  buildMontage,
  clinicalDecimationFactor,
  confineTraceYToRow,
  detectEnvelopeSynchronizedFlatlines,
  detectRawSynchronizedFlatlines,
  formatClock,
  LEGACY_RAW_COUNTS_PER_ROW,
  makeId,
  orderAnatomicalChannelIndices,
  parseLegacyMatMetadata,
  type DisplayFilterSettings,
  type LegacyMatMetadata,
  type MontageMode,
  type RecordingMeta,
  type SignalSource,
} from "./eeg-core";
import { processDisplaySignalsOffThread } from "./display-processing-worker-client";
import { sha256Blob } from "./source-integrity";
import { verifySourceOffThread } from "./source-integrity-worker-client";

type Reliability = "gold" | "silver" | "bronze" | "gray";
type Geometry = "point" | "interval" | "window" | "session";
type TrackId = "context" | "windowed" | "instance";
type AnnotationStatus = "draft" | "committed" | "suggestion";
type AnnotationOrigin = "manual" | "imported" | "detector" | "legacy";
type PlacementIntent = "native" | "instance" | "windowed" | "context-instance" | "context-window";
type WindowTimeUnit = "ms" | "s" | "hr";
type AnnotationDragPatch = Pick<Annotation, "start" | "end" | "track" | "geometry">;
type AnnotationSelectionBox = { left: number; top: number; width: number; height: number };
type InspectionBox = {
  start: number;
  end: number;
  startRow: number;
  endRow: number;
  top: number;
  bottom: number;
  channelLabels: string[];
  sourceIndices: number[];
};
type WavePointerState = {
  pointerId: number;
  startX: number;
  startY: number;
  startTime: number;
  startRow: number;
  moved: boolean;
};

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
  confidence: number;
  uncertainty?: number;
  /** Optional MATLAB-review compatibility fields. */
  ictalChannels?: string;
  legacyConfidence?: "" | "1" | "2" | "3";
  reviewedAt?: string;
  reviewerInitials?: string;
  badChannels?: string;
};

type AnnotationHistorySnapshot = {
  annotations: Annotation[];
  candidates: Candidate[];
  activeCandidate: number;
};

type MatlabExportIdentity = {
  patientId: string;
  matPath: string;
  dataDirectory: string;
  datFile: string;
};

type RawDatMapping = {
  sampleRate: number;
  channelCount: number;
  /** Blank preserves the headerless file as raw ADC counts. */
  physicalScale: number | "";
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
  contentView: "recording" | "structure";
};

type ResourceCacheUsage = {
  rawBytes: number;
  rawEntries: number;
  processedBytes: number;
  processedEntries: number;
  envelopeBytes: number;
  envelopeEntries: number;
};

type BrowserResourceUsage = {
  heapUsedBytes: number | null;
  heapAllocatedBytes: number | null;
  heapLimitBytes: number | null;
  storageUsedBytes: number | null;
  storageQuotaBytes: number | null;
};

type PerformanceWithMemory = Performance & {
  memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
};

type DisplayWindow = {
  data: Float32Array[];
  /** Exact source extrema retained per display-time bucket for overview drawing. */
  envelopes: Array<{
    minima: Float32Array;
    maxima: Float32Array;
    gaps: Uint8Array;
    startSec: number;
    bucketDurationSec: number;
  } | null>;
  labels: string[];
  sampleRates: number[];
  sourceSampleRates: number[];
  /** Absolute time represented by sample zero for each displayed row. */
  startSecs: number[];
  units: string[];
  sourceIndices: number[][];
  primarySourceIndices: number[];
  warnings: string[];
  viewStart: number;
  flatlineRegions: Array<{ startSec: number; endSec: number }>;
};

type RawWindowCache = {
  source: SignalSource;
  channelKey: string;
  startSec: number;
  endSec: number;
  data: Float32Array[];
  sampleRates: number[];
  channelStartSecs: number[];
  channelUnits: string[];
  byteLength: number;
  flatlineRegions: Array<{ startSec: number; endSec: number }>;
};

type ProcessedWindowCache = {
  raw: RawWindowCache;
  settingsKey: string;
  data: Float32Array[];
  sampleRates: number[];
  channelStartSecs: number[];
  factors: Array<1 | 2>;
  byteLength: number;
};

type EnvelopeWindowCache = {
  source: SignalSource;
  channelKey: string;
  startSec: number;
  endSec: number;
  data: Float32Array[];
  minima: Float32Array[];
  maxima: Float32Array[];
  gaps: Uint8Array[];
  bucketDurationSec: number;
  channelUnits: string[];
  byteLength: number;
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
  undo: AnnotationHistorySnapshot[];
  redo: AnnotationHistorySnapshot[];
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
const ANATOMICAL_GROUP_GAP_ROWS = 4;
const LEGACY_SEIZURE_EVENT_TERMS = ["sz", "seiz", "tonic", "eeg onset", "ictal"] as const;
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

function isLegacySeizureCandidate(label: string) {
  const normalized = label.trim().toLowerCase();
  return LEGACY_SEIZURE_EVENT_TERMS.some((term) => normalized.includes(term));
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
      ictalChannels: typeof candidate.ictalChannels === "string" ? candidate.ictalChannels : "",
      legacyConfidence: ["1", "2", "3"].includes(candidate.legacyConfidence ?? "")
        ? candidate.legacyConfidence
        : "",
      reviewedAt: typeof candidate.reviewedAt === "string" ? candidate.reviewedAt : undefined,
      reviewerInitials: typeof candidate.reviewerInitials === "string" ? candidate.reviewerInitials : "",
      badChannels: typeof candidate.badChannels === "string" ? normalizeChannelList(candidate.badChannels) : "",
      confidence: Math.round(clamp(
        Number.isFinite(candidate.confidence)
          ? candidate.confidence
          : Number.isFinite(candidate.uncertainty)
            ? 100 - Number(candidate.uncertainty)
            : 0,
        0,
        100,
      )),
    }];
  });
}

function reconcileCandidateQueue(imported: Candidate[], restored: Candidate[], restoredActiveCandidate: number) {
  const importedIds = new Set(imported.map((candidate) => candidate.id));
  const restoredTerminalDecisions = restored.filter((candidate) =>
    ["reviewed", "skipped", "conflict"].includes(candidate.status) && !importedIds.has(candidate.id));
  const merged = [...imported.map((candidate) => {
    const prior = restored.find((item) => item.id === candidate.id);
    return prior ? {
      ...candidate,
      status: prior.status,
      confidence: prior.confidence,
      ictalChannels: prior.ictalChannels ?? "",
      legacyConfidence: prior.legacyConfidence ?? "",
      reviewedAt: prior.reviewedAt,
      reviewerInitials: prior.reviewerInitials ?? "",
      badChannels: prior.badChannels ?? "",
    } : candidate;
  }), ...restoredTerminalDecisions]
    .sort((left, right) => left.time - right.time || left.id.localeCompare(right.id));
  const restoredActiveId = restored[restoredActiveCandidate]?.id
    ?? restored.find((item) => item.status === "active")?.id;
  let activeIndex = restoredActiveId
    ? merged.findIndex((item) => item.id === restoredActiveId && !["reviewed", "skipped", "conflict"].includes(item.status))
    : -1;
  if (activeIndex < 0) {
    activeIndex = merged.findIndex((item) => !["reviewed", "skipped", "conflict"].includes(item.status));
  }
  if (activeIndex < 0 && merged.length) activeIndex = clamp(restoredActiveCandidate, 0, merged.length - 1);
  return {
    candidates: merged.map((item, index) => {
      if (index === activeIndex && (item.status === "queued" || item.status === "active")) return { ...item, status: "active" as const };
      if (index !== activeIndex && item.status === "active") return { ...item, status: "queued" as const };
      return item;
    }),
    activeIndex: Math.max(0, activeIndex),
  };
}

type RecoveredProject = {
  annotations: Annotation[];
  candidates: Candidate[];
  activeCandidate: number;
  badChannels: number[];
  reviewer: string | null;
  recordingType: string | null;
  matlabExportIdentity: MatlabExportIdentity | null;
};

function hasValidRecoveryBounds(value: unknown, durationSec: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const annotation = value as Record<string, unknown>;
  if (typeof annotation.labelId !== "string" || !LABEL_BY_ID.has(annotation.labelId)) return false;
  if (typeof annotation.start !== "number" || !Number.isFinite(annotation.start)
    || typeof annotation.end !== "number" || !Number.isFinite(annotation.end)) return false;
  if (annotation.start < 0 || annotation.end > durationSec || annotation.end < annotation.start) return false;
  const rawGeometry = annotation.geometry ?? LABEL_BY_ID.get(annotation.labelId)?.geometry;
  if (rawGeometry !== "point" && rawGeometry !== "interval" && rawGeometry !== "window" && rawGeometry !== "session") return false;
  if (rawGeometry === "point") return annotation.start === annotation.end && annotation.start < durationSec;
  if (rawGeometry === "session") return annotation.start === 0 && annotation.end === durationSec;
  return annotation.end > annotation.start;
}

function parseRecoveryDraft(raw: string, durationSec: number, channelCount: number): Annotation[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Draft labels are not a list");
  if (parsed.some((annotation) => !hasValidRecoveryBounds(annotation, durationSec))) throw new Error("Draft label bounds failed validation");
  const annotations = migrateAnnotationList(parsed, durationSec, channelCount);
  if (annotations.length !== parsed.length) throw new Error("Draft labels failed validation");
  return annotations;
}

function parseRecoveryProject(raw: string, durationSec: number, channelCount: number): RecoveredProject {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Project is not an object");
  const project = parsed as Record<string, unknown>;
  if (project.version !== 2) throw new Error("Project version is unsupported");
  if (!Array.isArray(project.annotations)) throw new Error("Project labels are missing");
  if (project.annotations.some((annotation) => !hasValidRecoveryBounds(annotation, durationSec))) throw new Error("Project label bounds failed validation");
  const annotations = migrateAnnotationList(project.annotations, durationSec, channelCount);
  if (annotations.length !== project.annotations.length) throw new Error("Project labels failed validation");

  if (project.candidates !== undefined && !Array.isArray(project.candidates)) throw new Error("Project events are invalid");
  const rawCandidates: unknown[] = Array.isArray(project.candidates) ? project.candidates : [];
  const candidates = migrateCandidateList(rawCandidates, durationSec);
  if (candidates.length !== rawCandidates.length) throw new Error("Project events failed validation");

  if (project.badChannels !== undefined && !Array.isArray(project.badChannels)) throw new Error("Project channel exclusions are invalid");
  const rawBadChannels: unknown[] = Array.isArray(project.badChannels) ? project.badChannels : [];
  const badChannels = rawBadChannels.filter((index): index is number => typeof index === "number" && Number.isInteger(index) && index >= 0 && index < channelCount);
  if (badChannels.length !== rawBadChannels.length) throw new Error("Project channel exclusions failed validation");

  const activeCandidate = project.activeCandidate === undefined ? 0 : Number(project.activeCandidate);
  if (!Number.isInteger(activeCandidate) || activeCandidate < 0
    || (candidates.length > 0 && activeCandidate >= candidates.length)
    || (candidates.length === 0 && activeCandidate !== 0)) {
    throw new Error("Project event position is invalid");
  }
  if (project.reviewer !== undefined && typeof project.reviewer !== "string") throw new Error("Project reviewer is invalid");
  if (project.recordingType !== undefined && typeof project.recordingType !== "string") throw new Error("Project recording type is invalid");
  if (project.matlabExportIdentity !== undefined && (
    !project.matlabExportIdentity
    || typeof project.matlabExportIdentity !== "object"
    || Array.isArray(project.matlabExportIdentity)
  )) throw new Error("Project MATLAB export identity is invalid");
  const rawMatlabExportIdentity = project.matlabExportIdentity as Record<string, unknown> | undefined;
  if (rawMatlabExportIdentity && ["patientId", "matPath", "dataDirectory", "datFile"].some((key) =>
    rawMatlabExportIdentity[key] !== undefined && typeof rawMatlabExportIdentity[key] !== "string")) {
    throw new Error("Project MATLAB export identity fields are invalid");
  }

  return {
    annotations,
    candidates,
    activeCandidate: candidates.length ? activeCandidate : 0,
    badChannels,
    reviewer: typeof project.reviewer === "string" ? project.reviewer : null,
    recordingType: typeof project.recordingType === "string" ? project.recordingType : null,
    matlabExportIdentity: rawMatlabExportIdentity ? {
      patientId: typeof rawMatlabExportIdentity.patientId === "string" ? rawMatlabExportIdentity.patientId : "",
      matPath: typeof rawMatlabExportIdentity.matPath === "string" ? rawMatlabExportIdentity.matPath : "",
      dataDirectory: typeof rawMatlabExportIdentity.dataDirectory === "string" ? rawMatlabExportIdentity.dataDirectory : "",
      datFile: typeof rawMatlabExportIdentity.datFile === "string" ? rawMatlabExportIdentity.datFile : "",
    } : null,
  };
}

const DEFAULT_FILTERS: DisplayFilterSettings = {
  highPassHz: 0,
  lowPassHz: 200,
  notchHz: 0,
  enabled: false,
};

const EMPTY_DISPLAY: DisplayWindow = {
  data: [],
  envelopes: [],
  labels: [],
  sampleRates: [],
  sourceSampleRates: [],
  startSecs: [],
  units: [],
  sourceIndices: [],
  primarySourceIndices: [],
  warnings: [],
  viewStart: 0,
  flatlineRegions: [],
};

const RAW_WINDOW_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;
const ENVELOPE_CACHE_BUDGET_BYTES = 32 * 1024 * 1024;
const SOURCE_READ_AHEAD_BUDGET_BYTES = 96 * 1024 * 1024;
const TOTAL_SIGNAL_CACHE_BUDGET_BYTES = RAW_WINDOW_CACHE_BUDGET_BYTES * 2 + ENVELOPE_CACHE_BUDGET_BYTES;
const MIN_WAVEFORM_WIDTH_FOR_ENVELOPE = 64;
const CANVAS_PIXEL_BUDGET = 8_000_000;
const WINDOW_TIME_UNITS: WindowTimeUnit[] = ["ms", "s", "hr"];
const WINDOW_UNIT_SECONDS: Record<WindowTimeUnit, number> = { ms: .001, s: 1, hr: 3_600 };
const MIN_WINDOW_AMOUNT = .001;
const MIN_TIME_WINDOW_SECONDS = MIN_WINDOW_AMOUNT * WINDOW_UNIT_SECONDS.ms;

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

function formatWindowAmount(value: number) {
  if (!Number.isFinite(value)) return "";
  return Number(value.toPrecision(9)).toString();
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

function formatAmplitude(value: number, unit = "µV") {
  if (!Number.isFinite(value)) return `— ${unit}`;
  const abs = Math.abs(value);
  if (unit === "µV" && abs >= 1000) return `${(value / 1000).toFixed(2)} mV`;
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${unit || "a.u."}`;
}

function formatRelativeTime(value: number) {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < .0005) return "0.000 s";
  return `${value > 0 ? "+" : "−"}${Math.abs(value).toFixed(3)} s`;
}

function normalizeChannelList(value: string) {
  return value
    .split(/[,;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join(",");
}

function formatMatlabTimestamp(value: string | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function portablePathParts(value: string) {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const parts = normalized.split("/").filter(Boolean);
  return {
    path: normalized,
    directory: parts.slice(0, -1).join("/"),
    fileName: parts.at(-1) ?? "",
    topDirectory: parts.length > 1 ? parts[0] : "",
  };
}

function sourceIdentityInterpretation(interpretation: Record<string, unknown> | undefined) {
  if (!interpretation) return undefined;
  const exportOnlyKeys = new Set([
    "patient_id_hint",
    "companion_mat_name",
    "companion_mat_path",
    "dat_file_name",
    "dat_file_base",
    "data_dir_hint",
    "display_amplitude_mode",
  ]);
  return Object.fromEntries(Object.entries(interpretation).filter(([key]) => !exportOnlyKeys.has(key)));
}

function matlabExportIdentityFromInterpretation(interpretation: Record<string, unknown> | null | undefined): MatlabExportIdentity | null {
  if (interpretation?.kind !== "raw-int16-le") return null;
  const stringValue = (key: string) => typeof interpretation[key] === "string" ? interpretation[key] as string : "";
  return {
    patientId: stringValue("patient_id_hint"),
    matPath: stringValue("companion_mat_path") || stringValue("companion_mat_name"),
    dataDirectory: stringValue("data_dir_hint"),
    datFile: stringValue("dat_file_base") || stringValue("dat_file_name").replace(/\.dat$/i, ""),
  };
}

function applyMatlabExportIdentity(
  interpretation: Record<string, unknown> | undefined,
  identity: MatlabExportIdentity | null,
): Record<string, unknown> | undefined {
  if (!interpretation || !identity || interpretation.kind !== "raw-int16-le") return interpretation;
  return {
    ...interpretation,
    patient_id_hint: identity.patientId || null,
    companion_mat_path: identity.matPath || null,
    data_dir_hint: identity.dataDirectory || null,
    dat_file_base: identity.datFile || null,
  };
}

type ChannelRowLayout = {
  rowStartUnits: number[];
  totalUnits: number;
  groupStarts: Set<number>;
};

function buildChannelRowLayout(labels: readonly string[], anatomicalSpacing: boolean): ChannelRowLayout {
  const rowStartUnits: number[] = [];
  const groupStarts = new Set<number>();
  let units = 0;
  let previousGroup: string | null = null;
  labels.forEach((label, index) => {
    const group = anatomicalSpacing ? anatomicalChannelGroup(label) : null;
    if (index > 0 && group && previousGroup && group !== previousGroup) {
      units += ANATOMICAL_GROUP_GAP_ROWS;
      groupStarts.add(index);
    }
    rowStartUnits.push(units);
    units += 1;
    previousGroup = group;
  });
  return { rowStartUnits, totalUnits: Math.max(1, units), groupStarts };
}

function channelRowFromFraction(layout: ChannelRowLayout, fraction: number) {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) return null;
  const unit = fraction * layout.totalUnits;
  const row = layout.rowStartUnits.findIndex((start) => unit >= start && unit < start + 1);
  return row >= 0 ? row : null;
}

function robustTraceBaseline(values: Float32Array, maximumSamples = 257) {
  if (!values.length) return 0;
  const sampled: number[] = [];
  let finiteCount = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) continue;
    finiteCount += 1;
    if (sampled.length < maximumSamples) {
      sampled.push(value);
      continue;
    }
    // Deterministic reservoir sampling keeps the median representative while
    // guaranteeing that a short finite island in otherwise missing data is
    // never skipped by a fixed-position stride.
    const candidate = ((Math.imul(finiteCount, 0x9e3779b1) >>> 0) % finiteCount);
    if (candidate < maximumSamples) sampled[candidate] = value;
  }
  return medianSampledValues(sampled);
}

function medianSampledValues(sampled: number[]) {
  if (!sampled.length) return 0;
  sampled.sort((left, right) => left - right);
  const middle = Math.floor(sampled.length / 2);
  return sampled.length % 2 ? sampled[middle] : (sampled[middle - 1] + sampled[middle]) / 2;
}

function boundedCanvasScale(width: number, height: number, requestedScale: number) {
  const safeArea = Math.max(1, width * height);
  return Math.min(Math.max(0.1, requestedScale), 2, Math.sqrt(CANVAS_PIXEL_BUDGET / safeArea));
}

function sourceRateForDisplayRow(display: DisplayWindow, meta: RecordingMeta, row: number) {
  return display.sourceSampleRates[row]
    ?? meta.sampleRates[display.primarySourceIndices[row]]
    ?? display.sampleRates[row]
    ?? primarySampleRate(meta);
}

function sampleIndexForDisplayRow(display: DisplayWindow, row: number, timeSec: number) {
  const values = display.data[row];
  if (!values?.length) return 0;
  const envelope = display.envelopes[row];
  if (envelope && envelope.bucketDurationSec > 0) {
    return clamp(
      Math.floor((timeSec - envelope.startSec) / envelope.bucketDurationSec),
      0,
      values.length - 1,
    );
  }
  const sampleRate = display.sampleRates[row];
  const startSec = display.startSecs[row] ?? display.viewStart;
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) return 0;
  return clamp(Math.round((timeSec - startSec) * sampleRate), 0, values.length - 1);
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

function blankSessionSnapshot(source: SignalSource, id: string): SessionWorkspaceSnapshot {
  return {
    hasRecording: false,
    source,
    meta: sourceMeta(source),
    sessionKey: `blank-${id}`,
    recordingType: "Scalp EEG",
    reviewer: "",
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

function formatByteCount(bytes: number | null | undefined) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "Unavailable";
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function usagePercent(used: number | null, limit: number | null) {
  if (used === null || limit === null || !(limit > 0)) return 0;
  return clamp((used / limit) * 100, 0, 100);
}

function sourceReadProfile(format: RecordingMeta["format"], hasRecording: boolean) {
  if (!hasRecording) {
    return {
      origin: "No recording loaded",
      access: "Waiting for a local file",
      detail: "Signal reads begin after an EDF, MAT, or MAT + DAT recording is selected.",
    };
  }
  if (format === "edf" || format === "edf+") {
    return {
      origin: "Local browser file",
      access: "On-demand EDF record slices",
      detail: "Only the visible window and bounded read-ahead regions are read from the selected file.",
    };
  }
  if (format === "raw-int16-le") {
    return {
      origin: "Local browser file",
      access: "On-demand DAT frame slices",
      detail: "Sample frames are read from the selected binary file as each visible window is requested.",
    };
  }
  if (format === "mat-v5") {
    return {
      origin: "Local browser file",
      access: "Decoded signal matrix in memory",
      detail: "The selected MATLAB matrix is decoded once, then visible windows are read from browser memory.",
    };
  }
  return {
    origin: "Generated in this browser",
    access: "Deterministic synthetic signal",
    detail: "Demo samples are generated for the requested window without reading a recording file.",
  };
}

function estimatedDecodedSourceBytes(meta: RecordingMeta) {
  if (meta.format !== "mat-v5") return 0;
  return meta.sampleRates.reduce((sum, sampleRate) => sum + Math.ceil(meta.durationSec * sampleRate) * Float32Array.BYTES_PER_ELEMENT, 0);
}

export default function Home() {
  const demoSource = useMemo(() => {
    return new DemoSource({ name: "blank-session", durationSec: 1, sampleRate: 256 });
  }, []);
  const sourceRef = useRef<SignalSource>(demoSource);
  const sessionSnapshotsRef = useRef<Map<string, SessionWorkspaceSnapshot>>(new Map());
  const activeSessionIdRef = useRef("initial-session");
  const importBusyRef = useRef(false);
  const sourceVerificationRef = useRef(false);
  const sourceVerificationAbortRef = useRef<AbortController | null>(null);
  const flushSessionRef = useRef<() => void>(() => {});
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const waveformScrollRef = useRef<HTMLDivElement>(null);
  const overviewRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const waveDrawRef = useRef<() => void>(() => {});
  const viewerWheelRef = useRef<(event: WheelEvent) => void>(() => {});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const annotationsRef = useRef<Annotation[]>([]);
  const candidatesRef = useRef<Candidate[]>([]);
  const activeCandidateIndexRef = useRef(0);
  const undoRef = useRef<AnnotationHistorySnapshot[]>([]);
  const redoRef = useRef<AnnotationHistorySnapshot[]>([]);
  const pointerRef = useRef<WavePointerState | null>(null);
  const wheelFrameRef = useRef<number | null>(null);
  const zoomWheelFrameRef = useRef<number | null>(null);
  const channelScrollFrameRef = useRef<number | null>(null);
  const wheelDeltaRef = useRef(0);
  const wheelWidthRef = useRef(1);
  const zoomWheelDeltaRef = useRef(0);
  const zoomWheelAnchorRef = useRef(0);
  const displayRequestIdRef = useRef(0);
  const displayAppliedRequestIdRef = useRef(0);
  const displayAbortRef = useRef<AbortController | null>(null);
  const displayRefreshPendingRef = useRef<(() => Promise<void>) | null>(null);
  const displayRefreshActiveRef = useRef(false);
  const rawWindowCacheRef = useRef<RawWindowCache[]>([]);
  const processedWindowCacheRef = useRef<ProcessedWindowCache[]>([]);
  const envelopeWindowCacheRef = useRef<EnvelopeWindowCache[]>([]);
  const cursorFrameRef = useRef<number | null>(null);
  const pendingCursorRef = useRef<{
    time: number;
    row: number;
    amplitude: number;
    selection?: { start: number; end: number };
    inspectionBox?: InspectionBox;
  } | null>(null);
  const contextResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const sessionQueueResizeRef = useRef<{ startY: number; startHeight: number; availableHeight: number } | null>(null);
  const sessionLabelsSectionRef = useRef<HTMLElement>(null);
  const queueSectionRef = useRef<HTMLElement>(null);
  const dragFrameRef = useRef<number | null>(null);
  const pendingAnnotationDragRef = useRef<Record<string, AnnotationDragPatch> | null>(null);
  const dragAnnotationRef = useRef<{
    id: string;
    mode: "move" | "start" | "end";
    originX: number;
    original: Annotation;
    originals: Annotation[];
    snapshot: Annotation[];
    moved: boolean;
  } | null>(null);
  const annotationSelectionRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    selectedIds: Set<string>;
  } | null>(null);
  const readResourceCacheUsage = useCallback((): ResourceCacheUsage => ({
    rawBytes: rawWindowCacheRef.current.reduce((sum, entry) => sum + entry.byteLength, 0),
    rawEntries: rawWindowCacheRef.current.length,
    processedBytes: processedWindowCacheRef.current.reduce((sum, entry) => sum + entry.byteLength, 0),
    processedEntries: processedWindowCacheRef.current.length,
    envelopeBytes: envelopeWindowCacheRef.current.reduce((sum, entry) => sum + entry.byteLength, 0),
    envelopeEntries: envelopeWindowCacheRef.current.length,
  }), []);

  const [meta, setMeta] = useState<RecordingMeta>(() => sourceMeta(demoSource));
  const [hasRecording, setHasRecording] = useState(false);
  const [sessionTabs, setSessionTabs] = useState<SessionTab[]>([
    { id: "initial-session", title: "Session 1", hasRecording: false, recoveryStatus: "saved", contentView: "recording" },
  ]);
  const [activeSessionId, setActiveSessionId] = useState("initial-session");
  const activeSessionContentView = sessionTabs.find((tab) => tab.id === activeSessionId)?.contentView ?? "recording";
  const [sessionKey, setSessionKey] = useState("blank-initial-session");
  const [recordingType, setRecordingType] = useState("Scalp EEG");
  const [viewStart, setViewStart] = useState(0);
  const [timebase, setTimebase] = useState(20);
  const [windowDraftUnit, setWindowDraftUnit] = useState<WindowTimeUnit>("s");
  const [windowDraftValue, setWindowDraftValue] = useState<string | null>(null);
  const [gain, setGain] = useState(1);
  const [montage, setMontage] = useState<MontageMode>("referential");
  const [filters, setFilters] = useState<DisplayFilterSettings>(DEFAULT_FILTERS);
  const [selectedChannels, setSelectedChannels] = useState<Set<number>>(() => new Set());
  const [badChannels, setBadChannels] = useState<Set<number>>(() => new Set());
  const [focusedChannel, setFocusedChannel] = useState(0);
  const [display, setDisplay] = useState<DisplayWindow>(EMPTY_DISPLAY);
  const [waveformWidth, setWaveformWidth] = useState(1);
  const [channelScrollOffset, setChannelScrollOffset] = useState(0);
  const [channelViewportHeight, setChannelViewportHeight] = useState(245);
  const [loadingSignal, setLoadingSignal] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationDragPreview, setAnnotationDragPreview] = useState<{ patches: Record<string, AnnotationDragPatch> } | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [selectedAnnotationIds, setSelectedAnnotationIds] = useState<Set<string>>(() => new Set());
  const [annotationSelectionBox, setAnnotationSelectionBox] = useState<AnnotationSelectionBox | null>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [inspectionRange, setInspectionRange] = useState<InspectionBox | null>(null);
  const [inspectionDragging, setInspectionDragging] = useState(false);
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
  const [verifyingSource, setVerifyingSource] = useState(false);
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
  const [rightPanelView, setRightPanelView] = useState<"labels" | "inspect" | "resources">("labels");
  const [lastRightPanelToolView, setLastRightPanelToolView] = useState<"labels" | "inspect">("labels");
  const [bottomTracksOpen, setBottomTracksOpen] = useState(true);
  const [contextTrackHeight, setContextTrackHeight] = useState(76);
  const [sessionLabelsHeight, setSessionLabelsHeight] = useState(145);
  const [pendingDat, setPendingDat] = useState<File | null>(null);
  const [pendingLegacyMatFile, setPendingLegacyMatFile] = useState<File | null>(null);
  const [pendingLegacyMeta, setPendingLegacyMeta] = useState<LegacyMatMetadata | null>(null);
  const [selectedLegacyEventIndices, setSelectedLegacyEventIndices] = useState<Set<number>>(new Set());
  const [datMapping, setDatMapping] = useState<RawDatMapping>({ sampleRate: 0, channelCount: 0, physicalScale: "" });
  const [legacyExportHints, setLegacyExportHints] = useState({ patientId: "", matPath: "", dataDirectory: "", datFile: "" });
  const [confirmCommit, setConfirmCommit] = useState<string[]>([]);
  const [commitAdvanceAfter, setCommitAdvanceAfter] = useState(false);
  const [reviewer, setReviewer] = useState("");
  const [sourceHash, setSourceHash] = useState("");
  const [rawSourceHash, setRawSourceHash] = useState("");
  const [sourceInterpretation, setSourceInterpretation] = useState<Record<string, unknown> | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<"saved" | "error">("saved");
  const [controlBindings, setControlBindings] = useState<ControlBindings>(DEFAULT_CONTROLS);

  const activeCandidateItem = candidates[activeCandidate] ?? null;
  const activeCandidateAnnotation = activeCandidateItem
    ? [...annotations].reverse().find((item) => item.candidateId === activeCandidateItem.id
      && item.labelId === "ictal"
      && (activeCandidateItem.status !== "reviewed" || item.status === "committed")) ?? null
    : null;
  const candidateDecisionLocked = activeCandidateItem
    ? ["reviewed", "skipped", "conflict"].includes(activeCandidateItem.status)
    : false;
  const activeMatlabExportIdentity = matlabExportIdentityFromInterpretation(sourceInterpretation);
  const effectivePatientLabel = activeMatlabExportIdentity?.patientId.trim() || patientLabel(meta);
  const pendingLegacyCandidateEvents = useMemo(() => (pendingLegacyMeta?.events ?? [])
    .map((event, sourceIndex) => ({ event, sourceIndex }))
    .filter(({ event }) => isLegacySeizureCandidate(event.label)), [pendingLegacyMeta]);
  const legacyAnatomicalLayout = meta.format === "raw-int16-le" && meta.channelLabels.length >= 100;
  const legacyRawCountDisplay = meta.format === "raw-int16-le"
    && sourceInterpretation?.display_amplitude_mode === "legacy-raw-counts";
  const datPhysicalScaleValid = datMapping.physicalScale === ""
    || (Number.isFinite(datMapping.physicalScale) && datMapping.physicalScale > 0);
  const channelRowLayout = useMemo(
    () => buildChannelRowLayout(display.labels, legacyAnatomicalLayout),
    [display.labels, legacyAnatomicalLayout],
  );
  const activeCandidateOnset = activeCandidateAnnotation?.start ?? markOnset;
  const activeCandidateOffset = activeCandidateAnnotation?.end ?? null;
  const selectedAnnotation = annotations.find((item) => item.id === selectedAnnotationId) ?? null;
  const selectedGeometry = selectedAnnotation ? annotationGeometry(selectedAnnotation) : null;
  const selectedCandidateDecisionLocked = Boolean(selectedAnnotation?.candidateId && selectedAnnotation.status === "committed");
  const instanceQueueEntries = useMemo(() => {
    const annotationEntries = annotations
      .filter((item) => item.track === "instance" || (item.track === "context" && annotationGeometry(item) !== "session"))
      .map((item) => ({
        kind: "annotation" as const,
        id: item.id,
        time: item.start,
        label: LABEL_BY_ID.get(item.labelId)?.name ?? item.labelId,
        detail: item.track === "context" ? "Context event" : "Instance label",
        status: item.status,
        confidence: Math.round(clamp(item.confidence, 0, 100)),
        locked: Boolean(item.candidateId && item.status === "committed"),
      }));
    const candidateEntries = candidates
      .map((item) => ({
        kind: "candidate" as const,
        id: item.id,
        time: item.time,
        label: item.label,
        detail: "File event",
        status: item.status,
        confidence: item.confidence,
        locked: ["reviewed", "skipped", "conflict"].includes(item.status),
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
  const sourceHashDisplay = verifyingSource
    ? "Verifying…"
    : sourceHash.startsWith("demo:")
    ? sourceHash
    : `${sourceHash.slice(0, 8)}…${sourceHash.slice(-4)}`;
  const reviewReady = hasRecording && !verifyingSource;

  const cancelSourceVerification = useCallback(() => {
    const controller = sourceVerificationAbortRef.current;
    if (!controller) return;
    controller.abort(new DOMException("Source verification canceled", "AbortError"));
    setToast("Canceling source verification…");
  }, []);

  useLayoutEffect(() => {
    annotationsRef.current = annotations;
  }, [annotations]);

  useLayoutEffect(() => {
    candidatesRef.current = candidates;
    activeCandidateIndexRef.current = activeCandidate;
  }, [activeCandidate, candidates]);

  useLayoutEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    try {
      const savedControls = localStorage.getItem("neurotrace:controls");
      if (savedControls) {
        const parsed = JSON.parse(savedControls) as Partial<ControlBindings>;
        // Browser-local key bindings are external preferences restored once after hydration.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setControlBindings({
          ...DEFAULT_CONTROLS,
          ...Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string" && /^[a-z]$/i.test(value as string))),
        });
      }
    } catch { /* local preferences are optional */ }
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const resize = sessionQueueResizeRef.current;
      if (!resize) return;
      setSessionLabelsHeight(clamp(
        resize.startHeight + (event.clientY - resize.startY),
        105,
        Math.max(105, resize.availableHeight - 155),
      ));
    };
    const onUp = () => {
      sessionQueueResizeRef.current = null;
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

  useEffect(() => {
    try {
      localStorage.setItem("neurotrace:controls", JSON.stringify(controlBindings));
    } catch { /* local preferences are optional */ }
  }, [controlBindings]);

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
    if (snapshot.hasRecording && !sourceVerificationRef.current) {
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
          matlabExportIdentity: matlabExportIdentityFromInterpretation(snapshot.sourceInterpretation),
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

  useEffect(() => () => {
    sourceVerificationAbortRef.current?.abort();
    displayAbortRef.current?.abort();
  }, []);

  const applySessionSnapshot = useCallback((snapshot: SessionWorkspaceSnapshot) => {
    if (wheelFrameRef.current !== null) window.cancelAnimationFrame(wheelFrameRef.current);
    if (zoomWheelFrameRef.current !== null) window.cancelAnimationFrame(zoomWheelFrameRef.current);
    if (channelScrollFrameRef.current !== null) window.cancelAnimationFrame(channelScrollFrameRef.current);
    if (cursorFrameRef.current !== null) window.cancelAnimationFrame(cursorFrameRef.current);
    if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
    wheelFrameRef.current = null;
    zoomWheelFrameRef.current = null;
    channelScrollFrameRef.current = null;
    cursorFrameRef.current = null;
    dragFrameRef.current = null;
    wheelDeltaRef.current = 0;
    zoomWheelDeltaRef.current = 0;
    setChannelScrollOffset(0);
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
    setWindowDraftUnit("s");
    setWindowDraftValue(null);
    setGain(snapshot.gain);
    setMontage(snapshot.montage);
    setFilters({ ...snapshot.filters });
    setSelectedChannels(new Set(snapshot.selectedChannels));
    setBadChannels(new Set(snapshot.badChannels));
    setFocusedChannel(snapshot.focusedChannel);
    rawWindowCacheRef.current = [];
    processedWindowCacheRef.current = [];
    envelopeWindowCacheRef.current = [];
    setDisplay(EMPTY_DISPLAY);
    setAnnotations(snapshot.annotations);
    setSelectedAnnotationId(snapshot.selectedAnnotationId);
    setSelectedAnnotationIds(snapshot.selectedAnnotationId ? new Set([snapshot.selectedAnnotationId]) : new Set());
    setSelection(snapshot.selection);
    setInspectionRange(null);
    setInspectionDragging(false);
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
    setAnnotationSelectionBox(null);
    annotationSelectionRef.current = null;
    dragAnnotationRef.current = null;
    pendingAnnotationDragRef.current = null;
    setPendingDat(null);
    setPendingLegacyMatFile(null);
    setPendingLegacyMeta(null);
    setSelectedLegacyEventIndices(new Set());
    setDatMapping({ sampleRate: 0, channelCount: 0, physicalScale: "" });
    setLegacyExportHints({ patientId: "", matPath: "", dataDirectory: "", datFile: "" });
    setShowImport(false);
    setShowFilters(false);
    setConfirmCommit([]);
    setCommitAdvanceAfter(false);
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
    const snapshot = blankSessionSnapshot(demoSource, id);
    sessionSnapshotsRef.current.set(id, snapshot);
    setSessionTabs((current) => [...current, { id, title: `Session ${nextNumber}`, hasRecording: false, recoveryStatus: "saved", contentView: "recording" }]);
    setActiveSessionId(id);
    applySessionSnapshot(snapshot);
    setToast("Blank session ready — load a recording");
  }, [applySessionSnapshot, demoSource, importBusy, sessionTabs.length, storeActiveSession]);

  const closeSession = useCallback((id: string) => {
    if (importBusy) return;
    if (id === activeSessionId) storeActiveSession();
    const closingSnapshot = sessionSnapshotsRef.current.get(id);
    if (closingSnapshot?.hasRecording && closingSnapshot.recoveryStatus === "error") {
      setToast("This session could not be saved locally — export it before closing the tab");
      return;
    }
    const closingIndex = sessionTabs.findIndex((tab) => tab.id === id);
    let remaining = sessionTabs.filter((tab) => tab.id !== id);
    sessionSnapshotsRef.current.delete(id);
    if (remaining.length === 0) {
      const replacementId = makeId("session");
      const replacementSnapshot = blankSessionSnapshot(demoSource, replacementId);
      sessionSnapshotsRef.current.set(replacementId, replacementSnapshot);
      remaining = [{ id: replacementId, title: "Session 1", hasRecording: false, recoveryStatus: "saved", contentView: "recording" }];
    }
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
  }, [activeSessionId, applySessionSnapshot, demoSource, importBusy, sessionTabs, storeActiveSession]);

  const toggleSessionContentView = useCallback((id: string) => {
    if (importBusy) return;
    const target = sessionTabs.find((tab) => tab.id === id);
    const targetHasRecording = target && (id === activeSessionId ? hasRecording : target.hasRecording);
    if (!target || !targetHasRecording) return;
    const nextView = target.contentView === "structure" ? "recording" : "structure";
    if (id !== activeSessionId) switchSession(id);
    setSessionTabs((current) => current.map((tab) => tab.id === id ? { ...tab, contentView: nextView } : tab));
    if (nextView === "structure") {
      setPlaying(false);
      setShowFilters(false);
      setToast("File structure analysis opened");
    } else {
      setToast("Recording display restored");
    }
  }, [activeSessionId, hasRecording, importBusy, sessionTabs, switchSession]);

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
    const maximumWindow = Math.max(Number.EPSILON, meta.durationSec);
    const next = clamp(requested, Math.min(MIN_TIME_WINDOW_SECONDS, maximumWindow), maximumWindow);
    const anchor = clamp(anchorTime, viewStart, viewStart + timebase);
    const anchorRatio = timebase > 0 ? (anchor - viewStart) / timebase : 0.5;
    setViewStart(clamp(anchor - anchorRatio * next, 0, Math.max(0, meta.durationSec - next)));
    setTimebase(next);
  }, [meta.durationSec, timebase, viewStart]);

  const zoomToTimeRange = useCallback((start: number, end: number) => {
    const rangeStart = clamp(Math.min(start, end), 0, meta.durationSec);
    const rangeEnd = clamp(Math.max(start, end), rangeStart, meta.durationSec);
    const selectedDuration = rangeEnd - rangeStart;
    const maximumWindow = Math.max(Number.EPSILON, meta.durationSec);
    const nextDuration = clamp(selectedDuration, Math.min(MIN_TIME_WINDOW_SECONDS, maximumWindow), maximumWindow);
    const center = (rangeStart + rangeEnd) / 2;
    setViewStart(clamp(center - nextDuration / 2, 0, Math.max(0, meta.durationSec - nextDuration)));
    setTimebase(nextDuration);
  }, [meta.durationSec]);

  const zoomTimeWindow = useCallback((direction: "in" | "out", anchorTime?: number) => {
    setTimeWindow(timebase * (direction === "in" ? 0.8 : 1.25), anchorTime);
  }, [setTimeWindow, timebase]);

  const windowUnitSeconds = WINDOW_UNIT_SECONDS[windowDraftUnit];
  const windowDraftDisplayValue = windowDraftValue ?? formatWindowAmount(timebase / windowUnitSeconds);
  const windowDraftMaximum = Math.max(Number.EPSILON, meta.durationSec / windowUnitSeconds);
  const windowDraftMinimum = Math.min(MIN_WINDOW_AMOUNT, windowDraftMaximum);
  const cycleWindowDraftUnit = () => {
    setWindowDraftValue((current) => current ?? formatWindowAmount(timebase / windowUnitSeconds));
    const currentIndex = WINDOW_TIME_UNITS.indexOf(windowDraftUnit);
    setWindowDraftUnit(WINDOW_TIME_UNITS[(currentIndex + 1) % WINDOW_TIME_UNITS.length]);
  };
  const adjustWindowDraft = (direction: -1 | 1) => {
    if (!hasRecording) return;
    const numericValue = Number(windowDraftDisplayValue);
    const currentValue = Number.isFinite(numericValue) && numericValue > 0
      ? numericValue
      : windowDraftMinimum;
    const decimalPlaces = windowDraftDisplayValue.includes(".")
      ? windowDraftDisplayValue.split(".")[1].length
      : 0;
    const step = 10 ** -decimalPlaces;
    setWindowDraftValue(formatWindowAmount(clamp(currentValue + direction * step, windowDraftMinimum, windowDraftMaximum)));
  };
  const syncWindowDraft = () => {
    if (!hasRecording) return;
    const numericValue = Number(windowDraftDisplayValue);
    if (!windowDraftDisplayValue.trim() || !Number.isFinite(numericValue) || numericValue <= 0) {
      setToast("Enter a valid positive window amount before syncing");
      return;
    }
    const maximumWindow = Math.max(Number.EPSILON, meta.durationSec);
    const minimumWindow = Math.min(MIN_WINDOW_AMOUNT * windowUnitSeconds, maximumWindow);
    const nextWindow = clamp(numericValue * windowUnitSeconds, minimumWindow, maximumWindow);
    setTimeWindow(nextWindow);
    setWindowDraftValue(null);
    setToast(`Window synced to ${formatWindowAmount(nextWindow / windowUnitSeconds)} ${windowDraftUnit}`);
  };

  const commitMutation = useCallback((mutator: (current: Annotation[]) => Annotation[]) => {
    if (sourceVerificationRef.current) {
      setToast("Source verification is still running — browsing is available, review edits unlock when it completes");
      return;
    }
    const current = annotationsRef.current;
    undoRef.current.push({
      annotations: current,
      candidates: candidatesRef.current,
      activeCandidate: activeCandidateIndexRef.current,
    });
    if (undoRef.current.length > 100) undoRef.current.shift();
    redoRef.current = [];
    const next = mutator(current);
    annotationsRef.current = next;
    setAnnotations(next);
  }, []);

  const undo = useCallback(() => {
    const previous = undoRef.current.pop();
    if (!previous) {
      setToast("Nothing to undo");
      return;
    }
    redoRef.current.push({
      annotations: annotationsRef.current,
      candidates: candidatesRef.current,
      activeCandidate: activeCandidateIndexRef.current,
    });
    annotationsRef.current = previous.annotations;
    candidatesRef.current = previous.candidates;
    activeCandidateIndexRef.current = previous.activeCandidate;
    setAnnotations(previous.annotations);
    setCandidates(previous.candidates);
    setActiveCandidate(previous.activeCandidate);
    setSelectedAnnotationId(null);
    setSelectedAnnotationIds(new Set());
    setToast("Last annotation change undone");
  }, []);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) {
      setToast("Nothing to redo");
      return;
    }
    undoRef.current.push({
      annotations: annotationsRef.current,
      candidates: candidatesRef.current,
      activeCandidate: activeCandidateIndexRef.current,
    });
    annotationsRef.current = next.annotations;
    candidatesRef.current = next.candidates;
    activeCandidateIndexRef.current = next.activeCandidate;
    setAnnotations(next.annotations);
    setCandidates(next.candidates);
    setActiveCandidate(next.activeCandidate);
    setSelectedAnnotationId(null);
    setSelectedAnnotationIds(new Set());
    setToast("Annotation change restored");
  }, []);

  const addAnnotation = useCallback((
    label: LabelDefinition,
    time: number,
    explicitEnd?: number,
    intent: PlacementIntent = "native",
    targetRow = focusedChannel,
  ) => {
    if (!hasRecording) {
      setToast("Load a recording before placing labels");
      return;
    }
    if (sourceVerificationRef.current) {
      setToast("Source verification is still running — review edits unlock when it completes");
      return;
    }
    const samplingRate = sourceRateForDisplayRow(display, meta, targetRow);
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
    const sourceIndices = display.sourceIndices[targetRow] ?? [];
    const primarySourceIndex = display.primarySourceIndices[targetRow];
    if (label.id === "spikes" && (primarySourceIndex === undefined || primarySourceIndex < 0 || sourceIndices.length === 0)) {
      setToast("Choose a visible source channel before placing an epileptiform spike");
      return;
    }
    const activeSourceCandidate = candidates[activeCandidate];
    const candidateMatches = label.id === "ictal"
      && geometry !== "session"
      && activeSourceCandidate
      && ["active", "queued"].includes(activeSourceCandidate.status)
      && (activeTool === "seizure"
        || (explicitEnd !== undefined
          ? activeSourceCandidate.time >= start && activeSourceCandidate.time <= end
          : Math.abs(activeSourceCandidate.time - start) <= 1));
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
        displayLabel: display.labels[targetRow] ?? `Display row ${targetRow + 1}`,
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
      const currentWithoutPreviousCandidateDraft = candidateMatches
        ? current.filter((item) => !(item.candidateId === activeSourceCandidate.id && item.labelId === "ictal" && item.status === "draft"))
        : current;
      if (!sleepOverlapCount) return [...currentWithoutPreviousCandidateDraft, next];
      const adjusted = currentWithoutPreviousCandidateDraft.flatMap((item) => {
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
    setSelectedAnnotationIds(new Set([next.id]));
    setCursorTime(next.start);
    setCursorLocked(true);
    setSelection(null);
    setToast(sleepOverlapCount
      ? `${label.name} applied to the selected window; overlapping sleep stages were trimmed`
      : geometry === "interval" && explicitEnd !== undefined
        ? `${label.name} applied to ${formatClock(next.start, true)}–${formatClock(next.end, true)} — draft`
        : `${label.name} placed at ${formatClock(next.start, true)} — draft`);
  }, [activeCandidate, activeTool, candidates, commitMutation, display, focusedChannel, hasRecording, meta, montage, reviewer, snapMode]);

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

  const reopenCandidateReviews = useCallback((candidateIds: ReadonlySet<string>) => {
    if (!candidateIds.size) return;
    setCandidates((items) => items.map((item, index) => candidateIds.has(item.id) && item.status === "reviewed"
      ? { ...item, status: index === activeCandidate ? "active" : "queued", reviewedAt: undefined }
      : item));
  }, [activeCandidate]);

  const updateAnnotation = useCallback((id: string, patch: Partial<Annotation>, withHistory = true, allowCandidateReopen = false) => {
    const previous = annotationsRef.current.find((item) => item.id === id);
    if (!previous) return false;
    if (previous.candidateId && previous.status === "committed" && !allowCandidateReopen) {
      setToast("This accepted source event is locked — use Revise marks in the source-event review bar first");
      return false;
    }
    const reopenedCandidateIds = new Set<string>();
    if (previous?.candidateId && previous.status === "committed" && patch.status !== "committed") {
      reopenedCandidateIds.add(previous.candidateId);
    }
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
    else {
      const next = apply(annotationsRef.current);
      annotationsRef.current = next;
      setAnnotations(next);
    }
    reopenCandidateReviews(reopenedCandidateIds);
    return true;
  }, [commitMutation, meta.durationSec, reopenCandidateReviews]);

  const updateQueueConfidence = useCallback((kind: "annotation" | "candidate", id: string, value: number) => {
    const confidence = Math.round(clamp(Number.isFinite(value) ? value : 0, 0, 100));
    if (kind === "annotation") {
      updateAnnotation(id, { confidence });
      return;
    }
    setCandidates((items) => items.map((item) => item.id === id && !["reviewed", "skipped", "conflict"].includes(item.status)
      ? { ...item, confidence }
      : item));
  }, [updateAnnotation]);

  const confirmAnnotationDeletion = useCallback((items: Annotation[]) => {
    const committedCount = items.filter((item) => item.status === "committed").length;
    if (!committedCount) return true;
    return window.confirm(committedCount === 1
      ? "Delete this committed label? Its saved revision will be removed from this session."
      : `Delete ${committedCount} committed labels? Their saved revisions will be removed from this session.`);
  }, []);

  const deleteAnnotation = useCallback((id: string) => {
    const removed = annotationsRef.current.find((item) => item.id === id);
    if (!removed) return false;
    if (removed.candidateId && removed.status === "committed") {
      setToast("Accepted source-event marks are locked — use Revise marks before deleting them");
      return false;
    }
    if (!confirmAnnotationDeletion([removed])) {
      setToast("Deletion canceled — the committed label is unchanged");
      return false;
    }
    commitMutation((current) => current.filter((item) => item.id !== id));
    if (removed?.candidateId) {
      const hasOtherCommittedLink = annotationsRef.current.some((item) => item.id !== id && item.candidateId === removed.candidateId && item.status === "committed");
      if (!hasOtherCommittedLink) {
        setCandidates((items) => items.map((item) => item.id === removed.candidateId && item.status === "reviewed" ? { ...item, status: "queued" } : item));
      }
    }
    setSelectedAnnotationId(null);
    setSelectedAnnotationIds(new Set());
    setToast("Annotation removed — undo is available");
    return true;
  }, [commitMutation, confirmAnnotationDeletion]);

  const deleteSelectedAnnotations = useCallback(() => {
    const ids = new Set(selectedAnnotationIds);
    if (!ids.size) return false;
    const removed = annotationsRef.current.filter((item) => ids.has(item.id));
    if (!removed.length) return false;
    if (removed.some((item) => item.candidateId && item.status === "committed")) {
      setToast("Accepted source-event marks are locked — use Revise marks before deleting them");
      return false;
    }
    if (!confirmAnnotationDeletion(removed)) {
      setToast("Deletion canceled — committed labels are unchanged");
      return false;
    }
    const remaining = annotationsRef.current.filter((item) => !ids.has(item.id));
    commitMutation(() => remaining);
    const candidateIds = new Set(removed.flatMap((item) => item.candidateId ? [item.candidateId] : []));
    if (candidateIds.size) {
      const stillCommitted = new Set(remaining.flatMap((item) => item.status === "committed" && item.candidateId ? [item.candidateId] : []));
      setCandidates((items) => items.map((item) => candidateIds.has(item.id) && !stillCommitted.has(item.id) && item.status === "reviewed"
        ? { ...item, status: "queued" }
        : item));
    }
    setSelectedAnnotationId(null);
    setSelectedAnnotationIds(new Set());
    setToast(`${removed.length} label${removed.length === 1 ? "" : "s"} removed — undo is available`);
    return true;
  }, [commitMutation, confirmAnnotationDeletion, selectedAnnotationIds]);

  const moveSelectedAnnotations = useCallback((direction: -1 | 1, accelerated = false) => {
    const ids = selectedAnnotationIds;
    const movable = annotationsRef.current.filter((item) => ids.has(item.id) && annotationGeometry(item) !== "session");
    if (!movable.length) return;
    if (movable.some((item) => item.candidateId && item.status === "committed")) {
      setToast("Accepted source-event marks are locked — reopen the decision before moving them");
      return;
    }
    const anchor = movable.find((item) => item.id === selectedAnnotationId) ?? movable[0];
    const sampleRate = anchor.channelScope
      ? meta.sampleRates[anchor.channelScope.primarySourceIndex] ?? primarySampleRate(meta)
      : sourceRateForDisplayRow(display, meta, focusedChannel);
    const baseStep = snapMode === "1s" ? 1 : snapMode === "100ms" ? 0.1 : 1 / Math.max(1, sampleRate);
    const requestedDelta = direction * baseStep * (accelerated ? 10 : 1);
    const earliest = Math.min(...movable.map((item) => item.start));
    const latest = Math.max(...movable.map((item) => item.end));
    const delta = clamp(requestedDelta, -earliest, meta.durationSec - latest);
    if (Math.abs(delta) < 1e-9) {
      setToast("Selected labels are already at the recording boundary");
      return;
    }
    const changedAt = new Date().toISOString();
    const reopenedCandidateIds = new Set(movable.flatMap((item) => item.candidateId && item.status === "committed" ? [item.candidateId] : []));
    commitMutation((current) => current.map((item) => ids.has(item.id) && annotationGeometry(item) !== "session"
      ? normalizeAnnotationGeometry({
        ...item,
        start: item.start + delta,
        end: item.end + delta,
        status: item.status === "committed" ? "draft" : item.status,
        revision: item.revision + 1,
        updatedAt: changedAt,
      }, meta.durationSec)
      : item));
    reopenCandidateReviews(reopenedCandidateIds);
    setToast(`${movable.length} selected label${movable.length === 1 ? "" : "s"} moved ${direction < 0 ? "left" : "right"}`);
  }, [commitMutation, display, focusedChannel, meta, reopenCandidateReviews, selectedAnnotationId, selectedAnnotationIds, snapMode]);

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
    for (const candidate of candidates) {
      if (candidate.status === "reviewed" && !annotations.some((item) => item.candidateId === candidate.id && item.labelId === "ictal" && item.status === "committed")) {
        issues.push({ level: "warning", text: `Reviewed source event ${candidate.label} has no committed ictal interval` });
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

  const advanceFromCandidate = useCallback((candidateId: string) => {
    const currentIndex = candidates.findIndex((item) => item.id === candidateId);
    const unresolved = (item: Candidate) => item.id !== candidateId && !["reviewed", "skipped", "conflict"].includes(item.status);
    let nextIndex = candidates.findIndex((item, index) => index > currentIndex && unresolved(item));
    if (nextIndex < 0) nextIndex = candidates.findIndex(unresolved);
    if (nextIndex < 0) return null;
    const next = candidates[nextIndex];
    setActiveCandidate(nextIndex);
    setCandidates((items) => items.map((item, index) => {
      if (index === nextIndex && (item.status === "queued" || item.status === "active")) return { ...item, status: "active" };
      if (index !== nextIndex && item.status === "active") return { ...item, status: "queued" };
      return item;
    }));
    setViewStart(clamp(next.time - timebase / 2, 0, Math.max(0, meta.durationSec - timebase)));
    setCursorTime(next.time);
    setCursorLocked(true);
    setSelection(null);
    setMarkOnset(null);
    setActiveTool("cursor");
    setSelectedAnnotationId(null);
    setSelectedAnnotationIds(new Set());
    return next;
  }, [candidates, meta.durationSec, timebase]);

  const commitAnnotation = useCallback((targetAnnotation: Annotation | null, force = false, advanceAfter = false) => {
    if (sourceVerificationRef.current) {
      setToast("Source verification must finish before a revision can be committed");
      return false;
    }
    if (!targetAnnotation) return false;
    const blockers: string[] = [];
    const advisories: string[] = [];
    const geometry = annotationGeometry(targetAnnotation);
    const commitReviewer = (targetAnnotation.candidateId ? reviewer : targetAnnotation.reviewer || reviewer).trim().toUpperCase();
    if (!Number.isFinite(targetAnnotation.start) || !Number.isFinite(targetAnnotation.end)) {
      blockers.push("Start and end times must be valid numbers.");
    } else {
      if (targetAnnotation.start < 0 || targetAnnotation.end > meta.durationSec) blockers.push("The label must stay inside the recording.");
      if (targetAnnotation.end < targetAnnotation.start) blockers.push("Offset must follow onset.");
      if (geometry !== "point" && targetAnnotation.end <= targetAnnotation.start) blockers.push("A timed label must have a duration greater than zero.");
      if (geometry === "point" && targetAnnotation.end !== targetAnnotation.start) blockers.push("A single-moment label must have matching start and end times.");
    }
    if (!commitReviewer) blockers.push("Reviewer initials are required before committing.");
    if (targetAnnotation.labelId === "spikes" && (
      !targetAnnotation.channelScope
      || !Number.isInteger(targetAnnotation.channelScope.primarySourceIndex)
      || targetAnnotation.channelScope.primarySourceIndex < 0
      || targetAnnotation.channelScope.primarySourceIndex >= meta.channelLabels.length
      || !targetAnnotation.channelScope.sourceIndices.length
      || targetAnnotation.channelScope.sourceIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= meta.channelLabels.length)
      || !targetAnnotation.channelScope.sourceIndices.includes(targetAnnotation.channelScope.primarySourceIndex)
    )) blockers.push("Epileptiform spikes require a valid source-channel scope.");
    if (blockers.length) {
      setConfirmCommit([]);
      setCommitAdvanceAfter(false);
      setToast(`Cannot commit: ${blockers[0]}`);
      return false;
    }
    if (targetAnnotation.labelId === "ictal" && targetAnnotation.end - targetAnnotation.start < 3) advisories.push("Ictal duration is under 3 seconds.");
    const duplicate = annotations.some((item) => item.id !== targetAnnotation.id
      && item.status === "committed"
      && item.labelId === "ictal"
      && targetAnnotation.labelId === "ictal"
      && Math.abs(item.start - targetAnnotation.start) < 30);
    if (duplicate) advisories.push("Another ictal onset exists within 30 seconds.");
    if (advisories.length && !force) {
      setConfirmCommit(advisories);
      setCommitAdvanceAfter(advanceAfter);
      setSelectedAnnotationId(targetAnnotation.id);
      setSelectedAnnotationIds(new Set([targetAnnotation.id]));
      return false;
    }
    const committedAt = new Date().toISOString();
    updateAnnotation(targetAnnotation.id, {
      status: "committed",
      reviewer: commitReviewer,
      revisions: [...(targetAnnotation.revisions ?? []), {
        revision: targetAnnotation.revision + 1,
        committedAt,
        labelId: targetAnnotation.labelId,
        start: targetAnnotation.start,
        end: targetAnnotation.end,
        confidence: targetAnnotation.confidence,
        reviewer: commitReviewer,
        notes: targetAnnotation.notes,
        reliability: targetAnnotation.reliability,
        origin: targetAnnotation.origin,
        geometry: annotationGeometry(targetAnnotation),
        track: targetAnnotation.track,
        channels: [...targetAnnotation.channels],
        channelScope: targetAnnotation.channelScope ? {
          ...targetAnnotation.channelScope,
          sourceIndices: [...targetAnnotation.channelScope.sourceIndices],
          sourceLabels: [...targetAnnotation.channelScope.sourceLabels],
        } : undefined,
        sourceHash,
        sourceContentHash: rawSourceHash,
        candidateId: targetAnnotation.candidateId,
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
    setCommitAdvanceAfter(false);
    if (targetAnnotation.candidateId) {
      const qualityBadChannels = normalizeChannelList([...badChannels]
        .sort((left, right) => left - right)
        .map((index) => meta.channelLabels[index] ?? `Ch ${index + 1}`)
        .join(","));
      setCandidates((items) => items.map((item) => item.id === targetAnnotation.candidateId
        ? {
          ...item,
          status: "reviewed",
          reviewedAt: committedAt,
          reviewerInitials: commitReviewer,
          badChannels: normalizeChannelList(item.badChannels || qualityBadChannels),
          ictalChannels: normalizeChannelList(item.ictalChannels ?? ""),
        }
        : item));
    }
    const next = advanceAfter && targetAnnotation.candidateId
      ? advanceFromCandidate(targetAnnotation.candidateId)
      : null;
    setToast(next
      ? `Saved by ${commitReviewer} · next event: ${next.label}`
      : `Revision committed by ${commitReviewer}`);
    return true;
  }, [advanceFromCandidate, annotations, badChannels, filters, gain, meta, montage, rawSourceHash, reviewer, selectedChannels, snapMode, sourceHash, sourceInterpretation, updateAnnotation]);

  const commitSelected = useCallback((force = false, advanceAfter = false) =>
    commitAnnotation(selectedAnnotation, force, advanceAfter), [commitAnnotation, selectedAnnotation]);

  useEffect(() => {
    if (!hasRecording || verifyingSource) return;
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
          matlabExportIdentity: matlabExportIdentityFromInterpretation(sourceInterpretation),
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
  }, [activeCandidate, activeSessionId, annotations, badChannels, candidates, hasRecording, recordingType, reviewer, sessionKey, sourceInterpretation, verifyingSource]);

  useEffect(() => {
    displayAbortRef.current?.abort();
    const abortController = new AbortController();
    displayAbortRef.current = abortController;
    const requestId = ++displayRequestIdRef.current;
    const source = sourceRef.current;
    const selectedIndices = [...selectedChannels].sort((a, b) => a - b);
    const indices = meta.format === "raw-int16-le" && meta.channelLabels.length >= 100
      ? orderAnatomicalChannelIndices(meta.channelLabels, selectedIndices)
      : selectedIndices;
    const channelKey = indices.join(",");
    const refreshWindow = async () => {
      if (!hasRecording || !indices.length) {
        displayAppliedRequestIdRef.current = requestId;
        setDisplay({ ...EMPTY_DISPLAY, viewStart });
        setLoadingSignal(false);
        return;
      }
      setLoadingSignal(true);
      try {
        const requiresClinicalPreparation = indices.some((index) => {
          const sampleRate = meta.sampleRates[index] ?? primarySampleRate(meta);
          return clinicalDecimationFactor(
            sampleRate,
            Math.max(0, Math.ceil(sampleRate * timebase)),
            Math.max(1, waveformWidth),
          ) === 2;
        });
        const useEnvelopePath = !filters.enabled
          && montage === "referential"
          && !spectrogramOpen
          && !requiresClinicalPreparation
          && waveformWidth >= MIN_WAVEFORM_WIDTH_FOR_ENVELOPE
          && typeof source.getEnvelopeWindow === "function"
          && indices.some((index) =>
            (meta.sampleRates[index] ?? primarySampleRate(meta)) * timebase > Math.max(2, waveformWidth * 1.5));
        const filterPadSec = filters.enabled
          ? Math.min(12, Math.max(2, filters.highPassHz > 0 ? 3 / filters.highPassHz : 2))
          : 0;
        // The fixed 48-sample FIR delay exists only for channels eligible for
        // Sean's 2x display decimator. Applying it to a 0.1 Hz auxiliary row,
        // for example, would unnecessarily load hundreds of extra seconds.
        const groupDelayPadSec = useEnvelopePath ? 0 : Math.max(0, ...indices.map((index) => {
          const sampleRate = meta.sampleRates[index] ?? primarySampleRate(meta);
          return sampleRate >= 1000 ? 48 / sampleRate : 0;
        }));
        const processingPadSec = filterPadSec + groupDelayPadSec;
        const requiredStart = Math.max(0, viewStart - processingPadSec);
        const requiredEnd = Math.min(meta.durationSec, viewStart + timebase + processingPadSec);
        const byteRate = indices.reduce((sum, index) => sum + Math.max(1, meta.sampleRates[index] ?? primarySampleRate(meta)) * Float32Array.BYTES_PER_ELEMENT, 0);
        const requiredDuration = Math.max(0, requiredEnd - requiredStart);
        const storageByteRate = (meta.byteLength ?? 0) / Math.max(1e-9, meta.durationSec);
        const budgetDuration = useEnvelopePath
          ? SOURCE_READ_AHEAD_BUDGET_BYTES / Math.max(1, storageByteRate)
          : RAW_WINDOW_CACHE_BUDGET_BYTES / Math.max(1, byteRate);
        const desiredDuration = Math.max(requiredDuration, Math.min(budgetDuration, requiredDuration + timebase * 2));
        const extraDuration = Math.max(0, desiredDuration - requiredDuration);
        let cacheStart = Math.max(0, requiredStart - extraDuration / 2);
        let cacheEnd = Math.min(meta.durationSec, requiredEnd + extraDuration / 2);
        if (cacheEnd - cacheStart < desiredDuration) {
          if (cacheStart === 0) cacheEnd = Math.min(meta.durationSec, desiredDuration);
          else if (cacheEnd === meta.durationSec) cacheStart = Math.max(0, meta.durationSec - desiredDuration);
        }

        if (useEnvelopePath && source.getEnvelopeWindow) {
          const requiredBucketDuration = timebase / Math.max(1, waveformWidth);
          let envelopeWindow = envelopeWindowCacheRef.current.find((entry) =>
            entry.source === source
            && entry.channelKey === channelKey
            && entry.startSec <= viewStart + 1e-9
            && entry.endSec >= viewStart + timebase - 1e-9
            && entry.bucketDurationSec <= requiredBucketDuration * 1.05);
          let envelopeWindowIsCached = Boolean(envelopeWindow);
          if (envelopeWindow) {
            envelopeWindowCacheRef.current = [
              ...envelopeWindowCacheRef.current.filter((entry) => entry !== envelopeWindow),
              envelopeWindow,
            ];
          } else {
            const cacheDuration = Math.max(1e-9, cacheEnd - cacheStart);
            const maxBucketsByBudget = Math.max(
              1,
              Math.floor(ENVELOPE_CACHE_BUDGET_BYTES / Math.max(1, indices.length * 13)),
            );
            const bucketCount = clamp(
              Math.ceil((cacheDuration / Math.max(1e-9, timebase)) * Math.max(1, waveformWidth)),
              1,
              Math.min(12_000, maxBucketsByBudget),
            );
            const envelopeData = await source.getEnvelopeWindow(
              cacheStart,
              cacheDuration,
              bucketCount,
              indices,
              { signal: abortController.signal },
            );
            if (abortController.signal.aborted || sourceRef.current !== source || requestId !== displayRequestIdRef.current) return;
            const byteLength = envelopeData.data.reduce((sum, channel) => sum + channel.byteLength, 0)
              + envelopeData.minima.reduce((sum, channel) => sum + channel.byteLength, 0)
              + envelopeData.maxima.reduce((sum, channel) => sum + channel.byteLength, 0)
              + envelopeData.gaps.reduce((sum, channel) => sum + channel.byteLength, 0);
            envelopeWindow = {
              source,
              channelKey,
              startSec: envelopeData.startSec,
              endSec: envelopeData.startSec + envelopeData.durationSec,
              data: envelopeData.data,
              minima: envelopeData.minima,
              maxima: envelopeData.maxima,
              gaps: envelopeData.gaps,
              bucketDurationSec: envelopeData.bucketDurationSec,
              channelUnits: envelopeData.channelUnits,
              byteLength,
            };
            if (byteLength <= ENVELOPE_CACHE_BUDGET_BYTES) {
              envelopeWindowCacheRef.current.push(envelopeWindow);
              envelopeWindowIsCached = true;
              let cachedBytes = envelopeWindowCacheRef.current.reduce((sum, entry) => sum + entry.byteLength, 0);
              while (cachedBytes > ENVELOPE_CACHE_BUDGET_BYTES && envelopeWindowCacheRef.current.length) {
                const removed = envelopeWindowCacheRef.current.shift();
                if (removed === envelopeWindow) envelopeWindowIsCached = false;
                cachedBytes -= removed?.byteLength ?? 0;
              }
            }
          }

          const firstBucket = clamp(
            Math.floor((viewStart - envelopeWindow.startSec) / envelopeWindow.bucketDurationSec + 1e-9),
            0,
            envelopeWindow.data[0]?.length ?? 0,
          );
          const lastBucket = clamp(
            Math.ceil((viewStart + timebase - envelopeWindow.startSec) / envelopeWindow.bucketDurationSec - 1e-9),
            firstBucket + 1,
            envelopeWindow.data[0]?.length ?? firstBucket + 1,
          );
          const envelopeStartSec = envelopeWindow.startSec + firstBucket * envelopeWindow.bucketDurationSec;
          const crop = <T extends Float32Array | Uint8Array>(channel: T): T => (
            envelopeWindowIsCached
              ? channel.subarray(firstBucket, lastBucket)
              : channel.slice(firstBucket, lastBucket)
          ) as T;
          const data = envelopeWindow.data.map(crop);
          const envelopes = data.map((_, position) => ({
            minima: crop(envelopeWindow.minima[position]),
            maxima: crop(envelopeWindow.maxima[position]),
            gaps: crop(envelopeWindow.gaps[position]),
            startSec: envelopeStartSec,
            bucketDurationSec: envelopeWindow.bucketDurationSec,
          }));
          const flatlineRegions = detectEnvelopeSynchronizedFlatlines(
            envelopes.map((entry) => entry.minima),
            envelopes.map((entry) => entry.maxima),
            envelopes.map((entry) => entry.gaps),
            envelopeWindow.bucketDurationSec,
            { startSec: envelopeStartSec, thresholdFraction: .8, minimumDurationSec: .25 },
          ).map((region) => ({ startSec: region.startSec, endSec: region.endSec }));
          const effectiveRate = 1 / envelopeWindow.bucketDurationSec;
          displayAppliedRequestIdRef.current = requestId;
          const nextDisplay: DisplayWindow = {
            data,
            envelopes,
            labels: indices.map((index) => meta.channelLabels[index] ?? `Ch ${index + 1}`),
            sampleRates: indices.map(() => effectiveRate),
            sourceSampleRates: indices.map((index) => meta.sampleRates[index] ?? primarySampleRate(meta)),
            startSecs: indices.map(() => envelopeStartSec),
            units: envelopeWindow.channelUnits,
            sourceIndices: indices.map((index) => [index]),
            primarySourceIndices: indices,
            warnings: [],
            viewStart,
            flatlineRegions,
          };
          setDisplay(nextDisplay);
          setFocusedChannel((current) => clamp(current, 0, Math.max(0, nextDisplay.labels.length - 1)));
          setLoadingSignal(false);
          return;
        }

        let rawWindow = rawWindowCacheRef.current.find((entry) =>
          entry.source === source
          && entry.channelKey === channelKey
          && entry.startSec <= requiredStart + 1e-9
          && entry.endSec >= requiredEnd - 1e-9);
        if (rawWindow) {
          rawWindowCacheRef.current = [
            ...rawWindowCacheRef.current.filter((entry) => entry !== rawWindow),
            rawWindow,
          ];
        } else {
          const windowData = await source.getWindow(
            cacheStart,
            Math.max(0, cacheEnd - cacheStart),
            indices,
            { signal: abortController.signal },
          );
          if (abortController.signal.aborted || sourceRef.current !== source || requestId !== displayRequestIdRef.current) return;
          const byteLength = windowData.data.reduce((sum, channel) => sum + channel.byteLength, 0);
          const flatlineRegions = detectRawSynchronizedFlatlines(windowData.data, windowData.sampleRates, {
            startSec: windowData.startSec,
            channelStartSecs: windowData.channelStartSecs,
            thresholdFraction: .8,
            minimumDurationSec: .25,
          }).map((region) => ({ startSec: region.startSec, endSec: region.endSec }));
          rawWindow = {
            source,
            channelKey,
            startSec: windowData.startSec,
            endSec: windowData.startSec + windowData.durationSec,
            data: windowData.data,
            sampleRates: windowData.sampleRates,
            channelStartSecs: windowData.channelStartSecs,
            channelUnits: windowData.channelUnits,
            byteLength,
            flatlineRegions,
          };
          if (byteLength <= RAW_WINDOW_CACHE_BUDGET_BYTES) {
            rawWindowCacheRef.current.push(rawWindow);
            let cachedBytes = rawWindowCacheRef.current.reduce((sum, entry) => sum + entry.byteLength, 0);
            while (cachedBytes > RAW_WINDOW_CACHE_BUDGET_BYTES && rawWindowCacheRef.current.length > 1) {
              const removed = rawWindowCacheRef.current.shift();
              cachedBytes -= removed?.byteLength ?? 0;
            }
            const liveRaw = new Set(rawWindowCacheRef.current);
            processedWindowCacheRef.current = processedWindowCacheRef.current.filter((entry) => liveRaw.has(entry.raw));
          } else {
            rawWindowCacheRef.current = [];
            processedWindowCacheRef.current = [];
          }
        }
        if (sourceRef.current !== source || requestId !== displayRequestIdRef.current) return;

        // Keep file read-ahead in the raw cache, but only filter/decimate the
        // requested viewport plus its settling pad. Processing the full cache
        // made a 100+ channel, 1 kHz DAT first paint hundreds of millions of
        // unnecessary FIR operations.
        const processingRanges = rawWindow.data.map((channel, position) => {
          const sampleRate = rawWindow.sampleRates[position] ?? primarySampleRate(meta);
          const channelStart = rawWindow.channelStartSecs[position] ?? rawWindow.startSec;
          const firstSample = clamp(
            Math.floor((requiredStart - channelStart) * sampleRate + 1e-9),
            0,
            channel.length,
          );
          const lastSample = clamp(
            Math.max(firstSample + 1, Math.ceil((requiredEnd - channelStart) * sampleRate - 1e-9)),
            firstSample,
            channel.length,
          );
          return {
            firstSample,
            lastSample,
            sourceStartSample: Math.round(channelStart * sampleRate) + firstSample,
          };
        });
        const processingData = rawWindow.data.map((channel, position) => {
          const range = processingRanges[position];
          return channel.subarray(range.firstSample, range.lastSample);
        });
        const processingDuration = Math.max(1e-9, requiredEnd - requiredStart);
        const processingPixelCount = Math.max(1, waveformWidth * processingDuration / Math.max(1e-9, timebase));
        const expectedFactors = processingData.map((channel, index) =>
          clinicalDecimationFactor(rawWindow.sampleRates[index], channel.length, processingPixelCount));
        const sourceStartSampleIndices = processingRanges.map((range) => range.sourceStartSample);
        const settingsKey = JSON.stringify({
          filters: filters.enabled ? filters : { enabled: false },
          factors: expectedFactors,
          sourceStartSampleIndices,
          sampleCounts: processingData.map((channel) => channel.length),
        });
        let processed = processedWindowCacheRef.current.find((entry) => entry.raw === rawWindow && entry.settingsKey === settingsKey);
        if (processed) {
          processedWindowCacheRef.current = [
            ...processedWindowCacheRef.current.filter((entry) => entry !== processed),
            processed,
          ];
        } else {
          const prepared = await processDisplaySignalsOffThread({
            data: processingData,
            sampleRates: rawWindow.sampleRates,
            filters,
            pixelCount: processingPixelCount,
            sourceStartSampleIndices,
          }, { signal: abortController.signal });
          if (abortController.signal.aborted || sourceRef.current !== source || requestId !== displayRequestIdRef.current) return;
          const processedData = prepared.data;
          const processedRates = prepared.sampleRates;
          const processedStartSecs = prepared.outputStartSampleIndices.map((sampleIndex, position) =>
            sampleIndex / rawWindow.sampleRates[position]);
          const factors = prepared.factors;
          const byteLength = processedData.reduce((sum, channel) => sum + channel.byteLength, 0);
          processed = {
            raw: rawWindow,
            settingsKey,
            data: processedData,
            sampleRates: processedRates,
            channelStartSecs: processedStartSecs,
            factors,
            byteLength,
          };
          const duplicatesRaw = !filters.enabled && factors.every((factor) => factor === 1);
          const rawOwnerIsCached = rawWindowCacheRef.current.includes(rawWindow);
          if (rawOwnerIsCached
            && !duplicatesRaw
            && rawWindow.byteLength + byteLength <= RAW_WINDOW_CACHE_BUDGET_BYTES * 2) {
            processedWindowCacheRef.current.push(processed);
            let cachedBytes = processedWindowCacheRef.current.reduce((sum, entry) => sum + entry.byteLength, 0);
            while (cachedBytes > RAW_WINDOW_CACHE_BUDGET_BYTES && processedWindowCacheRef.current.length > 1) {
              const removed = processedWindowCacheRef.current.shift();
              cachedBytes -= removed?.byteLength ?? 0;
            }
          }
        }
        if (sourceRef.current !== source || requestId !== displayRequestIdRef.current) return;

        const croppedStartSecs: number[] = [];
        const cropped = processed.data.map((channel, position) => {
          const sampleRate = processed.sampleRates[position] ?? primarySampleRate(meta);
          const channelStart = processed.channelStartSecs[position] ?? rawWindow.startSec;
          // Keep the sample immediately before the requested left edge. Its
          // true timestamp lets the renderer cover the boundary without
          // stretching N samples across an N-sample-duration viewport.
          const cropStart = clamp(
            Math.floor((viewStart - channelStart) * sampleRate + 1e-9),
            0,
            channel.length,
          );
          const requestedEnd = Math.max(
            cropStart + 1,
            Math.ceil((viewStart + timebase - channelStart) * sampleRate - 1e-9),
          );
          const requestedSamples = Math.max(1, requestedEnd - cropStart);
          croppedStartSecs.push(channelStart + cropStart / sampleRate);
          if (cropStart + requestedSamples <= channel.length) {
            return channel.subarray(cropStart, cropStart + requestedSamples);
          }
          const output = new Float32Array(requestedSamples);
          output.fill(Number.NaN);
          output.set(channel.subarray(cropStart, channel.length));
          return output;
        });
        const labels = indices.map((index) => meta.channelLabels[index] ?? `Ch ${index + 1}`);
        const badDisplayPositions = new Set(indices.flatMap((sourceIndex, position) => badChannels.has(sourceIndex) ? [position] : []));
        const montageWarnings: string[] = [];
        if (montage !== "referential") {
          const unitCounts = new Map<string, number>();
          rawWindow.channelUnits.forEach((unit, position) => {
            if (!badDisplayPositions.has(position)) unitCounts.set(unit, (unitCounts.get(unit) ?? 0) + 1);
          });
          const referenceUnit = [...unitCounts].sort((left, right) => right[1] - left[1] || Number(right[0] === "µV") - Number(left[0] === "µV"))[0]?.[0];
          rawWindow.channelUnits.forEach((unit, position) => {
            if (referenceUnit && unit !== referenceUnit) badDisplayPositions.add(position);
          });
          const omittedUnits = [...new Set(rawWindow.channelUnits.filter((unit) => referenceUnit && unit !== referenceUnit))];
          if (omittedUnits.length) montageWarnings.push(`${omittedUnits.join(", ")} channels were excluded from ${montage === "bipolar" ? "bipolar" : "average-reference"} arithmetic because units cannot be mixed.`);
        }
        const montageResult = buildMontage(
          cropped,
          labels,
          montage,
          badDisplayPositions,
          processed.sampleRates,
          croppedStartSecs,
        );
        const sourceIndices = montageResult.sourceIndices.map((contributors) => contributors.map((position) => indices[position]).filter((index) => index !== undefined));
        const primarySourceIndices = montageResult.primarySourceIndices.map((position) => indices[position] ?? -1);
        const sampleRates = montageResult.primarySourceIndices.map((position) => processed.sampleRates[position] ?? primarySampleRate(meta));
        const sourceSampleRates = montageResult.primarySourceIndices.map((position) => rawWindow.sampleRates[position] ?? primarySampleRate(meta));
        const startSecs = montageResult.sampleStartSecs
          ?? montageResult.primarySourceIndices.map((position) => croppedStartSecs[position] ?? viewStart);
        const units = montageResult.sourceIndices.map((contributors) => {
          const contributorUnits = [...new Set(contributors.map((position) => rawWindow.channelUnits[position]).filter(Boolean))];
          return contributorUnits.length === 1 ? contributorUnits[0] : contributorUnits.length ? "mixed" : "a.u.";
        });
        displayAppliedRequestIdRef.current = requestId;
        const nextDisplay: DisplayWindow = {
          data: montageResult.data,
          envelopes: montageResult.data.map(() => null),
          labels: montageResult.labels,
          sampleRates,
          sourceSampleRates,
          startSecs,
          units,
          sourceIndices,
          primarySourceIndices,
          warnings: [...montageWarnings, ...montageResult.warnings],
          viewStart,
          flatlineRegions: rawWindow.flatlineRegions.filter((region) => region.endSec > viewStart && region.startSec < viewStart + timebase),
        };
        setDisplay(nextDisplay);
        setFocusedChannel((current) => clamp(current, 0, Math.max(0, nextDisplay.labels.length - 1)));
        setLoadingSignal(false);
      } catch (error) {
        if (abortController.signal.aborted) return;
        if (sourceRef.current !== source || requestId !== displayRequestIdRef.current) return;
        displayAppliedRequestIdRef.current = requestId;
        setLoadingSignal(false);
        const message = error instanceof Error ? error.message : "Could not read this signal window";
        setDisplay({ ...EMPTY_DISPLAY, viewStart, warnings: [message] });
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
    return () => abortController.abort();
  }, [badChannels, filters, hasRecording, meta, montage, selectedChannels, spectrogramOpen, timebase, viewStart, waveformWidth]);

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
      const canvasScale = boundedCanvasScale(rect.width, rect.height, window.devicePixelRatio || 1);
      const backingWidth = Math.max(1, Math.floor(rect.width * canvasScale));
      const backingHeight = Math.max(1, Math.floor(rect.height * canvasScale));
      if (canvas.width !== backingWidth) canvas.width = backingWidth;
      if (canvas.height !== backingHeight) canvas.height = backingHeight;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(canvasScale, 0, 0, canvasScale, 0, 0);
      const width = rect.width;
      const height = rect.height;
      const displayStart = display.viewStart;
      const displayEnd = displayStart + timebase;
      context.fillStyle = "#071216";
      context.fillRect(0, 0, width, height);

      const secondsPerGrid = activeCandidateItem ? 1 : timebase <= 10 ? 1 : timebase <= 30 ? 2 : timebase <= 60 ? 5 : 10;
      context.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      context.textAlign = "center";
      context.textBaseline = "top";
      const gridAnchor = activeCandidateItem?.time ?? 0;
      const firstGridIndex = Math.ceil((displayStart - gridAnchor) / secondsPerGrid);
      for (let gridIndex = firstGridIndex; ; gridIndex += 1) {
        const second = gridAnchor + gridIndex * secondsPerGrid;
        if (second > displayEnd + 1e-9) break;
        const x = ((second - displayStart) / timebase) * width;
        context.strokeStyle = gridIndex % 5 === 0 ? "rgba(133,171,181,.20)" : "rgba(133,171,181,.09)";
        context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
        context.fillStyle = "rgba(167,190,197,.74)";
        context.fillText(
          activeCandidateItem
            ? formatRelativeTime(second - activeCandidateItem.time).replace(" s", "")
            : formatClock(second),
          x,
          5,
        );
      }

      for (const region of display.flatlineRegions) {
        if (region.endSec <= displayStart || region.startSec >= displayEnd) continue;
        const x1 = ((Math.max(region.startSec, displayStart) - displayStart) / timebase) * width;
        const x2 = ((Math.min(region.endSec, displayEnd) - displayStart) / timebase) * width;
        context.fillStyle = "rgba(243, 187, 95, .08)";
        context.fillRect(x1, CHANNEL_RAIL_HEADER_HEIGHT, Math.max(1, x2 - x1), Math.max(0, height - CHANNEL_RAIL_HEADER_HEIGHT));
        context.fillStyle = "rgba(243, 187, 95, .74)";
        context.textAlign = "left";
        context.fillText("RAW SOURCE FLATLINE", x1 + 4, CHANNEL_RAIL_HEADER_HEIGHT + 3);
        context.textAlign = "center";
      }

      const plotTop = CHANNEL_RAIL_HEADER_HEIGHT;
      const plotHeight = expandedChannels
        ? Math.max(1, channelRowLayout.totalUnits * 60)
        : Math.max(1, height - plotTop);
      const rowHeight = expandedChannels ? 60 : plotHeight / channelRowLayout.totalUnits;
      const rowScrollOffset = expandedChannels ? channelScrollOffset : 0;
      const isInspectionRowHighlighted = (channel: number) => Boolean(
        inspectionDragging
        && inspectionRange
        && channel >= inspectionRange.startRow
        && channel <= inspectionRange.endRow,
      );

      if (activeCandidateItem && activeCandidateItem.time >= displayStart && activeCandidateItem.time <= displayEnd) {
        const eventX = ((activeCandidateItem.time - displayStart) / timebase) * width;
        context.save();
        context.strokeStyle = "rgba(232, 240, 239, .9)";
        context.lineWidth = 1.2;
        context.setLineDash([6, 4]);
        context.beginPath(); context.moveTo(eventX, plotTop); context.lineTo(eventX, height); context.stroke();
        context.setLineDash([]);
        context.fillStyle = "rgba(232, 240, 239, .94)";
        context.textAlign = eventX > width - 150 ? "right" : "left";
        context.fillText("SOURCE EVENT · 0.000 s", eventX + (eventX > width - 150 ? -5 : 5), plotTop + 4);
        context.restore();
      }

      for (let channel = 0; channel < display.data.length; channel += 1) {
        const rowTop = plotTop + rowHeight * channelRowLayout.rowStartUnits[channel] - rowScrollOffset;
        const center = rowTop + rowHeight * 0.5;
        if (rowTop + rowHeight < plotTop || rowTop > height) continue;
        if (channelRowLayout.groupStarts.has(channel)) {
          context.strokeStyle = "rgba(87, 223, 183, .22)";
          context.beginPath(); context.moveTo(0, rowTop - rowHeight * 2); context.lineTo(width, rowTop - rowHeight * 2); context.stroke();
        }
        const inspectionHighlighted = isInspectionRowHighlighted(channel);
        if (inspectionHighlighted || (!inspectionDragging && channel === focusedChannel)) {
          context.fillStyle = inspectionHighlighted ? "rgba(102, 174, 255, .09)" : "rgba(87, 223, 183, .065)";
          context.fillRect(0, rowTop, width, rowHeight);
          if (rowHeight >= 2) {
            context.strokeStyle = inspectionHighlighted ? "rgba(102, 174, 255, .46)" : "rgba(87, 223, 183, .28)";
            context.strokeRect(.5, rowTop + .5, width - 1, rowHeight - 1);
          }
        }
        context.strokeStyle = "rgba(116,153,162,.11)";
        context.beginPath(); context.moveTo(0, center); context.lineTo(width, center); context.stroke();
      }

      for (const item of annotations) {
        if (item.end < displayStart || item.start > displayEnd) continue;
        const label = LABEL_BY_ID.get(item.labelId);
        if (!label) continue;
        const x1 = ((Math.max(item.start, displayStart) - displayStart) / timebase) * width;
        const geometry = annotationGeometry(item);
        if (geometry === "session") continue;
        const x2 = geometry === "point" ? x1 : ((Math.min(item.end, displayEnd) - displayStart) / timebase) * width;
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

      const traceOrder = display.data.map((_, index) => index).sort((left, right) => {
        if (left === focusedChannel) return 1;
        if (right === focusedChannel) return -1;
        return left - right;
      });
      for (const channel of traceOrder) {
        const values = display.data[channel];
        const sampleRate = display.sampleRates[channel] ?? 1;
        const rowStartSec = display.startSecs[channel] ?? displayStart;
        const rowTop = plotTop + rowHeight * channelRowLayout.rowStartUnits[channel] - rowScrollOffset;
        const center = rowTop + rowHeight * 0.5;
        if (rowTop + rowHeight < plotTop || rowTop > height) continue;
        if (!values.length || !(sampleRate > 0)) continue;
        const scale = legacyRawCountDisplay
          ? (rowHeight * gain) / LEGACY_RAW_COUNTS_PER_ROW
          : (rowHeight * 0.36 * gain) / 100;
        const selected = inspectionDragging ? isInspectionRowHighlighted(channel) : channel === focusedChannel;
        let overflow = false;
        context.save();
        context.beginPath();
        context.rect(0, rowTop, width, rowHeight);
        context.clip();
        context.strokeStyle = selected ? "rgba(242, 255, 251, 1)" : "rgba(218, 235, 232, .72)";
        context.lineWidth = selected ? 1.25 : 0.85;
        const envelope = display.envelopes[channel];
        if (envelope) {
          const baseline = robustTraceBaseline(values);
          context.save();
          context.globalAlpha = selected ? .72 : .42;
          context.beginPath();
          for (let bucket = 0; bucket < values.length; bucket += 1) {
            const minimum = envelope.minima[bucket];
            const maximum = envelope.maxima[bucket];
            if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) continue;
            const bucketTime = envelope.startSec + (bucket + .5) * envelope.bucketDurationSec;
            const x = ((bucketTime - displayStart) / timebase) * width;
            if (x < -1 || x > width + 1) continue;
            const confinedMaximum = confineTraceYToRow(center - (maximum - baseline) * scale, rowTop, rowHeight);
            const confinedMinimum = confineTraceYToRow(center - (minimum - baseline) * scale, rowTop, rowHeight);
            if (confinedMaximum.overflow || confinedMinimum.overflow) overflow = true;
            context.moveTo(x, confinedMaximum.y);
            context.lineTo(x, confinedMinimum.y);
          }
          context.stroke();
          context.restore();
          context.beginPath();
          let connected = false;
          for (let bucket = 0; bucket < values.length; bucket += 1) {
            const value = values[bucket];
            if (!Number.isFinite(value) || envelope.gaps[bucket]) {
              connected = false;
              continue;
            }
            const bucketTime = envelope.startSec + (bucket + .5) * envelope.bucketDurationSec;
            const x = ((bucketTime - displayStart) / timebase) * width;
            if (x < -1 || x > width + 1) continue;
            const { y } = confineTraceYToRow(center - (value - baseline) * scale, rowTop, rowHeight);
            if (connected) context.lineTo(x, y);
            else context.moveTo(x, y);
            connected = true;
          }
          context.stroke();
        } else if (values.length <= Math.max(2, width * 1.5)) {
          const baseline = robustTraceBaseline(values);
          context.beginPath();
          let connected = false;
          for (let sample = 0; sample < values.length; sample += 1) {
            const value = values[sample];
            if (!Number.isFinite(value)) {
              connected = false;
              continue;
            }
            const sampleTime = rowStartSec + sample / sampleRate;
            const x = ((sampleTime - displayStart) / timebase) * width;
            const confined = confineTraceYToRow(center - (value - baseline) * scale, rowTop, rowHeight);
            const y = confined.y;
            if (confined.overflow) overflow = true;
            if (connected) context.lineTo(x, y);
            else context.moveTo(x, y);
            connected = true;
          }
          context.stroke();
        } else {
          const pixelColumns = Math.max(1, Math.floor(width));
          const minima = new Float64Array(pixelColumns);
          minima.fill(Number.POSITIVE_INFINITY);
          const maxima = new Float64Array(pixelColumns);
          maxima.fill(Number.NEGATIVE_INFINITY);
          const gaps = new Uint8Array(pixelColumns);
          const midpoints = new Float64Array(pixelColumns);
          midpoints.fill(Number.NaN);
          const baselineSamples: number[] = [];
          let baselineFiniteCount = 0;
          for (let sample = 0; sample < values.length; sample += 1) {
            const sampleTime = rowStartSec + sample / sampleRate;
            const column = Math.floor(((sampleTime - displayStart) / timebase) * pixelColumns);
            if (column < 0 || column >= pixelColumns) continue;
            const value = values[sample];
            if (!Number.isFinite(value)) {
              // A missing source sample is a real discontinuity. Do not let a
              // finite neighbor in the same pixel visually bridge that gap.
              gaps[column] = 1;
              continue;
            }
            baselineFiniteCount += 1;
            if (baselineSamples.length < 257) baselineSamples.push(value);
            else {
              const candidate = ((Math.imul(baselineFiniteCount, 0x9e3779b1) >>> 0) % baselineFiniteCount);
              if (candidate < 257) baselineSamples[candidate] = value;
            }
            minima[column] = Math.min(minima[column], value);
            maxima[column] = Math.max(maxima[column], value);
          }
          const baseline = medianSampledValues(baselineSamples);
          context.save();
          context.globalAlpha = selected ? .72 : .42;
          context.beginPath();
          for (let x = 0; x < pixelColumns; x += 1) {
            const min = minima[x];
            const max = maxima[x];
            if (min === Number.POSITIVE_INFINITY) continue;
            // Preserve finite extrema in a partly missing pixel column, but
            // break the connecting centerline so a real gap is never bridged.
            if (!gaps[x]) midpoints[x] = (min + max) / 2;
            const confinedMaximum = confineTraceYToRow(center - (max - baseline) * scale, rowTop, rowHeight);
            const confinedMinimum = confineTraceYToRow(center - (min - baseline) * scale, rowTop, rowHeight);
            if (confinedMaximum.overflow || confinedMinimum.overflow) overflow = true;
            context.moveTo(x + .5, confinedMaximum.y);
            context.lineTo(x + .5, confinedMinimum.y);
          }
          context.stroke();
          context.restore();
          context.beginPath();
          let connected = false;
          for (let x = 0; x < pixelColumns; x += 1) {
            const value = midpoints[x];
            if (!Number.isFinite(value)) {
              connected = false;
              continue;
            }
            const { y } = confineTraceYToRow(center - (value - baseline) * scale, rowTop, rowHeight);
            if (connected) context.lineTo(x + .5, y);
            else context.moveTo(x + .5, y);
            connected = true;
          }
          context.stroke();
        }
        context.restore();
        if (overflow) {
          const markerHalfHeight = Math.min(4, rowHeight * .4);
          context.fillStyle = "rgba(255, 135, 120, .92)";
          context.beginPath();
          context.moveTo(width - 7, center - markerHalfHeight);
          context.lineTo(width - 2, center);
          context.lineTo(width - 7, center + markerHalfHeight);
          context.closePath();
          context.fill();
        }
      }

      const scaleRow = clamp(focusedChannel, 0, Math.max(0, display.data.length - 1));
      if (display.data.length) {
        const scale = legacyRawCountDisplay
          ? (rowHeight * gain) / LEGACY_RAW_COUNTS_PER_ROW
          : (rowHeight * 0.36 * gain) / 100;
        const barValue = (legacyRawCountDisplay ? 5_000 : 100) / gain;
        const x = Math.max(18, width - 34);
        const y = plotTop + rowHeight * (channelRowLayout.rowStartUnits[scaleRow] + .5) - rowScrollOffset;
        const halfHeight = barValue * scale * .5;
        if (y + halfHeight >= plotTop && y - halfHeight <= height) {
          context.strokeStyle = "rgba(87, 223, 183, .95)";
          context.lineWidth = 1.25;
          context.beginPath();
          context.moveTo(x, y - halfHeight); context.lineTo(x, y + halfHeight);
          context.moveTo(x - 4, y - halfHeight); context.lineTo(x + 4, y - halfHeight);
          context.moveTo(x - 4, y + halfHeight); context.lineTo(x + 4, y + halfHeight);
          context.stroke();
          context.fillStyle = "rgba(155, 225, 207, .92)";
          context.textAlign = "right";
          context.textBaseline = "middle";
          context.fillText(
            legacyRawCountDisplay
              ? `${Math.round(barValue).toLocaleString()} counts`
              : formatAmplitude(barValue, display.units[scaleRow] || "a.u."),
            x - 7,
            y,
          );
        }
      }

      if (markOnset !== null) {
        const onsetX = ((markOnset - displayStart) / timebase) * width;
        context.strokeStyle = "#57dfb7";
        context.lineWidth = 2;
        context.setLineDash([7, 4]);
        context.beginPath(); context.moveTo(onsetX, 0); context.lineTo(onsetX, height); context.stroke();
        context.setLineDash([]);
      }
    };
    waveDrawRef.current = draw;
    draw();
  }, [activeCandidateItem, activeSessionContentView, annotations, channelRowLayout, channelScrollOffset, display, expandedChannels, focusedChannel, gain, inspectionDragging, inspectionRange, legacyRawCountDisplay, markOnset, timebase]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const nextWidth = Math.max(1, Math.round(canvas.getBoundingClientRect().width));
      setWaveformWidth((current) => current === nextWidth ? current : nextWidth);
      waveDrawRef.current();
    };
    // The canvas is absent on blank sessions and in file-structure view, so
    // measure as soon as the recording view remounts it.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [activeSessionContentView, hasRecording]);

  const updateExpandedChannelViewport = useCallback(() => {
    const container = waveformScrollRef.current;
    if (!container) return;
    if (channelScrollFrameRef.current !== null) return;
    channelScrollFrameRef.current = window.requestAnimationFrame(() => {
      channelScrollFrameRef.current = null;
      setChannelScrollOffset(expandedChannels ? container.scrollTop : 0);
      setChannelViewportHeight(Math.max(1, container.clientHeight));
    });
  }, [expandedChannels]);

  useLayoutEffect(() => {
    const container = waveformScrollRef.current;
    if (!container) return;
    if (!expandedChannels) container.scrollTop = 0;
    const update = () => {
      setChannelScrollOffset(expandedChannels ? container.scrollTop : 0);
      setChannelViewportHeight(Math.max(1, container.clientHeight));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeSessionContentView, expandedChannels]);

  const channelRowFromClientY = useCallback((clientY: number, rect: DOMRect) => {
    const localY = clientY - rect.top;
    if (localY < CHANNEL_RAIL_HEADER_HEIGHT || localY > rect.height) return null;
    if (expandedChannels) {
      const liveScrollTop = waveformScrollRef.current?.scrollTop ?? channelScrollOffset;
      const contentY = liveScrollTop + localY - CHANNEL_RAIL_HEADER_HEIGHT;
      return channelRowFromFraction(
        channelRowLayout,
        contentY / Math.max(1, channelRowLayout.totalUnits * 60),
      );
    }
    return channelRowFromFraction(
      channelRowLayout,
      (localY - CHANNEL_RAIL_HEADER_HEIGHT) / Math.max(1, rect.height - CHANNEL_RAIL_HEADER_HEIGHT),
    );
  }, [channelRowLayout, channelScrollOffset, expandedChannels]);

  const timeFromPointer = useCallback((event: { clientX: number }, element: HTMLElement, row: number, bypass = false) => {
    const rect = element.getBoundingClientRect();
    const raw = display.viewStart + clamp((event.clientX - rect.left) / rect.width, 0, 1) * timebase;
    const visibleStart = clamp(display.viewStart, 0, meta.durationSec);
    const visibleEnd = clamp(display.viewStart + timebase, visibleStart, meta.durationSec);
    return clamp(
      snapTime(raw, activeTool === "seizure" ? "sample" : snapMode, sourceRateForDisplayRow(display, meta, row), bypass),
      visibleStart,
      visibleEnd,
    );
  }, [activeTool, display, meta, snapMode, timebase]);

  const inspectionBoxFromPointer = useCallback((
    pointer: WavePointerState,
    row: number,
    time: number,
    clientY: number,
    rect: DOMRect,
  ): InspectionBox => {
    const plotTop = clamp(CHANNEL_RAIL_HEADER_HEIGHT / Math.max(1, rect.height), 0, 1);
    const startFraction = clamp((pointer.startY - rect.top) / Math.max(1, rect.height), plotTop, 1);
    const currentFraction = clamp((clientY - rect.top) / Math.max(1, rect.height), plotTop, 1);
    const minimumHeight = Math.min(12 / Math.max(1, rect.height), Math.max(0, 1 - plotTop));
    let top = Math.min(startFraction, currentFraction);
    let bottom = Math.max(startFraction, currentFraction);
    if (bottom - top < minimumHeight) {
      const center = (top + bottom) / 2;
      top = clamp(center - minimumHeight / 2, plotTop, Math.max(plotTop, 1 - minimumHeight));
      bottom = Math.min(1, top + minimumHeight);
    }
    const startRow = Math.min(pointer.startRow, row);
    const endRow = Math.max(pointer.startRow, row);
    return {
      start: Math.min(pointer.startTime, time),
      end: Math.max(pointer.startTime, time),
      startRow,
      endRow,
      top,
      bottom,
      channelLabels: display.labels.slice(startRow, endRow + 1),
      sourceIndices: [...new Set(display.sourceIndices.slice(startRow, endRow + 1).flat())],
    };
  }, [display.labels, display.sourceIndices]);

  const inspectionMode = rightPanelView === "inspect"
    || (rightPanelView === "resources" && lastRightPanelToolView === "inspect");

  const onWavePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || loadingSignal || !display.data.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const row = channelRowFromClientY(event.clientY, rect);
    if (row === null) return;
    const time = timeFromPointer(event, event.currentTarget, row, event.altKey || inspectionMode);
    const values = display.data[row];
    const sample = sampleIndexForDisplayRow(display, row, time);
    pointerRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTime: time,
      startRow: row,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setCursorTime(time);
    setCursorLocked(true);
    setFocusedChannel(row);
    setCursorAmplitude(values?.[sample] ?? 0);
    if (inspectionMode) {
      setSelection(null);
      setInspectionDragging(true);
      setInspectionRange(inspectionBoxFromPointer(pointerRef.current, row, time, event.clientY, rect));
    }
  };

  const onWavePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!pointerRef.current || pointerRef.current.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerY = inspectionMode
      ? clamp(event.clientY, rect.top + CHANNEL_RAIL_HEADER_HEIGHT, rect.bottom)
      : event.clientY;
    const row = channelRowFromClientY(pointerY, rect);
    if (row === null) return;
    const time = timeFromPointer(event, event.currentTarget, row, event.altKey || inspectionMode);
    const values = display.data[row];
    const sample = sampleIndexForDisplayRow(display, row, time);
    if (Math.abs(event.clientX - pointerRef.current.startX) > 3
      || (inspectionMode && Math.abs(pointerY - pointerRef.current.startY) > 3)) {
      pointerRef.current.moved = true;
    }
    pendingCursorRef.current = {
      time,
      row,
      amplitude: values?.[sample] ?? 0,
      selection: pointerRef.current.moved
        ? { start: Math.min(pointerRef.current.startTime, time), end: Math.max(pointerRef.current.startTime, time) }
        : undefined,
      inspectionBox: inspectionMode && pointerRef.current.moved
        ? inspectionBoxFromPointer(pointerRef.current, row, time, pointerY, rect)
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
      if (pending.inspectionBox) setInspectionRange(pending.inspectionBox);
      else if (pending.selection && !inspectionMode) setSelection(pending.selection);
    });
  };

  const onWavePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    pointerRef.current = null;
    setInspectionDragging(false);
    if (cursorFrameRef.current !== null) {
      window.cancelAnimationFrame(cursorFrameRef.current);
      cursorFrameRef.current = null;
    }
    pendingCursorRef.current = null;
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerY = inspectionMode
      ? clamp(event.clientY, rect.top + CHANNEL_RAIL_HEADER_HEIGHT, rect.bottom)
      : event.clientY;
    const hitRow = channelRowFromClientY(pointerY, rect);
    if (hitRow === null && !pointer.moved) {
      setToast("Click directly on a waveform row");
      return;
    }
    const row = hitRow ?? clamp(focusedChannel, 0, Math.max(0, display.data.length - 1));
    const time = timeFromPointer(event, event.currentTarget, row, event.altKey || inspectionMode);
    const values = display.data[row];
    const sample = sampleIndexForDisplayRow(display, row, time);
    setCursorTime(time);
    setCursorLocked(true);
    setFocusedChannel(row);
    setCursorAmplitude(values?.[sample] ?? 0);
    if (inspectionMode) {
      const range = inspectionBoxFromPointer(pointer, row, time, pointerY, rect);
      setSelection(null);
      setInspectionRange(range);
      const horizontalDrag = Math.abs(event.clientX - pointer.startX) > 3;
      if (horizontalDrag && range.end > range.start) {
        zoomToTimeRange(range.start, range.end);
        setToast(`Zoomed to ${range.end - range.start < 1 ? "a 1 s window" : `${(range.end - range.start).toFixed(2)} s`} across ${range.channelLabels.length} channel${range.channelLabels.length === 1 ? "" : "s"}`);
      } else {
        setToast(`Inspecting ${display.labels[row] ?? "waveform"} at ${formatClock(time, true)} — drag a box to zoom`);
      }
    } else if (activeTool === "seizure" && !pointer.moved) {
      if (markOnset === null) {
        setMarkOnset(time);
        setToast(`Onset placed at ${formatClock(time, true)} — click offset`);
      } else if (time <= markOnset) {
        setToast("Offset must be after onset");
      } else {
        addAnnotation(LABEL_BY_ID.get("ictal")!, markOnset, time, "native", row);
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

  const onWavePointerCancel = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointerRef.current?.pointerId !== event.pointerId) return;
    pointerRef.current = null;
    pendingCursorRef.current = null;
    setInspectionDragging(false);
    if (cursorFrameRef.current !== null) {
      window.cancelAnimationFrame(cursorFrameRef.current);
      cursorFrameRef.current = null;
    }
  };

  const onLabelDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const labelId = event.dataTransfer.getData("application/x-neurotrace-label");
    const label = LABEL_BY_ID.get(labelId);
    if (!label) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const canvasRect = canvas.getBoundingClientRect();
    if (event.clientX < canvasRect.left || event.clientX > canvasRect.right
      || event.clientY < canvasRect.top + CHANNEL_RAIL_HEADER_HEIGHT
      || event.clientY > canvasRect.bottom) {
      setDragGhost(null);
      setToast("Drop labels directly on a waveform row");
      return;
    }
    const row = channelRowFromClientY(event.clientY, canvasRect);
    if (row === null) {
      setDragGhost(null);
      setToast("Drop labels on a channel row, not in an anatomical group gap");
      return;
    }
    const time = timeFromPointer(event, canvas, row, event.altKey);
    const intent: PlacementIntent = label.geometry === "session"
      ? "native"
      : label.category === "Context"
        ? selection
          ? "context-window"
          : "context-instance"
        : selection
          ? "windowed"
          : "instance";
    setFocusedChannel(row);
    addAnnotation(label, selection?.start ?? time, selection?.end, intent, row);
    setDragGhost(null);
  };

  const onLabelDragOver = (event: DragEvent<HTMLDivElement>) => {
    const labelId = event.dataTransfer.types.includes("application/x-neurotrace-label") ? "drag" : "";
    const canvas = canvasRef.current;
    if (labelId && canvas) {
      const canvasRect = canvas.getBoundingClientRect();
      if (event.clientX < canvasRect.left || event.clientX > canvasRect.right
        || event.clientY < canvasRect.top + CHANNEL_RAIL_HEADER_HEIGHT
        || event.clientY > canvasRect.bottom) {
        setDragGhost(null);
        return;
      }
      event.preventDefault();
      const row = channelRowFromClientY(event.clientY, canvasRect);
      if (row === null) {
        setDragGhost(null);
        return;
      }
      setDragGhost((current) => ({ labelId: current?.labelId ?? "", time: timeFromPointer(event, canvas, row, event.altKey) }));
    }
  };

  useEffect(() => {
    const applyPreview = () => {
      const drag = dragAnnotationRef.current;
      const patches = pendingAnnotationDragRef.current;
      dragFrameRef.current = null;
      if (!drag || !patches) return;
      setAnnotationDragPreview({ patches });
    };
    const onMove = (event: PointerEvent) => {
      const drag = dragAnnotationRef.current;
      const timeline = timelineRef.current;
      if (!drag || !timeline) return;
      const delta = ((event.clientX - drag.originX) / timeline.getBoundingClientRect().width) * timebase;
      if (drag.mode === "move" && drag.originals.length > 1) {
        const dragSampleRate = drag.original.channelScope
          ? meta.sampleRates[drag.original.channelScope.primarySourceIndex] ?? primarySampleRate(meta)
          : sourceRateForDisplayRow(display, meta, focusedChannel);
        const snappedDelta = snapTime(drag.original.start + delta, snapMode, dragSampleRate) - drag.original.start;
        const earliest = Math.min(...drag.originals.map((item) => item.start));
        const latest = Math.max(...drag.originals.map((item) => item.end));
        const sharedDelta = clamp(snappedDelta, -earliest, meta.durationSec - latest);
        const patches = Object.fromEntries(drag.originals.map((item) => [item.id, {
          start: item.start + sharedDelta,
          end: item.end + sharedDelta,
          track: item.track,
          geometry: annotationGeometry(item),
        } satisfies AnnotationDragPatch]));
        pendingAnnotationDragRef.current = patches;
        drag.moved = Math.abs(sharedDelta) > 1e-9;
        if (dragFrameRef.current === null) dragFrameRef.current = window.requestAnimationFrame(applyPreview);
        return;
      }
      const label = LABEL_BY_ID.get(drag.original.labelId);
      const originalGeometry = annotationGeometry(drag.original);
      const dragSampleRate = drag.original.channelScope
        ? meta.sampleRates[drag.original.channelScope.primarySourceIndex] ?? primarySampleRate(meta)
        : sourceRateForDisplayRow(display, meta, focusedChannel);
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
        [drag.id]: {
          start: normalized.start,
          end: normalized.end,
          track: normalized.track,
          geometry: normalized.geometry,
        },
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
      const patches = pendingAnnotationDragRef.current;
      if (drag.moved && patches) {
        undoRef.current.push({
          annotations: drag.snapshot,
          candidates: candidatesRef.current,
          activeCandidate: activeCandidateIndexRef.current,
        });
        if (undoRef.current.length > 100) undoRef.current.shift();
        redoRef.current = [];
        const changedAt = new Date().toISOString();
        const reopenedCandidateIds = new Set(drag.originals.flatMap((item) =>
          patches[item.id] && item.candidateId && item.status === "committed" ? [item.candidateId] : []));
        setAnnotations((current) => current.map((item) => {
          const patch = patches[item.id];
          return patch
            ? normalizeAnnotationGeometry({ ...item, ...patch, status: item.status === "committed" ? "draft" : item.status, revision: item.revision + 1, updatedAt: changedAt }, meta.durationSec)
            : item;
        }));
        reopenCandidateReviews(reopenedCandidateIds);
        const primaryPatch = patches[drag.id];
        if (drag.originals.length > 1) {
          setToast(`${drag.originals.length} selected labels moved together`);
        } else if (primaryPatch?.track !== drag.original.track) {
          setToast(primaryPatch.track === "instance"
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
  }, [display, focusedChannel, meta, reopenCandidateReviews, snapMode, timebase]);

  const startAnnotationDrag = (event: ReactPointerEvent, item: Annotation, mode: "move" | "start" | "end") => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedAnnotationId(item.id);
    const moveGroup = mode === "move" && selectedAnnotationIds.has(item.id) && selectedAnnotationIds.size > 1;
    const originals = moveGroup
      ? annotationsRef.current.filter((annotation) => selectedAnnotationIds.has(annotation.id) && annotationGeometry(annotation) !== "session")
      : [{ ...item }];
    if (!moveGroup) setSelectedAnnotationIds(new Set([item.id]));
    if (originals.some((annotation) => annotation.candidateId && annotation.status === "committed")) {
      setToast("Accepted source-event marks are locked — use Revise marks before dragging them");
      return;
    }
    if (annotationGeometry(item) === "session") {
      setToast("Entire-session labels always span the full recording");
      return;
    }
    pendingAnnotationDragRef.current = null;
    setAnnotationDragPreview(null);
    dragAnnotationRef.current = { id: item.id, mode, originX: event.clientX, original: { ...item }, originals, snapshot: annotationsRef.current, moved: false };
  };

  const onTimelinePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (event.button !== 0 || target.closest("[data-annotation-id], button")) return;
    event.preventDefault();
    annotationSelectionRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      selectedIds: new Set(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    const timelineRect = event.currentTarget.getBoundingClientRect();
    setSelectedAnnotationId(null);
    setSelectedAnnotationIds(new Set());
    setAnnotationSelectionBox({ left: event.clientX - timelineRect.left, top: event.clientY - timelineRect.top, width: 0, height: 0 });
  };

  const onTimelinePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const selectionDrag = annotationSelectionRef.current;
    const timeline = timelineRef.current;
    if (!selectionDrag || !timeline || selectionDrag.pointerId !== event.pointerId) return;
    const timelineRect = timeline.getBoundingClientRect();
    const leftClient = Math.min(selectionDrag.startClientX, event.clientX);
    const rightClient = Math.max(selectionDrag.startClientX, event.clientX);
    const topClient = Math.min(selectionDrag.startClientY, event.clientY);
    const bottomClient = Math.max(selectionDrag.startClientY, event.clientY);
    const box = {
      left: clamp(leftClient - timelineRect.left, 0, timelineRect.width),
      top: clamp(topClient - timelineRect.top, 0, timelineRect.height),
      width: Math.max(0, Math.min(rightClient, timelineRect.right) - Math.max(leftClient, timelineRect.left)),
      height: Math.max(0, Math.min(bottomClient, timelineRect.bottom) - Math.max(topClient, timelineRect.top)),
    };
    setAnnotationSelectionBox(box);
    if (box.width < 3 && box.height < 3) return;
    const nextIds = new Set<string>();
    timeline.querySelectorAll<HTMLElement>("[data-annotation-id]").forEach((element) => {
      const rect = element.getBoundingClientRect();
      const intersects = rect.right >= leftClient
        && rect.left <= rightClient
        && rect.bottom >= topClient
        && rect.top <= bottomClient;
      if (intersects && element.dataset.annotationId) nextIds.add(element.dataset.annotationId);
    });
    selectionDrag.selectedIds = nextIds;
    setSelectedAnnotationIds(nextIds);
    setSelectedAnnotationId(nextIds.values().next().value ?? null);
  };

  const onTimelinePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const selectionDrag = annotationSelectionRef.current;
    if (!selectionDrag || selectionDrag.pointerId !== event.pointerId) return;
    annotationSelectionRef.current = null;
    setAnnotationSelectionBox(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const selectedCount = selectionDrag.selectedIds.size;
    setToast(selectedCount
      ? `${selectedCount} label${selectedCount === 1 ? "" : "s"} selected — drag, use arrows, or press Delete`
      : "No labels inside selection box");
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
    const viewerRect = viewer.getBoundingClientRect();
    const canvasShell = event.target instanceof Element ? event.target.closest(".canvas-shell") : null;
    const rect = canvasShell?.getBoundingClientRect() ?? viewerRect;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      zoomWheelDeltaRef.current += event.deltaY;
      zoomWheelAnchorRef.current = viewStart
        + clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1) * timebase;
      if (zoomWheelFrameRef.current === null) {
        zoomWheelFrameRef.current = window.requestAnimationFrame(() => {
          const boundedDelta = clamp(zoomWheelDeltaRef.current, -120, 120);
          zoomWheelDeltaRef.current = 0;
          zoomWheelFrameRef.current = null;
          const factor = Math.exp(boundedDelta * Math.log(1.25) / 120);
          setTimeWindow(timebase * factor, zoomWheelAnchorRef.current);
        });
      }
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
  }, [expandedChannels, setTimeWindow, setViewStartSafe, timebase, viewStart]);

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
  }, [activeSessionContentView, hasRecording]);

  useEffect(() => () => {
    if (wheelFrameRef.current !== null) window.cancelAnimationFrame(wheelFrameRef.current);
    if (zoomWheelFrameRef.current !== null) window.cancelAnimationFrame(zoomWheelFrameRef.current);
    if (channelScrollFrameRef.current !== null) window.cancelAnimationFrame(channelScrollFrameRef.current);
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

  const updateActiveCandidateReview = useCallback((patch: Partial<Pick<Candidate, "badChannels" | "ictalChannels" | "legacyConfidence" | "confidence">>) => {
    if (!activeCandidateItem || ["reviewed", "skipped", "conflict"].includes(activeCandidateItem.status)) return;
    setCandidates((items) => items.map((item) => item.id === activeCandidateItem.id ? { ...item, ...patch } : item));
  }, [activeCandidateItem]);

  const updateMatlabExportIdentity = useCallback((patch: Partial<MatlabExportIdentity>) => {
    setSourceInterpretation((current) => {
      const identity = matlabExportIdentityFromInterpretation(current);
      if (!identity) return current;
      return applyMatlabExportIdentity(current ?? undefined, { ...identity, ...patch }) ?? current;
    });
  }, []);

  const beginActiveCandidateMarking = useCallback(() => {
    if (!activeCandidateItem) return;
    if (!reviewer.trim()) {
      setToast("Enter reviewer initials before marking this source event");
      return;
    }
    if (["reviewed", "skipped", "conflict"].includes(activeCandidateItem.status)
      && !window.confirm("Reopen this completed source-event decision for revision? The next acceptance will record a new reviewer timestamp.")) {
      setToast("Revision canceled — the completed source-event decision is unchanged");
      return;
    }
    if (activeCandidateAnnotation?.status === "committed") {
      updateAnnotation(activeCandidateAnnotation.id, { status: "draft" }, true, true);
      setSelectedAnnotationId(activeCandidateAnnotation.id);
      setSelectedAnnotationIds(new Set([activeCandidateAnnotation.id]));
      setShowAnnotationEditor(true);
      setToast("Decision reopened — edit the accepted interval, then save a new revision");
      return;
    }
    if (activeCandidateAnnotation) {
      commitMutation((items) => items.filter((item) => item.id !== activeCandidateAnnotation.id));
    }
    setCandidates((items) => items.map((item, index) => {
      if (index === activeCandidate) return { ...item, status: "active", reviewedAt: undefined };
      return item.status === "active" ? { ...item, status: "queued" } : item;
    }));
    jumpTo(activeCandidateItem.time);
    setSelection(null);
    setSelectedAnnotationId(null);
    setSelectedAnnotationIds(new Set());
    setMarkOnset(null);
    setActiveTool("seizure");
    setToast(`Source event ${activeCandidate + 1}/${candidates.length}: click seizure onset, then offset`);
  }, [activeCandidate, activeCandidateAnnotation, activeCandidateItem, candidates.length, commitMutation, jumpTo, reviewer, updateAnnotation]);

  const skipActiveCandidate = useCallback(() => {
    if (!activeCandidateItem) return;
    if (!reviewer.trim()) {
      setToast("Enter reviewer initials before skipping this source event");
      return;
    }
    commitMutation((items) => activeCandidateAnnotation?.status === "draft"
      ? items.filter((item) => item.id !== activeCandidateAnnotation.id)
      : items);
    const reviewedAt = new Date().toISOString();
    setCandidates((items) => items.map((item) =>
      item.id === activeCandidateItem.id ? {
        ...item,
        status: "skipped",
        reviewedAt,
        reviewerInitials: reviewer.trim().toUpperCase(),
        badChannels: "",
      } : item));
    setMarkOnset(null);
    setActiveTool("cursor");
    setSelection(null);
    setSelectedAnnotationId(null);
    setSelectedAnnotationIds(new Set());
    const next = advanceFromCandidate(activeCandidateItem.id);
    setToast(next ? `Skipped · next event: ${next.label}` : "Skipped · no unresolved source events remain");
  }, [activeCandidateAnnotation, activeCandidateItem, advanceFromCandidate, commitMutation, reviewer]);

  const acceptActiveCandidate = useCallback(() => {
    if (!activeCandidateItem) return;
    if (!reviewer.trim()) {
      setToast("Enter reviewer initials before accepting this source event");
      return;
    }
    if (!activeCandidateAnnotation) {
      setToast("Mark onset and offset before accepting this source event");
      return;
    }
    setSelectedAnnotationId(activeCandidateAnnotation.id);
    setSelectedAnnotationIds(new Set([activeCandidateAnnotation.id]));
    if (activeCandidateAnnotation.status === "committed") {
      const latestRevision = activeCandidateAnnotation.revisions?.[activeCandidateAnnotation.revisions.length - 1];
      setCandidates((items) => items.map((item) => item.id === activeCandidateItem.id ? {
        ...item,
        status: "reviewed",
        reviewedAt: item.reviewedAt ?? latestRevision?.committedAt ?? activeCandidateAnnotation.updatedAt,
        reviewerInitials: item.reviewerInitials || latestRevision?.reviewer || activeCandidateAnnotation.reviewer,
      } : item));
      const next = advanceFromCandidate(activeCandidateItem.id);
      setToast(next ? `Accepted · next event: ${next.label}` : "Accepted · no unresolved source events remain");
      return;
    }
    commitAnnotation(activeCandidateAnnotation, false, true);
  }, [activeCandidateAnnotation, activeCandidateItem, advanceFromCandidate, commitAnnotation, reviewer]);

  const selectInstanceQueueEntry = useCallback((index: number) => {
    const entry = instanceQueueEntries[index];
    if (!entry) return;
    if (entry.kind === "candidate") {
      const candidateIndex = candidates.findIndex((item) => item.id === entry.id);
      if (candidateIndex >= 0) selectCandidate(candidateIndex);
      setSelectedAnnotationId(null);
      setSelectedAnnotationIds(new Set());
      setToast(`File event: ${entry.label}`);
      return;
    }
    const annotation = annotations.find((item) => item.id === entry.id);
    if (!annotation) return;
    setSelectedAnnotationId(annotation.id);
    setSelectedAnnotationIds(new Set([annotation.id]));
    setCursorTime(annotation.start);
    setCursorLocked(true);
    jumpTo(annotation.start);
    setToast(`${entry.detail}: ${entry.label}`);
  }, [annotations, candidates, instanceQueueEntries, jumpTo, selectCandidate]);

  const loadSource = useCallback(async (source: SignalSource, file: File, interpretation?: Record<string, unknown>) => {
    const targetSessionId = activeSessionId;
    const nextMeta = sourceMeta(source);
    storeActiveSession();
    const previousSnapshot = sessionSnapshotsRef.current.get(targetSessionId);
    sourceVerificationAbortRef.current?.abort(new DOMException("Source verification superseded", "AbortError"));
    const verificationAbortController = new AbortController();
    sourceVerificationAbortRef.current = verificationAbortController;
    const ensureVerificationActive = () => {
      if (!verificationAbortController.signal.aborted) return;
      throw verificationAbortController.signal.reason
        ?? new DOMException("Source verification canceled", "AbortError");
    };
    const recommendedChannels = (Array.isArray(nextMeta.recommendedDisplayChannels)
      ? nextMeta.recommendedDisplayChannels
      : nextMeta.channelLabels.slice(0, 18).map((_, index) => index))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < nextMeta.channelLabels.length);

    // Install a read-only preview immediately. The exact content identity and
    // any matching recovery project attach only after the worker finishes.
    sourceVerificationRef.current = true;
    setVerifyingSource(true);
    sourceRef.current = source;
    setHasRecording(true);
    setMeta(nextMeta);
    setSessionKey(`verifying:${nextMeta.id}`);
    setRawSourceHash("");
    setSourceHash("");
    setSourceInterpretation(interpretation ?? null);
    setSelectedChannels(new Set(recommendedChannels));
    setBadChannels(new Set());
    rawWindowCacheRef.current = [];
    processedWindowCacheRef.current = [];
    envelopeWindowCacheRef.current = [];
    setDisplay(EMPTY_DISPLAY);
    setViewStart(0);
    setGain(1);
    setMontage("referential");
    setFilters({ ...DEFAULT_FILTERS });
    setCursorTime(0);
    setCursorLocked(false);
    setSelection(null);
    setInspectionRange(null);
    setInspectionDragging(false);
    setMarkOnset(null);
    setActiveTool("cursor");
    setAnnotationDragPreview(null);
    setTimebase(Math.min(20, Math.max(5, nextMeta.durationSec)));
    setWindowDraftUnit("s");
    setWindowDraftValue(null);
    setExpandedChannels(recommendedChannels.length > 10);
    setCandidates([]);
    setActiveCandidate(0);
    setSelectedAnnotationId(null);
    setSelectedAnnotationIds(new Set());
    setRecordingType(nextMeta.channelLabels.length > 64 ? "SEEG / iEEG" : "Scalp EEG");
    setReviewer("");
    annotationsRef.current = [];
    setAnnotations([]);
    undoRef.current = [];
    redoRef.current = [];
    setShowImport(false);

    let lastProgressBucket = -1;
    setToast("Waveform preview ready — verifying full source integrity…");
    let contentHash: string;
    try {
      const verification = await verifySourceOffThread(file, {
        edfHeader: source instanceof EDFSource ? source.header : undefined,
        signal: verificationAbortController.signal,
        onProgress: (bytesHashed, totalBytes) => {
          const bucket = totalBytes ? Math.floor((bytesHashed / totalBytes) * 10) : 10;
          if (bucket !== lastProgressBucket) {
            lastProgressBucket = bucket;
            setToast(`Waveform ready · verifying source integrity… ${Math.min(100, bucket * 10)}%`);
          }
        },
      });
      ensureVerificationActive();
      contentHash = verification.hash;
      if (source instanceof EDFSource && verification.edfAnnotations) {
        source.applyVerifiedAnnotations(
          verification.edfAnnotations.events,
          verification.edfAnnotations.warnings,
        );
      }
    const identityInterpretation = sourceIdentityInterpretation(interpretation);
    const interpretationMaterial = identityInterpretation ? JSON.stringify(identityInterpretation) : undefined;
    const interpretationHash = interpretationMaterial
      ? await sha256Blob(new Blob([`neurotrace-interpretation-v1\n${contentHash}\n${interpretationMaterial}`]))
      : contentHash;
    ensureVerificationActive();
    const nextKey = interpretationHash.slice(0, 32);
    let legacyRecoveryKey: string | null = null;
    if (identityInterpretation?.kind === "raw-int16-le"
      && identityInterpretation.physical_scale_uv_per_count === null) {
      const legacyIdentity = { ...identityInterpretation, physical_scale_uv_per_count: 1 };
      const legacyHash = await sha256Blob(new Blob([
        `neurotrace-interpretation-v1\n${contentHash}\n${JSON.stringify(legacyIdentity)}`,
      ]));
      ensureVerificationActive();
      legacyRecoveryKey = legacyHash.slice(0, 32);
    }
    const duplicateEntry = [...sessionSnapshotsRef.current.entries()].find(([id, snapshot]) =>
      id !== targetSessionId && snapshot.hasRecording && snapshot.sourceHash === interpretationHash);
    if (duplicateEntry) {
      const [duplicateId, duplicateSnapshot] = duplicateEntry;
      if (sourceVerificationAbortRef.current === verificationAbortController) {
        sourceVerificationAbortRef.current = null;
      }
      sourceVerificationRef.current = false;
      setVerifyingSource(false);
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
    let restoredMatlabExportIdentity: MatlabExportIdentity | null = null;
    let recoveryWarning: string | null = null;
    let usedLegacyRecoveryKey = false;
    const draftKey = `neurotrace:draft:${nextKey}`;
    const restoreDraft = () => {
      const keys = [draftKey, legacyRecoveryKey ? `neurotrace:draft:${legacyRecoveryKey}` : null].filter((key): key is string => Boolean(key));
      for (const key of keys) {
        const cached = localStorage.getItem(key);
        if (!cached) continue;
        restored = parseRecoveryDraft(cached, nextMeta.durationSec, nextMeta.channelLabels.length);
        usedLegacyRecoveryKey = key !== draftKey;
        return true;
      }
      return false;
    };
    const preserveUnreadableRecovery = (kind: "project" | "draft", raw: string) => {
      try {
        localStorage.setItem(`neurotrace:unreadable-${kind}:${nextKey}:${Date.now()}`, raw);
        return true;
      } catch {
        return false;
      }
    };
    let projectJson: string | null = null;
    let recoveryReadable = true;
    try {
      projectJson = localStorage.getItem(`neurotrace:project:${nextKey}`);
      if (!projectJson && legacyRecoveryKey) {
        projectJson = localStorage.getItem(`neurotrace:project:${legacyRecoveryKey}`);
        usedLegacyRecoveryKey = Boolean(projectJson);
      }
    } catch {
      recoveryReadable = false;
      recoveryWarning = "Local recovery is unavailable in this browser. This recording opened without recovered labels.";
    }
    if (!recoveryReadable) {
      // The recording can still open; the status message tells the reviewer that recovery was skipped.
    } else if (projectJson) {
      try {
        const project = parseRecoveryProject(projectJson, nextMeta.durationSec, nextMeta.channelLabels.length);
        restored = project.annotations;
        restoredCandidates = project.candidates;
        restoredActiveCandidate = project.activeCandidate;
        restoredBadChannels = project.badChannels;
        restoredReviewer = project.reviewer;
        if (project.recordingType) restoredRecordingType = project.recordingType;
        restoredMatlabExportIdentity = project.matlabExportIdentity;
      } catch {
        const preserved = preserveUnreadableRecovery("project", projectJson);
        try {
          const usedDraft = restoreDraft();
          recoveryWarning = usedDraft
            ? `The saved project could not be verified${preserved ? " and was preserved" : ""}; valid draft labels were recovered instead.`
            : `The saved project could not be verified${preserved ? " and was preserved" : ""}; this recording opened without recovered labels.`;
        } catch {
          const cached = localStorage.getItem(draftKey);
          if (cached) preserveUnreadableRecovery("draft", cached);
          recoveryWarning = `Saved project and draft labels could not be verified${preserved ? "; the project was preserved for support" : ""}. This recording opened without recovered labels.`;
        }
      }
    } else {
      try {
        restoreDraft();
      } catch {
        const cached = localStorage.getItem(draftKey);
        const preserved = cached ? preserveUnreadableRecovery("draft", cached) : false;
        recoveryWarning = `Saved draft labels could not be verified${preserved ? " and were preserved for support" : ""}. This recording opened without recovered labels.`;
      }
    }
    if (usedLegacyRecoveryKey && !recoveryWarning) {
      recoveryWarning = "Recovered prior DAT review state and migrated it to the unscaled raw-count display.";
    }
    if (activeSessionIdRef.current !== targetSessionId) {
      throw new Error("The active session changed while the recording was opening. Load it again in the intended tab.");
    }
    sourceVerificationRef.current = false;
    if (sourceVerificationAbortRef.current === verificationAbortController) {
      sourceVerificationAbortRef.current = null;
    }
    setVerifyingSource(false);
    setSessionTabs((current) => current.map((tab) => tab.id === targetSessionId
      ? { ...tab, title: shortFileName(nextMeta.name.replace(/\.[^.]+$/, ""), 22), hasRecording: true, recoveryStatus: "saved" }
      : tab));
    setSessionKey(nextKey);
    setRawSourceHash(contentHash);
    setSourceHash(interpretationHash);
    setSourceInterpretation(applyMatlabExportIdentity(interpretation, restoredMatlabExportIdentity) ?? null);
    setBadChannels(new Set(restoredBadChannels));
    setCandidates(restoredCandidates);
    setActiveCandidate(restoredActiveCandidate);
    setRecordingType(restoredRecordingType);
    setReviewer(restoredReviewer ?? "");
    annotationsRef.current = restored;
    setAnnotations(restored);
    setToast(recoveryWarning ?? (restored.length
      ? `Recovered ${restored.length} labels and local review state`
      : `${nextMeta.format} recording ready — ${nextMeta.channelLabels.length} channels${nextMeta.warnings.length ? ` · ${nextMeta.warnings.length} source warning${nextMeta.warnings.length === 1 ? "" : "s"}` : ""}`));
    return { restoredCandidates, restoredActiveCandidate };
    } catch (error) {
      if (sourceVerificationAbortRef.current === verificationAbortController) {
        sourceVerificationAbortRef.current = null;
      }
      sourceVerificationRef.current = false;
      setVerifyingSource(false);
      if (previousSnapshot && activeSessionIdRef.current === targetSessionId) applySessionSnapshot(previousSnapshot);
      throw error;
    }
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
        const source = await EDFSource.create(edf, { parseAnnotations: false });
        const opened = await loadSource(source, edf);
        if (!opened) return;
        const hasAnnotationChannels = source.header.signals.some((signal) => signal.isAnnotation);
        if (hasAnnotationChannels) setToast("Waveform ready — indexing EDF+ annotations in the background");
        window.setTimeout(() => {
          void source.loadAnnotations().then(() => {
            if (sourceRef.current !== source) return;
            const importedCandidates = source.events
              .filter((event) => event.timeSec >= 0 && event.timeSec < source.meta.durationSec)
              .filter((event) => isLegacySeizureCandidate(event.label))
              .map((event, index): Candidate => ({
                id: `edf-cand-${index}-${Math.round(event.timeSec * 1000)}`,
                time: event.timeSec,
                label: event.label,
                source: "bronze",
                status: "queued",
                confidence: 0,
                ictalChannels: "",
                legacyConfidence: "",
                reviewerInitials: "",
                badChannels: "",
              }));
            if (importedCandidates.length) {
              const queue = reconcileCandidateQueue(importedCandidates, opened.restoredCandidates, opened.restoredActiveCandidate);
              const resumeCandidate = queue.candidates[queue.activeIndex];
              setCandidates(queue.candidates);
              setActiveCandidate(queue.activeIndex);
              setViewStart(clamp(resumeCandidate.time - 10, 0, Math.max(0, source.meta.durationSec - 20)));
              setCursorTime(resumeCandidate.time);
              setCursorLocked(true);
              setToast(`${importedCandidates.length} EDF+ source event${importedCandidates.length === 1 ? "" : "s"} indexed`);
            } else if (hasAnnotationChannels) {
              setToast("EDF+ annotation index complete — no seizure-keyword events found");
            }
          }).catch((error: unknown) => {
            if (sourceRef.current !== source) return;
            const message = error instanceof Error ? error.message : "EDF+ annotations could not be indexed";
            if (!source.meta.warnings.includes(message)) source.meta.warnings.push(message);
            setToast(`Waveform remains available · ${message}`);
          });
        }, 0);
      } else if (dat) {
        let legacyMetadata: LegacyMatMetadata | null = null;
        const companionPath = portablePathParts(mat?.webkitRelativePath || mat?.name || "");
        const datPath = portablePathParts(dat.webkitRelativePath || dat.name);
        setLegacyExportHints({
          patientId: datPath.topDirectory || companionPath.topDirectory,
          matPath: companionPath.path,
          dataDirectory: datPath.directory || companionPath.directory,
          datFile: datPath.fileName.replace(/\.dat$/i, ""),
        });
        if (mat) {
          try {
            legacyMetadata = await parseLegacyMatMetadata(mat);
            setSelectedLegacyEventIndices(new Set(legacyMetadata.events.flatMap((event, index) =>
              isLegacySeizureCandidate(event.label) ? [index] : [])));
            setDatMapping({
              sampleRate: legacyMetadata?.sampleRate ?? 0,
              channelCount: legacyMetadata?.channelCount || legacyMetadata?.channelLabels.length || 0,
              physicalScale: "",
            });
          } catch (error) {
            setSelectedLegacyEventIndices(new Set());
            setToast(`Companion MAT needs manual mapping: ${error instanceof Error ? error.message : "metadata could not be read"}`);
          }
        }
        if (!legacyMetadata) {
          setDatMapping({ sampleRate: 0, channelCount: 0, physicalScale: "" });
          setSelectedLegacyEventIndices(new Set());
        }
        setPendingDat(dat);
        setPendingLegacyMatFile(mat ?? null);
        setPendingLegacyMeta(legacyMetadata);
        setShowImport(true);
        if (legacyMetadata) {
          const reviewableEvents = legacyMetadata.events.filter((event) => isLegacySeizureCandidate(event.label)).length;
          setToast(`Legacy MAT + DAT mapped — ${reviewableEvents} seizure-keyword event${reviewableEvents === 1 ? "" : "s"} ready for review`);
        }
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
    if (!Number.isFinite(datMapping.sampleRate) || !(datMapping.sampleRate > 0)
      || !Number.isInteger(datMapping.channelCount) || !(datMapping.channelCount > 0)
      || !datPhysicalScaleValid) {
      setToast("Confirm a positive sample rate and whole-number channel count; any supplied µV/count scale must be positive");
      return;
    }
    importBusyRef.current = true;
    setImportBusy(true);
    try {
      const companionMatHash = pendingLegacyMatFile
        ? (await verifySourceOffThread(pendingLegacyMatFile)).hash
        : null;
      const companionPath = portablePathParts(pendingLegacyMatFile?.webkitRelativePath || pendingLegacyMatFile?.name || "");
      const datPath = portablePathParts(pendingDat.webkitRelativePath || pendingDat.name);
      const verifiedPhysicalScale = datMapping.physicalScale === "" ? undefined : datMapping.physicalScale;
      const source = await RawDatSource.create(pendingDat, {
        sampleRate: datMapping.sampleRate,
        channelCount: datMapping.channelCount,
        physicalScale: verifiedPhysicalScale,
        channelLabels: pendingLegacyMeta?.channelLabels.length === datMapping.channelCount ? pendingLegacyMeta.channelLabels : undefined,
        channelUnits: verifiedPhysicalScale === undefined ? "ADC count" : "µV",
        warnings: [
          ...(pendingLegacyMeta?.warnings ?? []),
          verifiedPhysicalScale === undefined
            ? "No physical calibration was supplied; display sensitivity follows the MATLAB reviewer's 15,000-count row spacing."
            : "Physical scale is reviewer-confirmed mapping metadata; the headerless DAT does not encode calibration.",
        ],
        assumptions: [
          `confirmed sample rate ${datMapping.sampleRate} Hz`,
          `confirmed channel count ${datMapping.channelCount}`,
          verifiedPhysicalScale === undefined
            ? "unscaled signed int16 ADC counts"
            : `confirmed physical scale ${verifiedPhysicalScale} µV/count`,
        ],
      });
      const interpretation = {
        kind: "raw-int16-le",
        companion_mat_sha256: companionMatHash,
        companion_mat_name: pendingLegacyMatFile?.name ?? null,
        companion_mat_path: legacyExportHints.matPath.trim() || companionPath.path || null,
        dat_file_name: pendingDat.name,
        dat_file_base: legacyExportHints.datFile.trim() || datPath.fileName.replace(/\.dat$/i, ""),
        data_dir_hint: legacyExportHints.dataDirectory.trim() || datPath.directory || companionPath.directory || null,
        patient_id_hint: legacyExportHints.patientId.trim() || datPath.topDirectory || companionPath.topDirectory || null,
        sample_rate_hz: datMapping.sampleRate,
        channel_count: datMapping.channelCount,
        physical_scale_uv_per_count: verifiedPhysicalScale ?? null,
        display_amplitude_mode: verifiedPhysicalScale === undefined ? "legacy-raw-counts" : "calibrated-microvolts",
        layout: "sample-major channel-interleaved signed int16 little-endian",
      };
      const opened = await loadSource(source, pendingDat, interpretation);
      if (!opened) return;
      if (pendingLegacyMeta?.events.length && datMapping.channelCount >= 100) {
        const importedCandidates = pendingLegacyMeta.events
          .map((event, sourceIndex) => ({ event, sourceIndex }))
          .filter(({ event }) => isLegacySeizureCandidate(event.label))
          .filter(({ event }) => event.timeSec >= 0 && event.timeSec < source.meta.durationSec)
          .map((entry, candidateIndex) => ({ ...entry, candidateIndex }))
          .filter(({ sourceIndex }) => selectedLegacyEventIndices.has(sourceIndex))
          .map(({ event, candidateIndex }): Candidate => ({
            id: `cand-${candidateIndex}-${Math.round(event.timeSec * 1000)}`,
            time: event.timeSec,
            label: event.label,
            source: "bronze",
            status: "queued",
            confidence: 0,
            ictalChannels: "",
            legacyConfidence: "",
            reviewerInitials: "",
            badChannels: "",
          }));
        const queue = reconcileCandidateQueue(importedCandidates, opened.restoredCandidates, opened.restoredActiveCandidate);
        if (queue.candidates.length) {
          const resumeCandidate = queue.candidates[queue.activeIndex];
          setCandidates(queue.candidates);
          setActiveCandidate(queue.activeIndex);
          setViewStart(clamp(resumeCandidate.time - 10, 0, Math.max(0, source.meta.durationSec - 20)));
          setCursorTime(resumeCandidate.time);
          setCursorLocked(true);
          setToast(importedCandidates.length
            ? `Ready to review ${importedCandidates.length} selected seizure-source event${importedCandidates.length === 1 ? "" : "s"}`
            : `No new source events selected · preserved ${queue.candidates.length} prior decision record${queue.candidates.length === 1 ? "" : "s"}`);
        } else {
          setCandidates([]);
          setActiveCandidate(0);
          setToast("Recording opened, but no selected seizure-keyword events remain to review");
        }
      } else if (pendingLegacyMeta && datMapping.channelCount < 100) {
        setCandidates([]);
        setActiveCandidate(0);
        setToast("Recording opened, but legacy candidate review is disabled because this session has fewer than 100 channels");
      }
      setPendingDat(null);
      setPendingLegacyMatFile(null);
      setPendingLegacyMeta(null);
      setSelectedLegacyEventIndices(new Set());
      setLegacyExportHints({ patientId: "", matPath: "", dataDirectory: "", datFile: "" });
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Raw binary mapping failed");
    } finally {
      importBusyRef.current = false;
      setImportBusy(false);
    }
  };

  const exportBundle = () => {
    if (sourceVerificationRef.current) {
      setToast("Source verification must finish before export");
      return;
    }
    if (meta.details?.discontinuous === true) {
      setSessionMapTab("qc");
      setShowSessionMap(true);
      setToast("Export blocked: EDF+D gaps need a discontinuous time-axis conversion before model-ready export");
      return;
    }
    const sampleRate = primarySampleRate(meta);
    const uniformSampleRate = meta.sampleRates.length > 0 && meta.sampleRates.every((rate) => Math.abs(rate - sampleRate) < 1e-9);
    const hintedPatientId = typeof sourceInterpretation?.patient_id_hint === "string"
      ? sourceInterpretation.patient_id_hint.trim()
      : "";
    const patientId = hintedPatientId || patientLabel(meta);
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
    const candidateEventsTsv = [["candidate_id", "source_event_time", "source_event_label", "status", "source", "confidence", "matlab_confidence_score", "bad_channels", "ictal_channels", "reviewer_initials", "reviewed_at", "linked_annotation_ids", "linked_annotation_statuses", "relative_onsets", "relative_offsets"].join("\t"), ...candidates.map((candidate) => {
      const linked = annotations.filter((item) => item.candidateId === candidate.id);
      return [
        candidate.id,
        candidate.time.toFixed(6),
        candidate.label,
        candidate.status,
        candidate.source,
        candidate.confidence,
        candidate.legacyConfidence ?? "",
        candidate.badChannels ?? "",
        candidate.ictalChannels ?? "",
        candidate.reviewerInitials ?? "",
        candidate.reviewedAt ?? "",
        linked.map((item) => item.id).join("|"),
        linked.map((item) => item.status).join("|"),
        linked.map((item) => (item.start - candidate.time).toFixed(6)).join("|"),
        linked.map((item) => (item.end - candidate.time).toFixed(6)).join("|"),
      ].map(tsvCell).join("\t");
    })].join("\n");
    const matlabCompatibilityRows = [[
      "patient_id",
      "reviewer_initials",
      "mat_path",
      "data_dir",
      "dat_file",
      "event_label",
      "event_time_original_sec",
      "onset_relative_to_annotation_sec",
      "onset_absolute_sec",
      "offset_relative_to_annotation_sec",
      "offset_absolute_sec",
      "seizure_duration_sec",
      "sampling_rate",
      "n_channels",
      "bad_channels",
      "ictal_channels",
      "confidence_score",
      "review_status",
      "review_timestamp",
      "accepted",
    ].join(","), ...candidates.filter((candidate) => candidate.status === "skipped" || (
      candidate.status === "reviewed" && annotations.some((item) => item.candidateId === candidate.id && item.labelId === "ictal" && item.status === "committed")
    )).map((candidate) => {
      const linkedCandidates = [...annotations].reverse().filter((item) => item.candidateId === candidate.id && item.labelId === "ictal");
      const linked = candidate.status === "reviewed"
        ? linkedCandidates.find((item) => item.status === "committed")
        : undefined;
      const accepted = candidate.status === "reviewed" && linked?.status === "committed";
      const reviewStatus = accepted ? "accepted" : "skipped";
      const companionMatName = typeof sourceInterpretation?.companion_mat_path === "string" && sourceInterpretation.companion_mat_path
        ? sourceInterpretation.companion_mat_path
        : typeof sourceInterpretation?.companion_mat_name === "string"
          ? sourceInterpretation.companion_mat_name
          : "";
      const sourceDataDirectory = typeof sourceInterpretation?.data_dir_hint === "string"
        ? sourceInterpretation.data_dir_hint
        : "";
      const datFile = typeof sourceInterpretation?.dat_file_base === "string" && sourceInterpretation.dat_file_base
        ? sourceInterpretation.dat_file_base
        : meta.name.replace(/\.dat$/i, "");
      return [
        patientId,
        candidate.reviewerInitials || linked?.reviewer || reviewer,
        companionMatName,
        sourceDataDirectory,
        datFile,
        candidate.label,
        candidate.time.toFixed(6),
        accepted && linked ? (linked.start - candidate.time).toFixed(6) : "NaN",
        accepted && linked ? linked.start.toFixed(6) : "NaN",
        accepted && linked ? (linked.end - candidate.time).toFixed(6) : "NaN",
        accepted && linked ? linked.end.toFixed(6) : "NaN",
        accepted && linked ? Math.max(0, linked.end - linked.start).toFixed(6) : "NaN",
        sampleRate,
        meta.channelLabels.length,
        accepted ? normalizeChannelList(candidate.badChannels ?? "") || "NA" : "",
        accepted ? normalizeChannelList(candidate.ictalChannels ?? "") || "NA" : "",
        accepted ? candidate.legacyConfidence || "NA" : "",
        reviewStatus,
        formatMatlabTimestamp(candidate.reviewedAt ?? linked?.updatedAt),
        accepted ? 1 : 0,
      ].map(csvCell).join(",");
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
    const manifest = JSON.stringify({ schema: "neurotrace-forecasting-manifest/1.1", patient: patientId, recording_type: recordingType, session: recordingId, files: ["events.tsv", "candidate_events.tsv", "matlab_compatibility.csv", "channels.tsv", "recording.json", "annotations.jsonl", "windows.csv", "ontology.json", "qc_report.json"], leakage_guard: "Assign train/validation/test split by patient; current split is unassigned." }, null, 2);
    const readme = "NeuroTrace model-ready annotation bundle\n\nRaw EEG is not included. Seconds are authoritative. Sample positions are only emitted when a universal or annotation-specific channel rate exists. Only committed labels appear in events.tsv; drafts and suggestions remain in annotations.jsonl for audit. candidate_events.tsv preserves source-event lineage and relative timing. matlab_compatibility.csv provides one row per completed source-event decision using the 20-column seizure_annotation_tool.m schema, including accepted/skipped status, event-relative marks, channel notes, and 1–3 confidence. Review recording.json and qc_report.json before training. Group dataset splits by patient to prevent leakage.\n";
    const zip = createStoredZip([
      { name: `${base}/events.tsv`, content: eventsTsv },
      { name: `${base}/candidate_events.tsv`, content: candidateEventsTsv },
      { name: `${base}/matlab_compatibility.csv`, content: matlabCompatibilityRows },
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
      const target = event.target as HTMLElement | null;
      const interactiveTarget = target?.closest("input, textarea, select, button, a, [role='button'], [contenteditable='true']");
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
        if (confirmCommit.length) {
          setConfirmCommit([]);
          setCommitAdvanceAfter(false);
        }
        else if (showHelp) setShowHelp(false);
        else if (showSettings) setShowSettings(false);
        else if (showChannels) setShowChannels(false);
        else if (showSessionMap) setShowSessionMap(false);
        else if (showPatientInfo) setShowPatientInfo(false);
        else if (showAnnotationEditor) setShowAnnotationEditor(false);
        else if (queueDetailEntry) setQueueDetailTarget(null);
        else if (showImport && !importBusy) setShowImport(false);
        return;
      }
      if (modalOpen) return;
      if (interactiveTarget) return;
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
        setAnnotationSelectionBox(null);
        annotationSelectionRef.current = null;
        (event.target as HTMLElement | null)?.blur?.();
        setSelectedAnnotationId(null);
        setSelectedAnnotationIds(new Set());
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
      const lower = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && lower === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (selectedAnnotationIds.size) moveSelectedAnnotations(-1, event.shiftKey);
        else setViewStartSafe((value) => value - (event.shiftKey ? 10 : 1));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        if (selectedAnnotationIds.size) moveSelectedAnnotations(1, event.shiftKey);
        else setViewStartSafe((value) => value + (event.shiftKey ? 10 : 1));
      } else if (event.key === "PageDown") {
        event.preventDefault(); setViewStartSafe((value) => value + timebase);
      } else if (event.key === "PageUp") {
        event.preventDefault(); setViewStartSafe((value) => value - timebase);
      } else if (lower === controlBindings.redo && event.shiftKey) {
        redo();
      } else if (lower === controlBindings.undo && !event.shiftKey) {
        if (markOnset !== null) {
          setMarkOnset(null);
          setActiveTool("seizure");
          setToast("Pending seizure onset removed");
        } else {
          undo();
        }
      } else if (lower === controlBindings.ictalOnset) {
        setMarkOnset(cursorTime); setActiveTool("seizure"); setToast(`Onset placed at ${formatClock(cursorTime, true)} — press ${controlBindings.ictalOffset.toUpperCase()} at offset`);
      } else if (lower === controlBindings.ictalOffset && markOnset !== null) {
        if (cursorTime > markOnset) { addAnnotation(LABEL_BY_ID.get("ictal")!, markOnset, cursorTime); setMarkOnset(null); setActiveTool("cursor"); }
        else setToast("Offset must be after onset");
      } else if (lower === controlBindings.commit || ((event.key === "Enter" || event.code === "Space") && target === canvasRef.current)) {
        if (event.code === "Space") event.preventDefault();
        const selectedBelongsToActiveCandidate = !selectedAnnotation
          || (selectedAnnotation.id === activeCandidateAnnotation?.id
            && selectedAnnotation.candidateId === activeCandidateItem?.id
            && selectedAnnotation.labelId === "ictal");
        if (activeCandidateItem
          && !["reviewed", "skipped", "conflict"].includes(activeCandidateItem.status)
          && selectedBelongsToActiveCandidate) acceptActiveCandidate();
        else commitSelected();
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedAnnotationIds.size) {
        event.preventDefault(); deleteSelectedAnnotations();
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
  }, [acceptActiveCandidate, activeCandidate, activeCandidateAnnotation, activeCandidateItem, activeQueueIndex, addAnnotation, candidates, commitSelected, confirmCommit.length, controlBindings, cursorLocked, cursorTime, deleteSelectedAnnotations, display.primarySourceIndices, focusedChannel, hasRecording, importBusy, instanceQueueEntries, markOnset, meta.channelLabels, moveSelectedAnnotations, placePaletteLabel, queueDetailEntry, redo, selectInstanceQueueEntry, selectedAnnotation, selectedAnnotationIds, selectedChannels, setViewStartSafe, showAnnotationEditor, showChannels, showHelp, showImport, showPatientInfo, showSessionMap, showSettings, timebase, undo, zoomTimeWindow]);

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
    ? annotations.map((item) => annotationDragPreview.patches[item.id]
      ? normalizeAnnotationGeometry({ ...item, ...annotationDragPreview.patches[item.id] }, meta.durationSec)
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
  const resourcePanelActive = rightPanelOpen && rightPanelView === "resources";
  const selectRightPanelTool = (view: "labels" | "inspect") => {
    setLastRightPanelToolView(view);
    setRightPanelView(view);
    setRightPanelOpen(true);
    if (view === "inspect") {
      setSelection(null);
      setInspectionRange(null);
      setInspectionDragging(false);
      setMarkOnset(null);
      setActiveTool("cursor");
      setToast("General info mode — click a waveform point to inspect it, or drag a box to zoom");
    } else {
      setInspectionRange(null);
      setInspectionDragging(false);
      setToast("Labeling mode — drag across time to select a labeling window");
    }
  };
  const activeDisplayBytes = display.data.reduce((sum, channel) => sum + channel.byteLength, 0)
    + display.envelopes.reduce((sum, envelope) => sum + (envelope
      ? envelope.minima.byteLength + envelope.maxima.byteLength + envelope.gaps.byteLength
      : 0), 0);

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
                <button
                  className={`session-tab-structure ${tab.contentView === "structure" ? "active" : ""}`}
                  disabled={importBusy || !tabHasRecording}
                  aria-label={`${tab.contentView === "structure" ? "Show recording" : "Show file structure"} for ${tab.title}`}
                  aria-pressed={tab.contentView === "structure"}
                  title={tabHasRecording ? tab.contentView === "structure" ? "Show recording" : "Show file structure" : "Load a recording to inspect its file structure"}
                  onClick={() => toggleSessionContentView(tab.id)}
                ><span className="file-structure-glyph" aria-hidden="true"><i /><i /><i /></span></button>
                <button className="session-tab-close" disabled={importBusy} aria-label={`Close ${tab.title}`} title={`Close ${tab.title}`} onClick={() => closeSession(tab.id)}>×</button>
              </div>;
            })}
          </div>
          <button className="add-session-tab" disabled={importBusy} aria-label="Add blank session" title="Add blank session" onClick={createBlankSession}>+</button>
        </nav>
        <div className="top-actions utility-actions">
          <button
            className={`utility-button ${resourcePanelActive ? "active" : ""}`}
            aria-label={resourcePanelActive ? "Return to right panel tools" : "Show resource usage"}
            aria-pressed={resourcePanelActive}
            title={resourcePanelActive ? "Return to right panel tools" : "Resource usage"}
            onClick={() => {
              if (resourcePanelActive) {
                setRightPanelView(lastRightPanelToolView);
                return;
              }
              if (rightPanelView !== "resources") setLastRightPanelToolView(rightPanelView);
              setRightPanelView("resources");
              setRightPanelOpen(true);
            }}
          ><span className="resource-glyph" aria-hidden="true"><i /><i /><i /></span></button>
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
            <span>Open Patient Info {hasRecording && `(${effectivePatientLabel})`}</span><b aria-hidden="true">↗</b>
          </button>

          <button className="session-map-row" disabled={!hasRecording} onClick={() => {
            setSessionMapTab("map");
            setShowSessionMap(true);
          }}><span>Session Map</span><b aria-hidden="true">↗</b></button>

          <section className="session-labels-section" ref={sessionLabelsSectionRef} style={{ height: sessionLabelsHeight }}>
            <div className="sidebar-centered-heading">
              <strong>Session Labels</strong>
              <span>{sessionContextAnnotations.length}</span>
              <div className="session-context-menu-wrap">
                <button className="sidebar-add-button" disabled={!reviewReady} aria-label="Add session label" title={verifyingSource ? "Review edits unlock after source verification" : "Add entire-session context"} onClick={() => setShowSessionContextPicker((value) => !value)}>＋</button>
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
                  setSelectedAnnotationIds(new Set([item.id]));
                }} style={{ "--label-color": label?.color } as React.CSSProperties}>
                  <i /><span><strong>{label?.name ?? item.labelId}</strong><small>{item.notes || "Entire recording"}</small></span>
                </button>;
              }) : <div className="empty-session-labels"><strong>No session labels</strong><span>Use + above to add one.</span></div>}
            </div>
          </section>

          <div
            className="left-split-resize-handle"
            role="separator"
            tabIndex={0}
            aria-label="Resize Session Labels and Instance Queue"
            aria-orientation="horizontal"
            aria-valuemin={105}
            aria-valuemax={320}
            aria-valuenow={Math.round(sessionLabelsHeight)}
            title="Drag to resize Session Labels and Instance Queue"
            onPointerDown={(event) => {
              event.preventDefault();
              const sessionHeight = sessionLabelsSectionRef.current?.getBoundingClientRect().height ?? sessionLabelsHeight;
              const queueHeight = queueSectionRef.current?.getBoundingClientRect().height ?? 170;
              sessionQueueResizeRef.current = {
                startY: event.clientY,
                startHeight: sessionHeight,
                availableHeight: sessionHeight + queueHeight,
              };
            }}
            onKeyDown={(event) => {
              if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
              event.preventDefault();
              setSessionLabelsHeight((height) => clamp(height + (event.key === "ArrowDown" ? 10 : -10), 105, 320));
            }}
          ><span /></div>

          <section className="queue-section" ref={queueSectionRef}>
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
                <label className="queue-confidence" title={entry.locked ? "Reopen the source-event decision before editing confidence" : "Editable confidence percentage"}>
                  <input type="number" min="0" max="100" step="1" disabled={entry.locked} value={entry.confidence} aria-label={`Confidence for ${entry.label}`} onChange={(event) => updateQueueConfidence(entry.kind, entry.id, Number(event.target.value))} />
                  <span>%</span>
                </label>
                <button className="queue-arrow" aria-label={`Open details for ${entry.label}`} title={`Open ${entry.label} details`} onClick={() => setQueueDetailTarget({ kind: entry.kind, id: entry.id })}>›</button>
              </div>) : <div className="empty-queue"><strong>No events or instance labels</strong><p>{hasRecording ? "File events, instance labels, and timed context appear here." : "Load a recording to begin."}</p></div>}
            </div>
          </section>
        </aside>

        <section className="review-surface" id="active-session-workspace" role="tabpanel">
          {activeSessionContentView === "structure" && hasRecording ? <FileStructurePanel
            meta={meta}
            selectedChannels={selectedChannels}
            badChannels={badChannels}
            recordingType={recordingType}
            verifyingSource={verifyingSource}
            sourceHash={sourceHash}
          /> : <>
          <div className="viewer-toolbar">
            <div className="panel-toggle-pair" aria-label="Workspace panels">
              <button className={`panel-icon-button ${leftPanelOpen ? "active" : ""}`} aria-label={`${leftPanelOpen ? "Hide" : "Show"} left panel`} aria-pressed={leftPanelOpen} title={`${leftPanelOpen ? "Hide" : "Show"} recording panel`} onClick={() => setLeftPanelOpen((value) => !value)}><span className="panel-glyph left" aria-hidden="true"><i /><i /><i /></span></button>
              <button className={`panel-icon-button ${rightPanelOpen ? "active" : ""}`} aria-label={`${rightPanelOpen ? "Hide" : "Show"} right panel`} aria-pressed={rightPanelOpen} title={`${rightPanelOpen ? "Hide" : "Show"} ${rightPanelView === "resources" ? "resource usage" : rightPanelView === "inspect" ? "general info" : "context and label"} panel`} onClick={() => setRightPanelOpen((value) => !value)}><span className="panel-glyph right" aria-hidden="true"><i /><i /><i /></span></button>
              <button className={`panel-bottom-button ${bottomTracksOpen ? "active" : ""}`} aria-label={`${bottomTracksOpen ? "Hide" : "Show"} bottom label tracks`} aria-pressed={bottomTracksOpen} title={`${bottomTracksOpen ? "Hide" : "Show"} bottom label tracks`} onClick={() => setBottomTracksOpen((value) => !value)}><span className="bottom-panel-glyph" aria-hidden="true"><i /><i /><i /></span></button>
            </div>
            <span className="toolbar-kicker">Signal tools</span>
            <button className={`spectrum-button ${spectrogramOpen ? "active" : ""}`} aria-label="Spectrum" disabled={!hasRecording} onClick={() => setSpectrogramOpen((value) => !value)}><span className="spectrum-glyph" aria-hidden="true"><i /><i /><i /><i /></span><b>Spectrum</b></button>
            <label className="toolbar-select"><span>Montage</span><select aria-label="Montage" disabled={!hasRecording} value={montage} onChange={(event) => setMontage(event.target.value as MontageMode)}><option value="referential">Recorded reference</option><option value="average">Average reference</option><option value="bipolar">Anatomical bipolar</option></select></label>
            <button className={`compact-toggle ${showFilters ? "active" : ""}`} aria-label="Filters" disabled={!hasRecording} onClick={() => setShowFilters((value) => !value)}><span className="filter-glyph">≋</span> Filters <i>{filters.enabled ? `${filters.highPassHz}–${filters.lowPassHz} · ${filters.notchHz}Hz` : "Raw"}</i></button>
            <div className={`time-window-control ${windowDraftValue !== null ? "pending" : ""}`} role="group" aria-label="Window">
              <span className="window-control-label">Window</span>
              <label className="window-amount-field"><input
                disabled={!hasRecording}
                aria-label={`Window amount in ${windowDraftUnit}`}
                type="number"
                min={windowDraftMinimum}
                max={windowDraftMaximum}
                step="any"
                value={windowDraftDisplayValue}
                onChange={(event) => setWindowDraftValue(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") syncWindowDraft(); }}
              /></label>
              <div className="window-unit-picker">
                <b>{windowDraftUnit}</b>
                <button disabled={!hasRecording} aria-label="Cycle window time unit" title="Cycle time unit" onClick={cycleWindowDraftUnit}><span aria-hidden="true">…</span></button>
              </div>
              <div className="window-step-buttons">
                <button disabled={!hasRecording} aria-label="Increase window amount" title="Increase staged window amount" onClick={() => adjustWindowDraft(1)}>+</button>
                <button disabled={!hasRecording} aria-label="Decrease window amount" title="Decrease staged window amount" onClick={() => adjustWindowDraft(-1)}>−</button>
              </div>
              <button className="window-sync-button" disabled={!hasRecording || windowDraftValue === null} aria-label="Sync window amount and unit" title="Apply the staged window amount and unit" onClick={syncWindowDraft}><span aria-hidden="true">✓</span></button>
            </div>
            <div className="gain-control" role="group" aria-label="Gain"><span>Gain</span><b>{gain.toFixed(1)}×</b><div className="gain-step-buttons"><button disabled={!hasRecording} aria-label="Increase gain" title="Increase gain" onClick={() => setGain((value) => Math.min(8, value * 1.25))}>+</button><button disabled={!hasRecording} aria-label="Decrease gain" title="Decrease gain" onClick={() => setGain((value) => Math.max(0.25, value / 1.25))}>−</button></div></div>
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

          {hasRecording && activeCandidateItem && <section className="candidate-review-bar" aria-label="Source event review" data-review-status={activeCandidateItem.status}>
            <div className="candidate-review-identity">
              <span>Source event {activeCandidate + 1}/{candidates.length}</span>
              <strong title={activeCandidateItem.label}>{activeCandidateItem.label}</strong>
              <small>{formatClock(activeCandidateItem.time, true)} absolute · {activeCandidateItem.status}</small>
            </div>
            <div className="candidate-relative-times" aria-label="Event-relative seizure marks">
              <span>ONSET <b>{activeCandidateOnset === null ? "—" : formatRelativeTime(activeCandidateOnset - activeCandidateItem.time)}</b></span>
              <i />
              <span>OFFSET <b>{activeCandidateOffset === null ? "—" : formatRelativeTime(activeCandidateOffset - activeCandidateItem.time)}</b></span>
            </div>
            <label className="candidate-review-field reviewer-field"><span>Reviewer</span><input value={reviewer} maxLength={12} placeholder="Initials" onChange={(event) => setReviewer(event.target.value.toUpperCase())} /></label>
            <label className="candidate-review-field confidence-score"><span>Confidence</span><select disabled={candidateDecisionLocked} value={activeCandidateItem.legacyConfidence ?? ""} onChange={(event) => {
              const value = event.target.value as Candidate["legacyConfidence"];
              updateActiveCandidateReview({ legacyConfidence: value, confidence: value ? Number(value) * 33 + (value === "3" ? 1 : 0) : 0 });
            }}><option value="">NA · Not rated</option><option value="1">1 · Low</option><option value="2">2 · Medium</option><option value="3">3 · High</option></select></label>
            <label className="candidate-review-field bad-channel-field"><span>Bad channels (this event)</span><input disabled={candidateDecisionLocked} value={activeCandidateItem.badChannels ?? ""} placeholder="e.g. LA8,RA3" onChange={(event) => updateActiveCandidateReview({ badChannels: event.target.value })} /></label>
            <label className="candidate-review-field ictal-channel-field"><span>Ictal channels (optional)</span><input disabled={candidateDecisionLocked} value={activeCandidateItem.ictalChannels ?? ""} placeholder="e.g. LA1-LA4" onChange={(event) => updateActiveCandidateReview({ ictalChannels: event.target.value })} /></label>
            <div className="candidate-review-actions">
              <button className={`button secondary ${activeTool === "seizure" ? "active" : ""}`} onClick={beginActiveCandidateMarking}>{activeTool === "seizure" ? markOnset === null ? "Click onset" : "Click offset" : activeCandidateAnnotation?.status === "committed" ? "Revise marks" : activeCandidateAnnotation ? "Redo marks" : "Mark onset / offset"}</button>
              <button className="button primary" disabled={!activeCandidateAnnotation || activeCandidateItem.status === "skipped" || activeCandidateItem.status === "conflict"} onClick={acceptActiveCandidate}>Accept &amp; next</button>
              <button className="button quiet" disabled={candidateDecisionLocked} onClick={skipActiveCandidate}>Skip</button>
            </div>
          </section>}

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

          <div ref={viewerRef} className={`signal-and-tracks ${spectrogramOpen ? "with-spectrogram" : ""}`}>
            <div
              ref={waveformScrollRef}
              className={`waveform-wrap ${expandedChannels ? "channel-scroll-mode" : ""}`}
              style={{ "--channel-content-height": `${Math.max(245, channelRowLayout.totalUnits * 60 + 28)}px` } as React.CSSProperties}
              onScroll={updateExpandedChannelViewport}
            >
              <div className="channel-rail" style={{ gridTemplateRows: `repeat(${channelRowLayout.totalUnits}, 1fr)` }}>
                <button className="channel-manager-button" aria-label="Add channels" title="Choose visible channels" onClick={() => setShowChannels(true)}>CH+</button>
                <button className={`channel-layout-button ${expandedChannels ? "active" : ""}`} aria-label={`${expandedChannels ? "Use compact" : "Use expanded scrollable"} channel layout`} aria-pressed={expandedChannels} title={`${expandedChannels ? "Compact channels" : "Expand channels and scroll vertically"}`} onClick={() => setExpandedChannels((value) => !value)}>E</button>
                {display.labels.map((label, index) => {
                  const inspectionHighlighted = Boolean(
                    inspectionDragging
                    && inspectionRange
                    && index >= inspectionRange.startRow
                    && index <= inspectionRange.endRow,
                  );
                  const focused = !inspectionDragging && focusedChannel === index;
                  return <button
                    key={`${label}-${index}`}
                    className={`${focused ? "focused" : ""} ${inspectionHighlighted ? "inspection-highlighted" : ""} ${channelRowLayout.groupStarts.has(index) ? "group-start" : ""}`}
                    style={{ gridRow: `${channelRowLayout.rowStartUnits[index] + 1} / span 1` }}
                    aria-pressed={focused || inspectionHighlighted}
                    onClick={() => setFocusedChannel(index)}
                  ><strong>{label}</strong><span>{formatAmplitude(display.data[index]?.[Math.floor(display.data[index].length / 2)] ?? 0, display.units[index] || "a.u.")}</span></button>;
                })}
              </div>
              <div className="canvas-column">
                <div
                  className={`canvas-shell ${inspectionMode ? "inspection-mode" : ""}`}
                  style={expandedChannels ? { height: channelViewportHeight } : undefined}
                  onDragOver={onLabelDragOver}
                  onDrop={onLabelDrop}
                  onDragLeave={() => setDragGhost(null)}
                >
                  <canvas ref={canvasRef} tabIndex={0} role="img" aria-busy={loadingSignal} aria-label={inspectionMode ? "Interactive EEG waveform. Click to inspect a point or drag a box to zoom in time and inspect its channels." : "Interactive EEG waveform. Click to pin a time or drag across time to select a labeling window."} onPointerDown={onWavePointerDown} onPointerMove={onWavePointerMove} onPointerUp={onWavePointerUp} onPointerCancel={onWavePointerCancel} />
                  {!inspectionMode && selection && <div className="wave-selection" style={{
                    left: `${((Math.max(display.viewStart, selection.start) - display.viewStart) / timebase) * 100}%`,
                    width: `${Math.max(0, ((Math.min(display.viewStart + timebase, selection.end) - Math.max(display.viewStart, selection.start)) / timebase) * 100)}%`,
                  }} />}
                  {inspectionMode && inspectionDragging && inspectionRange && inspectionRange.end > inspectionRange.start && <div className="wave-inspection-range" style={{
                    left: `${((Math.max(display.viewStart, inspectionRange.start) - display.viewStart) / timebase) * 100}%`,
                    width: `${Math.max(0, ((Math.min(display.viewStart + timebase, inspectionRange.end) - Math.max(display.viewStart, inspectionRange.start)) / timebase) * 100)}%`,
                    top: `${inspectionRange.top * 100}%`,
                    height: `${Math.max(0, inspectionRange.bottom - inspectionRange.top) * 100}%`,
                  }} />}
                  {cursorLocked && cursorTime >= display.viewStart && cursorTime <= display.viewStart + timebase && <div className="wave-cursor pinned" style={{ left: `${((cursorTime - display.viewStart) / timebase) * 100}%` }}><span>{formatClock(cursorTime, true)}</span></div>}
                  {loadingSignal && <div className="signal-loading"><span /> Preparing signal window…</div>}
                  {dragGhost && <div className="drop-ghost" style={{ left: `${((dragGhost.time - display.viewStart) / timebase) * 100}%` }}><span>{formatClock(dragGhost.time, true)}</span></div>}
                  {!display.data.length && !loadingSignal && <div className="no-channels"><strong>No visible channels</strong><span>Use CH+ to choose channels.</span></div>}
                </div>
              </div>
            </div>

            {spectrogramOpen && <SpectrogramPanel data={display.data[focusedChannel]} sampleRate={display.sampleRates[focusedChannel] || primarySampleRate(meta)} start={display.startSecs[focusedChannel] ?? display.viewStart} cursor={cursorTime} label={display.labels[focusedChannel] || "Focused channel"} />}

            {bottomTracksOpen && <div
              className={`timeline ${annotationSelectionBox ? "box-selecting" : ""}`}
              ref={timelineRef}
              onPointerDown={onTimelinePointerDown}
              onPointerMove={onTimelinePointerMove}
              onPointerUp={onTimelinePointerUp}
              onPointerCancel={onTimelinePointerUp}
            >
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
                    return point ? <button key={item.id} data-annotation-id={item.id} className={`event-pin ${track.id === "context" ? "context-pin" : ""} ${selectedAnnotationIds.has(item.id) ? "selected" : ""}`} style={sharedStyle} onPointerDown={(event) => startAnnotationDrag(event, item, "move")} title={`${label.name} · ${formatClock(item.start, true)} · drag to move${track.id === "instance" ? " or move up to convert" : ""}`}><i /><span>{label.short}</span></button> : <div key={item.id} data-annotation-id={item.id} className={`annotation-block ${track.id === "context" ? "context-annotation" : ""} ${geometry === "session" ? "session-label" : ""} ${item.status} ${selectedAnnotationIds.has(item.id) ? "selected" : ""}`} style={{ ...sharedStyle, width: `${width}%` }} onPointerDown={(event) => startAnnotationDrag(event, item, "move")} title={`${label.name} · ${formatClock(item.start, true)}–${formatClock(item.end, true)} · drag to move${track.id === "windowed" ? " or move down to convert" : ""}`}>
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
              {annotationSelectionBox && <div className="annotation-selection-box" style={annotationSelectionBox} aria-hidden="true" />}
            </div>}
          </div>

          <footer className="command-strip">
            <div className="cursor-readout"><span className="crosshair-mini">⌖</span><strong>{formatClock(cursorTime, true)}</strong><span>{display.labels[focusedChannel] ?? "—"}</span><span>{formatAmplitude(cursorAmplitude, display.units[focusedChannel] || "a.u.")}</span><span>source sample {Math.round(cursorTime * sourceRateForDisplayRow(display, meta, focusedChannel)).toLocaleString()}</span></div>
            <div className="command-status" role="status" aria-live="polite" aria-atomic="true"><span className="status-dot" /><span className="command-status-text">{toast}</span>{verifyingSource && <button className="verification-cancel" onClick={cancelSourceVerification}>Cancel load</button>}</div>
            {selectedAnnotationIds.size > 0 && <div className="annotation-command-actions">
              {selectedAnnotationIds.size === 1 && selectedAnnotation
                ? <button onClick={() => setShowAnnotationEditor(true)}>Edit label</button>
                : <span>{selectedAnnotationIds.size} labels selected</span>}
              <button className="trash-button" onClick={deleteSelectedAnnotations} title="Delete selected labels" aria-label="Delete selected labels">🗑</button>
            </div>}
          </footer>
          </> : <button className="recording-empty-state" onClick={() => setShowImport(true)}>
            <span className="empty-intro">
              <span className="empty-intro-kicker">NEUROTRACE CLINICAL EEG STUDIO</span>
              <strong className="empty-intro-title">Welcome to NeuroTrace</strong>
              <span className="empty-intro-copy">Review, annotate, and quality-check clinical EEG recordings in one focused, browser-based workspace.</span>
              <span className="empty-intro-support">Your recording stays on this device. Select <b>?</b> in the top-right for guidance, or use Settings to tailor the workspace.</span>
            </span>
            <span className="empty-load-prompt">
              <span className="empty-load-mark" aria-hidden="true">＋</span>
              <strong>Load a recording to begin</strong>
              <span>Open EDF / EDF+, MATLAB v5, or a paired MAT + DAT session.</span>
              <small>Click to choose files, or drop them anywhere in this workspace.</small>
            </span>
          </button>}
          </>}
        </section>

        <aside className="right-sidebar">
          {rightPanelView === "resources" ? <ResourceUsagePanel
            meta={meta}
            hasRecording={hasRecording}
            verifyingSource={verifyingSource}
            sourceHash={sourceHash}
            recoveryStatus={recoveryStatus}
            viewStart={viewStart}
            timebase={timebase}
            visibleChannelCount={display.labels.length}
            selectedChannelCount={selectedChannels.size}
            openSessionCount={sessionTabs.length}
            activeDisplayBytes={activeDisplayBytes}
            readCacheUsage={readResourceCacheUsage}
          /> : <>
          <div className="right-panel-mode-switch" role="tablist" aria-label="Right panel tools">
            <button role="tab" aria-selected={rightPanelView === "labels"} className={rightPanelView === "labels" ? "active" : ""} onClick={() => selectRightPanelTool("labels")}><span aria-hidden="true">✎</span>Labeling tools</button>
            <button role="tab" aria-selected={rightPanelView === "inspect"} className={rightPanelView === "inspect" ? "active" : ""} onClick={() => selectRightPanelTool("inspect")}><span aria-hidden="true">⌖</span>General info</button>
          </div>
          {rightPanelView === "inspect" ? <GeneralInfoPanel
            meta={meta}
            display={display}
            annotations={annotations}
            focusedChannel={focusedChannel}
            cursorTime={cursorTime}
            cursorAmplitude={cursorAmplitude}
            inspectionRange={inspectionRange}
            montage={montage}
            viewStart={viewStart}
            timebase={timebase}
            hasRecording={hasRecording}
          /> : <>
          <div className="ontology-search-row">
            <input className="palette-search" aria-label="Search label ontology" placeholder="Search ontology…" value={paletteSearch} onChange={(event) => setPaletteSearch(event.target.value)} />
          </div>
          <section className="compact-context-palette">
            <h2>Context Labels</h2>
            <p className="palette-kind">Context palette · click = instance · selected span = window</p>
            <div className="compact-context-only">
              {rightContextLabels.map((label) => <button key={label.id} className="compact-palette-button context" disabled={!reviewReady} draggable={reviewReady} onDragStart={(event) => {
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
                return <div className="ontology-group" data-category={groupLabel} key={groupLabel}><span>{groupLabel}:</span><div>{group.map((label) => <button className="compact-palette-button" key={label.id} disabled={!reviewReady} draggable={reviewReady} onDragStart={(event) => {
                  event.dataTransfer.setData("application/x-neurotrace-label", label.id);
                  event.dataTransfer.effectAllowed = "copy";
                  setDragGhost({ labelId: label.id, time: cursorTime });
                }} onDragEnd={() => setDragGhost(null)} onClick={() => placePaletteLabel(label)} style={{ "--label-color": label.color } as React.CSSProperties} title={`${label.name}${label.shortcut ? ` · shortcut ${label.shortcut}` : ""}`}>
                  <i />{PALETTE_BUTTON_NAMES[label.id] ?? label.short}
                </button>)}</div></div>;
              })}
            </div>
          </section>
          </>}
          </>}
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
            <p>{pendingLegacyMeta ? `Companion MAT metadata found ${pendingLegacyMeta.channelLabels.length || pendingLegacyMeta.channelCount || 0} channels and ${pendingLegacyMeta.events.filter((event) => isLegacySeizureCandidate(event.label)).length} seizure-keyword events (${pendingLegacyMeta.events.length} total). ${datMapping.channelCount < 100 ? "As in the MATLAB reviewer, source-event review will be disabled below 100 channels. " : ""}Every timing and scale value remains unverified until you confirm it here.` : "Enter and confirm the raw binary layout. Zero means the timing/channel mapping is still unknown; the recording cannot open until those fields are verified."}</p>
            <div className="mapper-fields"><label><span>Sample rate</span><input type="number" value={datMapping.sampleRate} onChange={(event) => setDatMapping((current) => ({ ...current, sampleRate: Number(event.target.value) }))} /><small>Hz</small></label><label><span>Channels</span><input type="number" value={datMapping.channelCount} onChange={(event) => setDatMapping((current) => ({ ...current, channelCount: Number(event.target.value) }))} /></label><label><span>Scale (optional)</span><input type="number" step="0.001" min="0.000001" placeholder="Raw counts" value={datMapping.physicalScale} onChange={(event) => setDatMapping((current) => ({ ...current, physicalScale: event.target.value === "" ? "" : Number(event.target.value) }))} /><small>µV/count</small></label></div>
            <p className="dat-scale-note">Leave scale blank to match MATLAB&apos;s raw-count display with 15,000 counts between channel baselines. Enter a value only when the DAT calibration is known.</p>
            {pendingLegacyMeta && <div className="legacy-export-hints">
              <div><strong>MATLAB export identity</strong><small>Browsers hide absolute local paths. Confirm or paste these values if round-trip resume keys must match MATLAB exactly.</small></div>
              <label><span>Patient ID</span><input value={legacyExportHints.patientId} placeholder="patient_id" onChange={(event) => setLegacyExportHints((current) => ({ ...current, patientId: event.target.value }))} /></label>
              <label><span>MAT path</span><input value={legacyExportHints.matPath} placeholder="C:\\study\\session.mat" onChange={(event) => setLegacyExportHints((current) => ({ ...current, matPath: event.target.value }))} /></label>
              <label><span>Data directory</span><input value={legacyExportHints.dataDirectory} placeholder="C:\\study" onChange={(event) => setLegacyExportHints((current) => ({ ...current, dataDirectory: event.target.value }))} /></label>
              <label><span>DAT file</span><input value={legacyExportHints.datFile} placeholder="session" onChange={(event) => setLegacyExportHints((current) => ({ ...current, datFile: event.target.value }))} /></label>
            </div>}
            {pendingLegacyCandidateEvents.length > 0 && <fieldset className="legacy-event-picker" disabled={datMapping.channelCount < 100}>
              <div className="legacy-event-picker-head"><span>Source events to review</span><div><button type="button" onClick={() => setSelectedLegacyEventIndices(new Set(pendingLegacyCandidateEvents.map(({ sourceIndex }) => sourceIndex)))}>All</button><button type="button" onClick={() => setSelectedLegacyEventIndices(new Set())}>None</button></div></div>
              <div className="legacy-event-list">{pendingLegacyCandidateEvents.map(({ event: sourceEvent, sourceIndex }) => <label key={`${sourceIndex}-${sourceEvent.timeSec}`}>
                <input type="checkbox" checked={selectedLegacyEventIndices.has(sourceIndex)} onChange={(event) => setSelectedLegacyEventIndices((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(sourceIndex);
                  else next.delete(sourceIndex);
                  return next;
                })} />
                <span>{formatClock(sourceEvent.timeSec, true)}</span><strong title={sourceEvent.label}>{sourceEvent.label}</strong>
              </label>)}</div>
              <small>{pendingLegacyCandidateEvents.filter(({ sourceIndex }) => selectedLegacyEventIndices.has(sourceIndex)).length} of {pendingLegacyCandidateEvents.length} selected</small>
            </fieldset>}
            <button className="button primary wide" disabled={!Number.isFinite(datMapping.sampleRate) || !(datMapping.sampleRate > 0) || !Number.isInteger(datMapping.channelCount) || !(datMapping.channelCount > 0) || !datPhysicalScaleValid} onClick={confirmDatImport}>Confirm mapping &amp; open DAT</button>
          </div>}
          <div className="format-cards"><div><strong>EDF / EDF+</strong><span>Calibrated signals, channel metadata, full recording timeline</span></div><div><strong>MAT v5</strong><span>Automatic largest-matrix detection with sampling-rate discovery</span></div><div><strong>MAT + DAT</strong><span>Manual binary confirmation for legacy Buzcode sessions</span></div></div>
          <div className="research-notice"><span>✦</span><p><strong>Research annotation workspace.</strong> Not for diagnosis or autonomous clinical decision-making. Hospital deployment still requires institutional privacy, security, and validation review.</p></div>
        </div>
      </div>}

      {confirmCommit.length > 0 && <div className="modal-backdrop"><div className="modal confirm-modal" role="dialog" aria-modal="true" aria-label="Commit advisory" tabIndex={-1}><span className="warning-mark">!</span><h2>Review before committing</h2><p>The label is valid, but the QC engine found an advisory:</p><ul>{confirmCommit.map((warning) => <li key={warning}>{warning}</li>)}</ul><div className="modal-actions"><button className="button secondary" onClick={() => { setConfirmCommit([]); setCommitAdvanceAfter(false); }}>Return to label</button><button className="button primary" onClick={() => {
        if (commitSelected(true, commitAdvanceAfter)) setShowAnnotationEditor(false);
      }}>Commit with advisory</button></div></div></div>}

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
              ["Source-event review", "Seizure-keyword file events open around relative time zero. Enter reviewer initials, optionally rate confidence 1–3, mark onset then offset, and Accept or Skip to advance."],
              ["Signal tools", "Spectrum opens the focused-channel spectral view. Montage, filters, window, and gain only change the display; raw samples stay immutable."],
              ["CH+ channel manager", "Opens detected source channels. Toggle visibility and mark channel quality without losing source-channel provenance."],
              ["Waveform labeling", "Click once to pin a time, then click any ePhys label to create an instance there. Drag across time, then click a label to apply it to that exact window."],
              ["Annotation tracks", "Context may stack, windowed labels occupy spans, and instance labels mark single moments. Drag annotations to move them or between the two ePhys tracks to convert geometry."],
              ["Context Labels", "Clinical Observation, Medication, and Other are the three timed context tools. Whole-session labels are added only with + in the left Session Labels panel."],
              ["ePhys Labels", "The same ontology can describe a single instant or a selected window. Sleep stages, rhythmic/periodic patterns, seizure state, quality, and spikes are grouped here."],
              ["Inspector and deletion", "Select any annotation to edit timing, notes, reviewer, and confidence, commit a revision, or use the trash can. Delete/Backspace also removes the selection."],
              ["QC and session map", "QC checks source assumptions and label integrity. Session map gives a hoverable, clickable whole-recording view."],
              ["Navigation", "Trackpad or mouse-wheel movement pans through time. The Window number and unit button stage a new view; the check button applies it. Pinch or Ctrl/⌘ +/- zooms immediately. Escape clears the current interaction."],
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
            <div><span>Patient</span><strong>{effectivePatientLabel}</strong></div>
            <div><span>Session</span><strong>{recordingLabel(meta)}</strong></div>
            <div><span>Recording start</span><strong>{formatSessionStart(meta.startedAt)}</strong></div>
            <div><span>Source integrity</span><strong className="hash-text" title={verifyingSource ? "Full source SHA-256 verification is in progress" : sourceHash}>{sourceHashDisplay}</strong></div>
            <div><span>Source channels</span><strong>{meta.channelLabels.length}</strong></div>
            <div><span>Quality excluded</span><strong>{badChannels.size}</strong></div>
            <label><span>Reviewer initials</span><input value={reviewer} maxLength={12} onChange={(event) => setReviewer(event.target.value.toUpperCase())} /></label>
            {activeMatlabExportIdentity && <>
              <div className="matlab-identity-note"><span>MATLAB export identity</span><strong>Editable without changing the recording recovery key</strong></div>
              <label className="matlab-identity-field"><span>MATLAB patient ID</span><input value={activeMatlabExportIdentity.patientId} onChange={(event) => updateMatlabExportIdentity({ patientId: event.target.value })} /></label>
              <label className="matlab-identity-field"><span>MAT path</span><input value={activeMatlabExportIdentity.matPath} onChange={(event) => updateMatlabExportIdentity({ matPath: event.target.value })} /></label>
              <label className="matlab-identity-field"><span>Data directory</span><input value={activeMatlabExportIdentity.dataDirectory} onChange={(event) => updateMatlabExportIdentity({ dataDirectory: event.target.value })} /></label>
              <label className="matlab-identity-field"><span>DAT file</span><input value={activeMatlabExportIdentity.datFile} onChange={(event) => updateMatlabExportIdentity({ datFile: event.target.value })} /></label>
            </>}
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
            <div><span>Confidence</span><strong>{queueDetailEntry.confidence}%</strong></div>
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
              setSelectedAnnotationIds(new Set([queueDetailAnnotation.id]));
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
            {selectedCandidateDecisionLocked && <div className="candidate-editor-lock"><div><strong>Accepted source-event decision locked</strong><span>Reopen it through the review bar before changing marks or review metadata.</span></div><button className="button secondary" onClick={() => {
              const candidateIndex = candidates.findIndex((candidate) => candidate.id === selectedAnnotation.candidateId);
              if (candidateIndex >= 0) selectCandidate(candidateIndex);
              setShowAnnotationEditor(false);
              setToast("Use Revise marks to confirm reopening this accepted source event");
            }}>Go to source event</button></div>}
            <div className="time-fields"><label><span>Start (s)</span><input type="number" step="0.001" value={selectedAnnotation.start} disabled={selectedGeometry === "session" || selectedCandidateDecisionLocked} onChange={(event) => updateAnnotation(selectedAnnotation.id, { start: clamp(Number(event.target.value), 0, selectedGeometry === "interval" ? selectedAnnotation.end : meta.durationSec) })} /></label><label><span>End (s)</span><input type="number" step="0.001" value={selectedAnnotation.end} disabled={selectedGeometry !== "interval" || selectedCandidateDecisionLocked} onChange={(event) => updateAnnotation(selectedAnnotation.id, { end: clamp(Number(event.target.value), selectedAnnotation.start, meta.durationSec) })} /></label></div>
            <div className="duration-line"><span>{formatClock(selectedAnnotation.start, true)}</span><i /><span>{(selectedAnnotation.end - selectedAnnotation.start).toFixed(3)} s</span></div>
            <label className="form-field"><span>Reviewer</span><input disabled={selectedCandidateDecisionLocked} value={selectedAnnotation.reviewer} onChange={(event) => updateAnnotation(selectedAnnotation.id, { reviewer: event.target.value })} /></label>
            <label className="confidence-field"><span>Confidence <strong>{selectedAnnotation.confidence}%</strong></span><input disabled={selectedCandidateDecisionLocked} type="range" min="0" max="100" value={selectedAnnotation.confidence} onChange={(event) => updateAnnotation(selectedAnnotation.id, { confidence: Number(event.target.value) }, false)} /></label>
            <label className="form-field"><span>Clinical / review note</span><textarea disabled={selectedCandidateDecisionLocked} rows={4} placeholder="Evidence, uncertainty, or rationale…" value={selectedAnnotation.notes} onChange={(event) => updateAnnotation(selectedAnnotation.id, { notes: event.target.value }, false)} /></label>
            <div className="inspector-actions"><button className="button primary" onClick={() => {
              if (commitSelected()) setShowAnnotationEditor(false);
            }} disabled={selectedCandidateDecisionLocked}>{selectedAnnotation.status === "committed" ? "Save revision" : "Commit label"}</button><button className="icon-danger" onClick={() => {
              if (deleteAnnotation(selectedAnnotation.id)) setShowAnnotationEditor(false);
            }} disabled={selectedCandidateDecisionLocked} title="Delete annotation" aria-label="Delete annotation">🗑</button></div>
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
          setSelectedAnnotationIds(new Set([item.id]));
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
      if (sampleRate < 2) {
        ctx.fillStyle = "rgba(235,245,243,.55)";
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillText("Spectrum unavailable below 2 Hz", 8, 12);
        return;
      }
      const nominalWindowSize = Math.min(256, 2 ** Math.floor(Math.log2(Math.max(32, sampleRate))));
      const windowSize = Math.max(1, Math.min(data.length, nominalWindowSize));
      const targetHop = Math.max(1, Math.floor(windowSize / 4));
      const possibleFrames = Math.max(1, Math.floor((data.length - windowSize) / targetHop) + 1);
      const frames = Math.min(90, possibleFrames);
      const hop = frames > 1
        ? Math.max(1, Math.floor((data.length - windowSize) / (frames - 1)))
        : 1;
      const maxHz = Math.min(150, sampleRate / 2);
      const bins = 56;
      const powers: number[][] = Array.from({ length: bins }, () => Array(frames).fill(Number.NaN));
      for (let frame = 0; frame < frames; frame += 1) {
        const offset = Math.min(Math.max(0, data.length - windowSize), frame * hop);
        let finiteSamples = 0;
        let mean = 0;
        for (let sample = 0; sample < windowSize; sample += 1) {
          const value = data[offset + sample];
          if (!Number.isFinite(value)) continue;
          mean += value;
          finiteSamples += 1;
        }
        if (finiteSamples / windowSize < .75) continue;
        mean /= finiteSamples;
        const coverageGain = windowSize / finiteSamples;
        for (let bin = 0; bin < bins; bin += 1) {
          const frequency = Math.exp(Math.log(1) + (bin / (bins - 1)) * Math.log(Math.max(1.01, maxHz)));
          let re = 0; let im = 0;
          for (let sample = 0; sample < windowSize; sample += 1) {
            const sourceValue = data[offset + sample];
            if (!Number.isFinite(sourceValue)) continue;
            const value = sourceValue - mean;
            const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * sample) / Math.max(1, windowSize - 1));
            const angle = (2 * Math.PI * frequency * sample) / sampleRate;
            re += value * hann * Math.cos(angle);
            im -= value * hann * Math.sin(angle);
          }
          re *= coverageGain;
          im *= coverageGain;
          powers[bin][frame] = Math.log10(re * re + im * im + 1e-9);
        }
      }
      const flat = powers.flat().filter(Number.isFinite).sort((a, b) => a - b);
      if (!flat.length) {
        ctx.fillStyle = "rgba(235,245,243,.55)";
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillText("No sufficiently complete signal frames", 8, 12);
        return;
      }
      const low = flat[Math.floor(flat.length * 0.08)] ?? 0;
      const high = flat[Math.floor(flat.length * 0.97)] ?? low + 1;
      for (let bin = 0; bin < bins; bin += 1) for (let frame = 0; frame < frames; frame += 1) {
        const x = (frame / frames) * width;
        const y = height - ((bin + 1) / bins) * height;
        const power = powers[bin][frame];
        if (!Number.isFinite(power)) {
          ctx.fillStyle = "rgba(243,187,95,.06)";
          ctx.fillRect(x, y, width / frames + 1, height / bins + 1);
          continue;
        }
        const value = clamp((power - low) / Math.max(1e-6, high - low), 0, 1);
        const hue = 220 - value * 170;
        ctx.fillStyle = `hsl(${hue} 76% ${18 + value * 48}%)`;
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
  return <div className="spectrogram-panel"><div className="spectrogram-label"><strong>{label}</strong><span>{sampleRate >= 2 ? `1–${Math.min(150, Math.floor(sampleRate / 2))} Hz · log power · display only` : "Sampling rate below 2 Hz"}</span></div><div className="spectrogram-canvas-shell"><canvas ref={ref} /><i className="spectrogram-cursor" style={{ left: `${cursorLeft}%` }} /></div></div>;
}

type FileStructureNode = { title: string; detail: string };

function fileStructureNodes(meta: RecordingMeta): FileStructureNode[] {
  if (meta.format === "edf" || meta.format === "edf+") {
    return [
      { title: "Fixed header", detail: "Patient, recording, timing, version, and signal count fields" },
      { title: "Per-signal headers", detail: `${meta.channelCount} display channel definitions with labels, units, ranges, and samples per record` },
      { title: "Data records", detail: `${String(meta.details?.dataRecords ?? "Unknown")} record blocks · ${String(meta.details?.dataRecordDurationSec ?? "Unknown")} s each` },
      { title: "Signal samples", detail: "Channel sample blocks are calibrated and streamed from the local file on demand" },
      ...(meta.format === "edf+" ? [{ title: "EDF+ annotations", detail: `${String(meta.details?.annotationChannels ?? 0)} annotation channel(s) parsed separately from waveform signals` }] : []),
    ];
  }
  if (meta.format === "mat-v5") {
    return [
      { title: "MATLAB v5 container", detail: "Named typed elements, matrices, strings, and optional compressed blocks" },
      { title: "Selected signal matrix", detail: String(meta.details?.matrixName ?? "Largest numeric matrix") },
      { title: "Matrix dimensions", detail: String(meta.details?.matrixDimensions ?? "Not reported") },
      { title: "Viewer mapping", detail: `Matrix axis ${String(meta.details?.sampleAxis ?? "?")} is time · ${meta.channelCount} channel rows` },
      { title: "Decoded samples", detail: "The selected matrix is decoded locally into channel-major numeric arrays" },
    ];
  }
  if (meta.format === "raw-int16-le") {
    return [
      { title: "Headerless DAT stream", detail: "No embedded labels, timing, or calibration metadata" },
      { title: "Sample frame", detail: `${meta.channelCount} interleaved channel values per time point` },
      { title: "Value encoding", detail: "Signed 16-bit integers · little-endian byte order" },
      { title: "Frame sequence", detail: `${String(meta.details?.totalSampleFrames ?? "Unknown")} sample frames mapped using confirmed companion metadata` },
      { title: "Physical values", detail: meta.channelUnits.some((unit) => unit === "µV") ? "Raw counts are scaled into microvolts" : "Raw digital counts are retained without an assumed physical scale" },
    ];
  }
  return [
    { title: "Generated source", detail: "Deterministic in-browser signal source" },
    { title: "Channel arrays", detail: `${meta.channelCount} generated channel streams` },
    { title: "Samples", detail: "Samples are generated locally for the requested time window" },
  ];
}

function formatFileDetailLabel(key: string) {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase());
}

function FileStructurePanel({
  meta,
  selectedChannels,
  badChannels,
  recordingType,
  verifyingSource,
  sourceHash,
}: {
  meta: RecordingMeta;
  selectedChannels: Set<number>;
  badChannels: Set<number>;
  recordingType: string;
  verifyingSource: boolean;
  sourceHash: string;
}) {
  const [channelQuery, setChannelQuery] = useState("");
  const normalizedQuery = channelQuery.trim().toLowerCase();
  const recommendedChannels = new Set(meta.recommendedDisplayChannels ?? []);
  const channelRows = meta.channelLabels.map((label, index) => ({
    index,
    label,
    unit: meta.channelUnits[index] || "a.u.",
    sampleRate: meta.sampleRates[index] || meta.sampleRate,
  })).filter((channel) => !normalizedQuery
    || channel.label.toLowerCase().includes(normalizedQuery)
    || channel.unit.toLowerCase().includes(normalizedQuery)
    || String(channel.sampleRate).includes(normalizedQuery));
  const sampleRates = [...new Set(meta.sampleRates.filter((rate) => Number.isFinite(rate) && rate > 0))];
  const units = [...new Set(meta.channelUnits.filter(Boolean))];
  const approximateValues = meta.sampleRates.reduce((sum, rate) => sum + Math.floor(meta.durationSec * rate), 0);
  const profile = sourceReadProfile(meta.format, true);
  const structure = fileStructureNodes(meta);
  const details = Object.entries(meta.details ?? {});
  const notices = [
    ...meta.warnings.map((text) => ({ kind: "warning", text })),
    ...(meta.assumptions ?? []).map((text) => ({ kind: "assumption", text })),
  ];
  const integrity = verifyingSource ? "Verifying source" : sourceHash ? "Source verified" : "Metadata parsed";

  return <section className="file-structure-panel" aria-label="File structure analysis">
    <header className="file-structure-heading">
      <div><span>FILE STRUCTURE ANALYSIS</span><h1 title={meta.name}>{meta.name}</h1><p>Parsed information and the detected organization of this recording. Use the small structure button in the tab to return to the waveform.</p></div>
      <span className={`file-integrity-status ${sourceHash ? "verified" : ""}`}><i />{integrity}</span>
    </header>

    <div className="file-summary-grid">
      <article><span>Format</span><strong>{meta.format.replace("raw-int16-le", "DAT").toUpperCase()}</strong><small>{recordingType}</small></article>
      <article><span>File size</span><strong>{formatByteCount(meta.byteLength)}</strong><small>{profile.origin}</small></article>
      <article><span>Duration</span><strong>{formatClock(meta.durationSec)}</strong><small>{meta.durationSec.toLocaleString()} seconds</small></article>
      <article><span>Channels</span><strong>{meta.channelCount.toLocaleString()}</strong><small>{selectedChannels.size} currently shown</small></article>
      <article><span>Sample rates</span><strong>{sampleRates.length === 1 ? `${sampleRates[0].toLocaleString()} Hz` : `${sampleRates.length} rates`}</strong><small>{sampleRates.length > 1 ? sampleRates.map((rate) => `${rate.toLocaleString()} Hz`).join(" · ") : "Uniform timing"}</small></article>
      <article><span>Signal values</span><strong>{approximateValues.toLocaleString()}</strong><small>Approximate decoded values</small></article>
    </div>

    <div className="file-analysis-grid">
      <section className="file-analysis-card structure-map-card">
        <header><div><span>DETECTED LAYOUT</span><h2>How the file is organized</h2></div><small>{profile.access}</small></header>
        <div className="file-structure-map">{structure.map((node, index) => <article key={node.title}><span>{String(index + 1).padStart(2, "0")}</span><i /><div><strong>{node.title}</strong><p>{node.detail}</p></div></article>)}</div>
        <p className="file-read-note">{profile.detail} Recording data stays on this device.</p>
      </section>

      <section className="file-analysis-card metadata-card">
        <header><div><span>EMBEDDED METADATA</span><h2>File information</h2></div><small>{details.length + 4} parsed fields</small></header>
        <dl>
          <div><dt>Patient identifier</dt><dd>{meta.patientId || "Not provided"}</dd></div>
          <div><dt>Recording identifier</dt><dd>{meta.recordingId || "Not provided"}</dd></div>
          <div><dt>Start time</dt><dd>{formatSessionStart(meta.startedAt)}</dd></div>
          <div><dt>Units present</dt><dd>{units.length ? units.join(" · ") : "Not provided"}</dd></div>
          {details.map(([key, value]) => <div key={key}><dt>{formatFileDetailLabel(key)}</dt><dd>{typeof value === "boolean" ? value ? "Yes" : "No" : String(value)}</dd></div>)}
        </dl>
      </section>
    </div>

    <section className="file-analysis-card channel-analysis-card">
      <header><div><span>CHANNEL DIRECTORY</span><h2>Channel information</h2></div><label><span>Filter</span><input value={channelQuery} onChange={(event) => setChannelQuery(event.target.value)} placeholder="Label, rate, or unit…" aria-label="Filter file channels" /></label></header>
      <div className="channel-table-summary"><span>{channelRows.length} of {meta.channelCount} channels</span><span>{badChannels.size} quality-excluded · {recommendedChannels.size} initially recommended</span></div>
      <div className="file-channel-table" role="region" aria-label="Parsed channel information" tabIndex={0}>
        <table>
          <thead><tr><th>#</th><th>Source label</th><th>Sample rate</th><th>Approx. samples</th><th>Unit</th><th>Viewer status</th></tr></thead>
          <tbody>{channelRows.map((channel) => <tr key={`${channel.index}-${channel.label}`} className={badChannels.has(channel.index) ? "bad" : ""}>
            <td>{channel.index + 1}</td><td><strong>{channel.label}</strong></td><td>{channel.sampleRate.toLocaleString()} Hz</td><td>{Math.floor(meta.durationSec * channel.sampleRate).toLocaleString()}</td><td>{channel.unit}</td><td><span className={badChannels.has(channel.index) ? "bad" : selectedChannels.has(channel.index) ? "shown" : recommendedChannels.has(channel.index) ? "recommended" : "available"}>{badChannels.has(channel.index) ? "Excluded" : selectedChannels.has(channel.index) ? "Shown" : recommendedChannels.has(channel.index) ? "Recommended" : "Available"}</span></td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>

    <section className="file-analysis-card source-notices-card">
      <header><div><span>PARSER NOTES</span><h2>Warnings and assumptions</h2></div><small>{notices.length} item{notices.length === 1 ? "" : "s"}</small></header>
      {notices.length ? <div>{notices.map((notice, index) => <article className={notice.kind} key={`${notice.kind}-${index}`}><i>{notice.kind === "warning" ? "!" : "i"}</i><p>{notice.text}</p></article>)}</div> : <div className="file-analysis-clean"><span>✓</span><p>No parser warnings or structural assumptions were reported.</p></div>}
    </section>
  </section>;
}

function GeneralInfoPanel({
  meta,
  display,
  annotations,
  focusedChannel,
  cursorTime,
  cursorAmplitude,
  inspectionRange,
  montage,
  viewStart,
  timebase,
  hasRecording,
}: {
  meta: RecordingMeta;
  display: DisplayWindow;
  annotations: Annotation[];
  focusedChannel: number;
  cursorTime: number;
  cursorAmplitude: number;
  inspectionRange: InspectionBox | null;
  montage: MontageMode;
  viewStart: number;
  timebase: number;
  hasRecording: boolean;
}) {
  const rangeStart = inspectionRange ? Math.min(inspectionRange.start, inspectionRange.end) : cursorTime;
  const rangeEnd = inspectionRange ? Math.max(inspectionRange.start, inspectionRange.end) : cursorTime;
  const duration = rangeEnd - rangeStart;
  const isArea = inspectionRange !== null && duration > 0.0005;
  const displayLabel = display.labels[focusedChannel] ?? "—";
  const selectedChannelLabels = inspectionRange?.channelLabels.length
    ? inspectionRange.channelLabels
    : [displayLabel];
  const sourceIndices = display.sourceIndices[focusedChannel] ?? [];
  const sourceLabels = sourceIndices.map((index) => meta.channelLabels[index]).filter(Boolean);
  const primarySourceIndex = display.primarySourceIndices[focusedChannel];
  const primarySourceLabel = meta.channelLabels[primarySourceIndex] ?? sourceLabels[0] ?? "—";
  const sampleRate = sourceRateForDisplayRow(display, meta, focusedChannel);
  const pointTolerance = Math.max(sampleRate > 0 ? 1 / sampleRate : 0, timebase * 0.005);
  const relatedAnnotations = inspectionRange ? annotations.filter((annotation) => {
    const geometry = annotationGeometry(annotation);
    if (geometry === "session") return true;
    if (geometry === "point") {
      return annotation.start >= rangeStart - pointTolerance && annotation.start <= rangeEnd + pointTolerance;
    }
    return annotation.start <= rangeEnd && annotation.end >= rangeStart;
  }).sort((left, right) => Math.abs(left.start - rangeStart) - Math.abs(right.start - rangeStart)).slice(0, 6) : [];
  const montageLabel = montage === "referential" ? "Recorded reference" : montage === "average" ? "Average reference" : "Anatomical bipolar";

  return <section className="general-info-panel" aria-label="General waveform information">
    <header className="general-info-heading">
      <span>WAVEFORM INSPECTOR</span>
      <h2>General info</h2>
      <p>Click a waveform point to inspect it. Drag a box to zoom its time range and inspect every channel inside it.</p>
    </header>

    {!hasRecording ? <div className="general-info-empty"><span>⌁</span><strong>No recording loaded</strong><p>Load a recording, then select a point or area in the waveform.</p></div> : !inspectionRange ? <div className="general-info-empty ready"><span>⌖</span><strong>Ready to inspect</strong><p>Choose any waveform row. Your selected channel, timing, amplitude, source, and nearby labels will appear here.</p></div> : <>
      <section className="general-info-focus-card">
        <span>{isArea ? "SELECTED AREA" : "CLICKED POINT"}</span>
        <strong>{isArea ? `${duration.toFixed(duration < 1 ? 3 : 2)} s` : formatClock(rangeStart, true)}</strong>
        <small>{isArea ? `${formatClock(rangeStart, true)}–${formatClock(rangeEnd, true)} · ${selectedChannelLabels.length} channel${selectedChannelLabels.length === 1 ? "" : "s"}` : `${displayLabel} · ${formatAmplitude(cursorAmplitude, display.units[focusedChannel] || "a.u.")}`}</small>
      </section>

      <section className="general-info-section">
        <header><h3>Selection</h3><span>{isArea ? "ZOOMED RANGE" : "POINT"}</span></header>
        <dl>
          <div><dt>Start</dt><dd>{formatClock(rangeStart, true)}</dd></div>
          <div><dt>End</dt><dd>{isArea ? formatClock(rangeEnd, true) : "Same point"}</dd></div>
          <div><dt>Duration</dt><dd>{isArea ? `${duration.toFixed(duration < 1 ? 3 : 2)} s` : "Instant"}</dd></div>
          <div><dt>Channel span</dt><dd>{selectedChannelLabels.length === 1 ? selectedChannelLabels[0] : `${selectedChannelLabels[0]}–${selectedChannelLabels[selectedChannelLabels.length - 1]} (${selectedChannelLabels.length})`}</dd></div>
          <div><dt>Pointer amplitude</dt><dd>{formatAmplitude(cursorAmplitude, display.units[focusedChannel] || "a.u.")}</dd></div>
          <div><dt>Source sample</dt><dd>{Math.round(cursorTime * sampleRate).toLocaleString()}</dd></div>
        </dl>
      </section>

      <section className="general-info-section">
        <header><h3>Signal source</h3><span>{meta.format.toUpperCase()}</span></header>
        <dl>
          <div><dt>Displayed channel</dt><dd>{displayLabel}</dd></div>
          <div><dt>Primary source</dt><dd>{primarySourceLabel}</dd></div>
          <div><dt>Source channels</dt><dd>{sourceLabels.length ? sourceLabels.join(" · ") : "—"}</dd></div>
          <div><dt>Sample rate</dt><dd>{sampleRate > 0 ? `${sampleRate.toLocaleString()} Hz` : "—"}</dd></div>
          <div><dt>Montage</dt><dd>{montageLabel}</dd></div>
          <div><dt>Visible window</dt><dd>{formatClock(viewStart, true)}–{formatClock(Math.min(meta.durationSec, viewStart + timebase), true)}</dd></div>
        </dl>
      </section>

      <section className="general-info-section nearby-labels">
        <header><h3>Labels in area</h3><span>{relatedAnnotations.length}</span></header>
        {relatedAnnotations.length ? <div>{relatedAnnotations.map((annotation) => {
          const label = LABEL_BY_ID.get(annotation.labelId);
          const point = annotationGeometry(annotation) === "point";
          return <article key={annotation.id} style={{ "--label-color": label?.color ?? "#6f8990" } as React.CSSProperties}><i /><span><strong>{label?.name ?? annotation.labelId}</strong><small>{point ? formatClock(annotation.start, true) : `${formatClock(annotation.start, true)}–${formatClock(annotation.end, true)}`}</small></span></article>;
        })}</div> : <p>No labels overlap this {isArea ? "area" : "point"}.</p>}
      </section>
    </>}
  </section>;
}

function ResourceUsagePanel({
  meta,
  hasRecording,
  verifyingSource,
  sourceHash,
  recoveryStatus,
  viewStart,
  timebase,
  visibleChannelCount,
  selectedChannelCount,
  openSessionCount,
  activeDisplayBytes,
  readCacheUsage,
}: {
  meta: RecordingMeta;
  hasRecording: boolean;
  verifyingSource: boolean;
  sourceHash: string;
  recoveryStatus: "saved" | "error";
  viewStart: number;
  timebase: number;
  visibleChannelCount: number;
  selectedChannelCount: number;
  openSessionCount: number;
  activeDisplayBytes: number;
  readCacheUsage: () => ResourceCacheUsage;
}) {
  const [browserUsage, setBrowserUsage] = useState<BrowserResourceUsage>({
    heapUsedBytes: null,
    heapAllocatedBytes: null,
    heapLimitBytes: null,
    storageUsedBytes: null,
    storageQuotaBytes: null,
  });
  const [cacheUsage, setCacheUsage] = useState<ResourceCacheUsage>({
    rawBytes: 0,
    rawEntries: 0,
    processedBytes: 0,
    processedEntries: 0,
    envelopeBytes: 0,
    envelopeEntries: 0,
  });

  useEffect(() => {
    let active = true;
    const sampleBrowserUsage = async () => {
      setCacheUsage(readCacheUsage());
      const memory = (performance as PerformanceWithMemory).memory;
      let storageEstimate: StorageEstimate | undefined;
      try {
        storageEstimate = await navigator.storage?.estimate?.();
      } catch {
        // Storage estimates are optional browser diagnostics.
      }
      if (!active) return;
      setBrowserUsage({
        heapUsedBytes: memory?.usedJSHeapSize ?? null,
        heapAllocatedBytes: memory?.totalJSHeapSize ?? null,
        heapLimitBytes: memory?.jsHeapSizeLimit ?? null,
        storageUsedBytes: storageEstimate?.usage ?? null,
        storageQuotaBytes: storageEstimate?.quota ?? null,
      });
    };
    void sampleBrowserUsage();
    const interval = window.setInterval(() => void sampleBrowserUsage(), 1500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [readCacheUsage]);

  const profile = sourceReadProfile(meta.format, hasRecording);
  const signalCacheBytes = cacheUsage.rawBytes + cacheUsage.processedBytes + cacheUsage.envelopeBytes;
  const cacheEntries = cacheUsage.rawEntries + cacheUsage.processedEntries + cacheUsage.envelopeEntries;
  const decodedSourceBytes = estimatedDecodedSourceBytes(meta);
  const integrityStatus = !hasRecording
    ? "Idle"
    : verifyingSource
      ? "Verifying source"
      : sourceHash
        ? "Source verified"
        : "Preview available";

  return <section className="resource-panel" aria-label="Resource usage">
    <header className="resource-panel-heading">
      <div><span>LIVE DIAGNOSTICS</span><h2>Resource usage</h2><p>Browser memory and active signal reads</p></div>
      <strong><i />LIVE</strong>
    </header>

    <section className="resource-heap-card">
      <span>Browser JS heap</span>
      <strong>{formatByteCount(browserUsage.heapUsedBytes)}</strong>
      <small>{browserUsage.heapLimitBytes === null ? "Total heap is not exposed by this browser" : `of ${formatByteCount(browserUsage.heapLimitBytes)} limit`}</small>
      <div className="resource-meter"><i style={{ width: `${usagePercent(browserUsage.heapUsedBytes, browserUsage.heapLimitBytes)}%` }} /></div>
    </section>

    <div className="resource-summary-grid">
      <div><span>Signal cache</span><strong>{formatByteCount(signalCacheBytes)}</strong><small>{cacheEntries} cached window{cacheEntries === 1 ? "" : "s"}</small></div>
      <div><span>Active view</span><strong>{formatByteCount(activeDisplayBytes)}</strong><small>{visibleChannelCount} rendered channel{visibleChannelCount === 1 ? "" : "s"}</small></div>
      <div><span>Allocated heap</span><strong>{formatByteCount(browserUsage.heapAllocatedBytes)}</strong><small>Browser-managed</small></div>
      <div><span>Site storage</span><strong>{formatByteCount(browserUsage.storageUsedBytes)}</strong><small>{browserUsage.storageQuotaBytes === null ? "Quota unavailable" : `${formatByteCount(browserUsage.storageQuotaBytes)} quota`}</small></div>
    </div>

    <section className="resource-detail-section">
      <header><h3>Signal memory</h3><span>{usagePercent(signalCacheBytes, TOTAL_SIGNAL_CACHE_BUDGET_BYTES).toFixed(0)}% of cache ceiling</span></header>
      <div className="resource-meter compact"><i style={{ width: `${usagePercent(signalCacheBytes, TOTAL_SIGNAL_CACHE_BUDGET_BYTES)}%` }} /></div>
      <dl>
        <div><dt>Raw windows <small>{cacheUsage.rawEntries}</small></dt><dd>{formatByteCount(cacheUsage.rawBytes)}</dd></div>
        <div><dt>Processed windows <small>{cacheUsage.processedEntries}</small></dt><dd>{formatByteCount(cacheUsage.processedBytes)}</dd></div>
        <div><dt>Overview envelopes <small>{cacheUsage.envelopeEntries}</small></dt><dd>{formatByteCount(cacheUsage.envelopeBytes)}</dd></div>
        {decodedSourceBytes > 0 && <div><dt>Decoded MAT estimate</dt><dd>{formatByteCount(decodedSourceBytes)}</dd></div>}
      </dl>
    </section>

    <section className="resource-detail-section source-read-section">
      <header><h3>Reading from</h3><span>{hasRecording ? meta.format.toUpperCase() : "IDLE"}</span></header>
      <div className="resource-source-file"><i>{hasRecording ? meta.format.replace("raw-int16-le", "DAT").toUpperCase() : "—"}</i><div><strong title={hasRecording ? meta.name : undefined}>{hasRecording ? meta.name : "No source selected"}</strong><span>{hasRecording ? formatByteCount(meta.byteLength) : "Choose a local recording"}</span></div></div>
      <dl>
        <div><dt>Origin</dt><dd>{profile.origin}</dd></div>
        <div><dt>Access</dt><dd>{profile.access}</dd></div>
        <div><dt>Visible window</dt><dd>{hasRecording ? `${formatClock(viewStart, true)}–${formatClock(Math.min(meta.durationSec, viewStart + timebase), true)}` : "—"}</dd></div>
        <div><dt>Channels</dt><dd>{hasRecording ? `${visibleChannelCount} shown · ${selectedChannelCount} selected` : "—"}</dd></div>
        <div><dt>Integrity</dt><dd>{integrityStatus}</dd></div>
        <div><dt>Network</dt><dd>Recording data is not uploaded</dd></div>
      </dl>
      <p>{profile.detail} Browsers expose the file name, not its full local path.</p>
    </section>

    <section className="resource-detail-section resource-session-section">
      <header><h3>Workspace</h3><span>{openSessionCount} open tab{openSessionCount === 1 ? "" : "s"}</span></header>
      <dl>
        <div><dt>Local recovery</dt><dd className={recoveryStatus === "saved" ? "healthy" : "warning"}>{recoveryStatus === "saved" ? "Saved" : "Unavailable"}</dd></div>
        <div><dt>Processing</dt><dd>{verifyingSource ? "Source verification" : "Ready"}</dd></div>
      </dl>
    </section>
  </section>;
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
  return <div className="modal-backdrop map-backdrop"><div className="session-map-modal" role="dialog" aria-modal="true" aria-label="Session map and quality review" tabIndex={-1}>
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
