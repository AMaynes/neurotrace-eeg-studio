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

type Reliability = "gold" | "silver" | "bronze" | "gray";
type Geometry = "point" | "interval" | "window" | "session";
type TrackId = "context" | "state" | "events";
type AnnotationStatus = "draft" | "committed" | "suggestion";

type LabelDefinition = {
  id: string;
  name: string;
  short: string;
  color: string;
  geometry: Geometry;
  track: TrackId;
  defaultDuration: number;
  category: "Seizure" | "EEG state" | "Quality" | "Clinical";
  shortcut?: string;
};

type Annotation = {
  id: string;
  labelId: string;
  start: number;
  end: number;
  track: TrackId;
  channels: number[];
  confidence: number;
  reliability: Reliability;
  reviewer: string;
  notes: string;
  status: AnnotationStatus;
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
};

const LABELS: LabelDefinition[] = [
  { id: "ictal", name: "Ictal seizure", short: "ICTAL", color: "#ff6b7b", geometry: "interval", track: "state", defaultDuration: 12, category: "Seizure", shortcut: "1" },
  { id: "preictal", name: "Pre-ictal", short: "PRE", color: "#f3a85f", geometry: "interval", track: "state", defaultDuration: 30, category: "Seizure", shortcut: "2" },
  { id: "postictal", name: "Post-ictal", short: "POST", color: "#d887ef", geometry: "interval", track: "state", defaultDuration: 30, category: "Seizure", shortcut: "3" },
  { id: "iiic", name: "IIIC pattern", short: "IIIC", color: "#f3bb5f", geometry: "window", track: "state", defaultDuration: 30, category: "EEG state", shortcut: "4" },
  { id: "spikes", name: "Epileptiform spikes", short: "SPIKES", color: "#f6cf6a", geometry: "interval", track: "events", defaultDuration: 2, category: "EEG state", shortcut: "5" },
  { id: "nrem", name: "NREM sleep", short: "NREM", color: "#67aef8", geometry: "window", track: "state", defaultDuration: 30, category: "EEG state", shortcut: "6" },
  { id: "wake", name: "Normal wake", short: "WAKE", color: "#67d7a2", geometry: "window", track: "state", defaultDuration: 30, category: "EEG state", shortcut: "7" },
  { id: "artifact", name: "Artifact", short: "ARTIFACT", color: "#a9b2b8", geometry: "interval", track: "state", defaultDuration: 8, category: "Quality", shortcut: "8" },
  { id: "uncertain", name: "Uncertain", short: "?", color: "#a88cf4", geometry: "window", track: "state", defaultDuration: 30, category: "Quality", shortcut: "9" },
  { id: "button", name: "Button push", short: "BUTTON", color: "#55a9ff", geometry: "point", track: "events", defaultDuration: 0, category: "Clinical" },
  { id: "asm", name: "ASM given", short: "ASM", color: "#5fd4c8", geometry: "point", track: "events", defaultDuration: 0, category: "Clinical" },
  { id: "clinical", name: "Clinical observation", short: "OBS", color: "#ff8e96", geometry: "point", track: "events", defaultDuration: 0, category: "Clinical" },
  { id: "note", name: "Monitoring note", short: "NOTE", color: "#8db7f3", geometry: "interval", track: "context", defaultDuration: 5, category: "Clinical" },
  { id: "medication", name: "Medication context", short: "MED", color: "#78d5c8", geometry: "interval", track: "context", defaultDuration: 30, category: "Clinical" },
];

const LABEL_BY_ID = new Map(LABELS.map((label) => [label.id, label]));

const DEMO_ANNOTATIONS: Annotation[] = [
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
    track: LABEL_BY_ID.get(labelId)?.track ?? "events",
    channels: [],
    confidence,
    reliability,
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

function reliabilityLabel(value: Reliability) {
  return { gold: "SME expert", silver: "Detector / pseudo-label", bronze: "Imported file label", gray: "Unlabeled" }[value];
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

async function fileFingerprint(file: File) {
  const edge = 512 * 1024;
  const head = new Uint8Array(await file.slice(0, edge).arrayBuffer());
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - edge)).arrayBuffer());
  const meta = new TextEncoder().encode(`${file.name}|${file.size}|${file.lastModified}`);
  const combined = new Uint8Array(head.length + tail.length + meta.length);
  combined.set(head);
  combined.set(tail, head.length);
  combined.set(meta, head.length + tail.length);
  const digest = await crypto.subtle.digest("SHA-256", combined);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const annotationsRef = useRef<Annotation[]>(DEMO_ANNOTATIONS);
  const undoRef = useRef<Annotation[][]>([]);
  const redoRef = useRef<Annotation[][]>([]);
  const pointerRef = useRef<{ startX: number; startTime: number; moved: boolean } | null>(null);
  const dragAnnotationRef = useRef<{
    id: string;
    mode: "move" | "start" | "end";
    originX: number;
    original: Annotation;
    snapshot: Annotation[];
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
  const [display, setDisplay] = useState<DisplayWindow>({ data: [], labels: [], sampleRates: [] });
  const [loadingSignal, setLoadingSignal] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>(DEMO_ANNOTATIONS);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>("demo-ictal-972.4");
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [cursorTime, setCursorTime] = useState(978);
  const [cursorAmplitude, setCursorAmplitude] = useState(0);
  const [activeTool, setActiveTool] = useState<"cursor" | "interval" | "seizure">("cursor");
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
  const [pendingDat, setPendingDat] = useState<File | null>(null);
  const [pendingLegacyMeta, setPendingLegacyMeta] = useState<LegacyMatMetadata | null>(null);
  const [datMapping, setDatMapping] = useState({ sampleRate: 1000, channelCount: 128, physicalScale: 1 });
  const [confirmCommit, setConfirmCommit] = useState<string[]>([]);
  const [reviewer, setReviewer] = useState("AM");
  const [sourceHash, setSourceHash] = useState("8e41a9c7…b42d");

  annotationsRef.current = annotations;
  const selectedAnnotation = annotations.find((item) => item.id === selectedAnnotationId) ?? null;

  const setViewStartSafe = useCallback((next: number | ((value: number) => number)) => {
    setViewStart((current) => {
      const value = typeof next === "function" ? next(current) : next;
      return clamp(value, 0, Math.max(0, meta.durationSec - timebase));
    });
  }, [meta.durationSec, timebase]);

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
    const samplingRate = primarySampleRate(meta);
    const start = clamp(snapTime(Math.min(time, explicitEnd ?? time), snapMode, samplingRate), 0, meta.durationSec);
    let end = label.geometry === "point" ? start : explicitEnd ?? start + label.defaultDuration;
    end = clamp(snapTime(Math.max(end, start), snapMode, samplingRate), start, meta.durationSec);
    if (label.geometry === "window") {
      const windowStart = Math.floor(start / 30) * 30;
      end = Math.min(meta.durationSec, windowStart + 30);
      time = windowStart;
    }
    const now = new Date().toISOString();
    const next: Annotation = {
      id: makeId("ann"),
      labelId: label.id,
      start: label.geometry === "window" ? time : start,
      end,
      track: label.track,
      channels: focusedChannel >= 0 && label.id === "spikes" ? [focusedChannel] : [],
      confidence: label.id === "uncertain" ? 50 : 85,
      reliability: "gold",
      reviewer,
      notes: "",
      status: "draft",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    commitMutation((current) => [...current, next]);
    setSelectedAnnotationId(next.id);
    setSelection(null);
    setToast(`${label.name} placed at ${formatClock(next.start, true)} — draft`);
  }, [commitMutation, focusedChannel, meta, reviewer, snapMode]);

  const updateAnnotation = useCallback((id: string, patch: Partial<Annotation>, withHistory = true) => {
    const apply = (current: Annotation[]) => current.map((item) => item.id === id ? {
      ...item,
      ...patch,
      revision: item.revision + 1,
      updatedAt: new Date().toISOString(),
    } : item);
    if (withHistory) commitMutation(apply);
    else setAnnotations(apply);
  }, [commitMutation]);

  const deleteAnnotation = useCallback((id: string) => {
    commitMutation((current) => current.filter((item) => item.id !== id));
    setSelectedAnnotationId(null);
    setToast("Annotation removed — undo is available");
  }, [commitMutation]);

  const qcIssues = useMemo(() => {
    const issues: Array<{ level: "warning" | "info"; text: string; annotationId?: string }> = [];
    const ictal = annotations.filter((item) => item.labelId === "ictal");
    for (const item of ictal) {
      if (item.end - item.start < 3) issues.push({ level: "warning", text: `Seizure is ${(item.end - item.start).toFixed(1)} s (<3 s)`, annotationId: item.id });
    }
    for (let i = 0; i < ictal.length; i += 1) for (let j = i + 1; j < ictal.length; j += 1) {
      if (Math.abs(ictal[i].start - ictal[j].start) < 30) issues.push({ level: "warning", text: "Possible duplicate seizure onsets within 30 s", annotationId: ictal[j].id });
    }
    const states = annotations.filter((item) => ["wake", "nrem", "ictal", "artifact", "iiic"].includes(item.labelId));
    for (let i = 0; i < states.length; i += 1) for (let j = i + 1; j < states.length; j += 1) {
      if (states[i].labelId !== states[j].labelId && states[i].start < states[j].end && states[j].start < states[i].end) {
        issues.push({ level: "info", text: "Overlapping state labels need review", annotationId: states[j].id });
        i = states.length;
        break;
      }
    }
    const draftCount = annotations.filter((item) => item.status === "draft").length;
    if (draftCount) issues.push({ level: "info", text: `${draftCount} draft label${draftCount === 1 ? "" : "s"} not yet committed` });
    if (badChannels.size) issues.push({ level: "info", text: `${badChannels.size} channel${badChannels.size === 1 ? "" : "s"} excluded from derived montages` });
    return issues;
  }, [annotations, badChannels]);

  const commitSelected = useCallback((force = false) => {
    if (!selectedAnnotation) return;
    const warnings: string[] = [];
    if (selectedAnnotation.end < selectedAnnotation.start) warnings.push("Offset must follow onset.");
    if (selectedAnnotation.labelId === "ictal" && selectedAnnotation.end - selectedAnnotation.start < 3) warnings.push("Seizure duration is under 3 seconds.");
    const duplicate = annotations.some((item) => item.id !== selectedAnnotation.id && item.labelId === "ictal" && selectedAnnotation.labelId === "ictal" && Math.abs(item.start - selectedAnnotation.start) < 30);
    if (duplicate) warnings.push("Another seizure onset exists within 30 seconds.");
    if (warnings.length && !force) {
      setConfirmCommit(warnings);
      return;
    }
    updateAnnotation(selectedAnnotation.id, { status: "committed" });
    setConfirmCommit([]);
    setCandidates((items) => items.map((item, index) => index === activeCandidate ? { ...item, status: "reviewed" } : item));
    setToast(`Revision committed by ${reviewer}`);
  }, [activeCandidate, annotations, reviewer, selectedAnnotation, updateAnnotation]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(`neurotrace:draft:${sessionKey}`, JSON.stringify(annotations));
      } catch {
        // Private browsing or storage limits should never interrupt review.
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [annotations, sessionKey]);

  useEffect(() => {
    let cancelled = false;
    const source = sourceRef.current;
    const indices = [...selectedChannels].sort((a, b) => a - b);
    if (!indices.length) {
      setDisplay({ data: [], labels: [], sampleRates: [] });
      return;
    }
    setLoadingSignal(true);
    source.getWindow(viewStart, timebase, indices).then((windowData) => {
      if (cancelled) return;
      const filtered = applyDisplayFilters(windowData.data, windowData.sampleRates, filters);
      const labels = indices.map((index) => meta.channelLabels[index] ?? `Ch ${index + 1}`);
      const montageResult = buildMontage(filtered, labels, montage, new Set([...badChannels].map((index) => meta.channelLabels[index]).filter(Boolean)));
      setDisplay({ data: montageResult.data, labels: montageResult.labels, sampleRates: montageResult.sampleRates ?? windowData.sampleRates.slice(0, montageResult.data.length) });
      setLoadingSignal(false);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setLoadingSignal(false);
      setToast(error instanceof Error ? error.message : "Could not read this signal window");
    });
    return () => { cancelled = true; };
  }, [badChannels, filters, meta.channelLabels, montage, selectedChannels, timebase, viewStart]);

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
        const x2 = label.geometry === "point" ? x1 : ((Math.min(item.end, viewStart + timebase) - viewStart) / timebase) * width;
        context.globalAlpha = item.status === "suggestion" ? 0.07 : item.status === "draft" ? 0.11 : 0.075;
        context.fillStyle = label.color;
        context.fillRect(x1, 0, Math.max(label.geometry === "point" ? 2 : x2 - x1, 2), height);
        context.globalAlpha = 1;
        if (label.geometry === "point") {
          context.strokeStyle = label.color;
          context.setLineDash(item.status === "suggestion" ? [4, 4] : []);
          context.beginPath(); context.moveTo(x1, 20); context.lineTo(x1, height); context.stroke();
          context.setLineDash([]);
        }
      }

      if (selection) {
        const x1 = ((selection.start - viewStart) / timebase) * width;
        const x2 = ((selection.end - viewStart) / timebase) * width;
        context.fillStyle = "rgba(87,223,183,.12)";
        context.strokeStyle = "rgba(87,223,183,.82)";
        context.setLineDash([5, 4]);
        context.fillRect(Math.min(x1, x2), 0, Math.abs(x2 - x1), height);
        context.strokeRect(Math.min(x1, x2), 0, Math.abs(x2 - x1), height);
        context.setLineDash([]);
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

      const crossX = ((cursorTime - viewStart) / timebase) * width;
      if (crossX >= 0 && crossX <= width) {
        context.strokeStyle = "rgba(87,223,183,.9)";
        context.lineWidth = 1;
        context.beginPath(); context.moveTo(crossX, 0); context.lineTo(crossX, height); context.stroke();
        context.fillStyle = "#57dfb7";
        context.fillRect(crossX - 3, 0, 6, 3);
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
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [annotations, cursorTime, display, gain, markOnset, selection, timebase, viewStart]);

  const timeFromPointer = useCallback((event: { clientX: number }, element: HTMLElement, bypass = false) => {
    const rect = element.getBoundingClientRect();
    const raw = viewStart + clamp((event.clientX - rect.left) / rect.width, 0, 1) * timebase;
    return clamp(snapTime(raw, snapMode, primarySampleRate(meta), bypass), 0, meta.durationSec);
  }, [meta, snapMode, timebase, viewStart]);

  const onWavePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const time = timeFromPointer(event, event.currentTarget, event.altKey);
    pointerRef.current = { startX: event.clientX, startTime: time, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    setCursorTime(time);
  };

  const onWavePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const time = timeFromPointer(event, event.currentTarget, event.altKey);
    setCursorTime(time);
    const rect = event.currentTarget.getBoundingClientRect();
    const row = clamp(Math.floor(((event.clientY - rect.top) / rect.height) * Math.max(1, display.data.length)), 0, Math.max(0, display.data.length - 1));
    setFocusedChannel(row);
    const values = display.data[row];
    if (values?.length) {
      const sample = clamp(Math.floor(((time - viewStart) / timebase) * values.length), 0, values.length - 1);
      setCursorAmplitude(values[sample] ?? 0);
    }
    if (pointerRef.current && Math.abs(event.clientX - pointerRef.current.startX) > 3) {
      pointerRef.current.moved = true;
      setSelection({ start: Math.min(pointerRef.current.startTime, time), end: Math.max(pointerRef.current.startTime, time) });
    }
  };

  const onWavePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const pointer = pointerRef.current;
    pointerRef.current = null;
    if (!pointer) return;
    const time = timeFromPointer(event, event.currentTarget, event.altKey);
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
    } else if (pointer.moved && activeTool !== "cursor") {
      setToast(`Selected ${Math.abs(time - pointer.startTime).toFixed(1)} s — choose a label`);
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
    const onMove = (event: PointerEvent) => {
      const drag = dragAnnotationRef.current;
      const timeline = timelineRef.current;
      if (!drag || !timeline) return;
      const delta = ((event.clientX - drag.originX) / timeline.getBoundingClientRect().width) * timebase;
      const label = LABEL_BY_ID.get(drag.original.labelId);
      const duration = drag.original.end - drag.original.start;
      let start = drag.original.start;
      let end = drag.original.end;
      if (drag.mode === "move") {
        start = clamp(snapTime(drag.original.start + delta, snapMode, primarySampleRate(meta)), 0, meta.durationSec - duration);
        end = start + duration;
      } else if (drag.mode === "start") {
        start = clamp(snapTime(drag.original.start + delta, snapMode, primarySampleRate(meta)), 0, end - (label?.geometry === "point" ? 0 : 0.1));
      } else {
        end = clamp(snapTime(drag.original.end + delta, snapMode, primarySampleRate(meta)), start + (label?.geometry === "point" ? 0 : 0.1), meta.durationSec);
      }
      setAnnotations((current) => current.map((item) => item.id === drag.id ? { ...item, start, end } : item));
    };
    const onUp = () => {
      const drag = dragAnnotationRef.current;
      if (!drag) return;
      undoRef.current.push(drag.snapshot);
      redoRef.current = [];
      setAnnotations((current) => current.map((item) => item.id === drag.id ? { ...item, revision: item.revision + 1, updatedAt: new Date().toISOString() } : item));
      dragAnnotationRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [meta, snapMode, timebase]);

  const startAnnotationDrag = (event: ReactPointerEvent, item: Annotation, mode: "move" | "start" | "end") => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedAnnotationId(item.id);
    dragAnnotationRef.current = { id: item.id, mode, originX: event.clientX, original: { ...item }, snapshot: annotationsRef.current };
  };

  const jumpTo = useCallback((time: number) => {
    const start = clamp(time - timebase / 2, 0, Math.max(0, meta.durationSec - timebase));
    setViewStart(start);
    setCursorTime(time);
  }, [meta.durationSec, timebase]);

  const selectCandidate = (index: number) => {
    setActiveCandidate(index);
    setCandidates((items) => items.map((item, itemIndex) => ({ ...item, status: itemIndex === index ? "active" : item.status === "active" ? "queued" : item.status })));
    jumpTo(candidates[index].time);
  };

  const loadSource = useCallback(async (source: SignalSource, file: File) => {
    sourceRef.current = source;
    const nextMeta = sourceMeta(source);
    const fingerprint = await fileFingerprint(file);
    const nextKey = fingerprint.slice(0, 24);
    setMeta(nextMeta);
    setSessionKey(nextKey);
    setSourceHash(`${fingerprint.slice(0, 8)}…${fingerprint.slice(-4)}`);
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
      const cached = localStorage.getItem(`neurotrace:draft:${nextKey}`);
      if (cached) restored = JSON.parse(cached) as Annotation[];
    } catch { /* ignore unavailable local recovery */ }
    setAnnotations(restored);
    undoRef.current = [];
    redoRef.current = [];
    setToast(restored.length ? `Recovered ${restored.length} local draft labels` : `${nextMeta.format} recording ready — ${nextMeta.channelLabels.length} channels`);
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
        await loadSource(await EDFSource.create(edf), edf);
      } else if (dat) {
        let legacyMetadata: LegacyMatMetadata | null = null;
        if (mat) {
          try {
            legacyMetadata = await parseLegacyMatMetadata(mat);
            setDatMapping((current) => ({
              ...current,
              sampleRate: legacyMetadata?.sampleRate ?? current.sampleRate,
              channelCount: (legacyMetadata?.channelCount || legacyMetadata?.channelLabels.length || current.channelCount),
            }));
          } catch (error) {
            setToast(`Companion MAT needs manual mapping: ${error instanceof Error ? error.message : "metadata could not be read"}`);
          }
        }
        setPendingDat(dat);
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
      const source = await RawDatSource.create(pendingDat, {
        ...datMapping,
        channelLabels: pendingLegacyMeta?.channelLabels.length === datMapping.channelCount ? pendingLegacyMeta.channelLabels : undefined,
        channelUnits: "µV",
      });
      await loadSource(source, pendingDat);
      if (pendingLegacyMeta?.events.length) {
        const seizureTerms = /sz|seizure|seiz|tonic|eeg onset/i;
        const importedCandidates = pendingLegacyMeta.events
          .filter((event) => seizureTerms.test(event.label))
          .map((event, index): Candidate => ({
            id: makeId("cand"),
            time: event.timeSec,
            label: event.label,
            source: "bronze",
            status: index === 0 ? "active" : "queued",
          }));
        setCandidates(importedCandidates);
        if (importedCandidates[0]) {
          const importedWindow = Math.min(20, Math.max(5, source.meta.durationSec));
          setViewStart(clamp(importedCandidates[0].time - importedWindow / 2, 0, Math.max(0, source.meta.durationSec - importedWindow)));
          setCursorTime(clamp(importedCandidates[0].time, 0, source.meta.durationSec));
        }
      }
      setPendingDat(null);
      setPendingLegacyMeta(null);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Raw binary mapping failed");
    } finally {
      setImportBusy(false);
    }
  };

  const exportBundle = () => {
    const sampleRate = primarySampleRate(meta);
    const patientId = patientLabel(meta);
    const recordingId = recordingLabel(meta);
    const base = recordingId.replace(/[^a-zA-Z0-9_-]+/g, "_");
    const committed = annotations.filter((item) => item.status !== "draft");
    const eventsTsv = ["onset\tduration\ttrial_type\tconfidence\tsource\treviewer\tchannels\tnotes", ...committed.map((item) => {
      const label = LABEL_BY_ID.get(item.labelId);
      return [item.start.toFixed(6), Math.max(0, item.end - item.start).toFixed(6), label?.name ?? item.labelId, item.confidence, item.reliability, item.reviewer, item.channels.map((index) => meta.channelLabels[index]).join(","), item.notes.replace(/[\t\r\n]+/g, " ")].join("\t");
    })].join("\n");
    const channelsTsv = ["name\ttype\tunits\tsampling_frequency\tstatus\tstatus_description", ...meta.channelLabels.map((name, index) => [name, recordingType.includes("SEEG") ? "SEEG" : "EEG", meta.channelUnits[index] ?? "uV", meta.sampleRates[index] ?? sampleRate, badChannels.has(index) ? "bad" : "good", badChannels.has(index) ? "Reviewer-excluded channel" : ""].join("\t"))].join("\n");
    const windowRows = ["patient_id,session_id,start_sec,end_sec,start_sample,end_sample,labels,next_seizure_sec,confidence,reliability,bad_channel_mask,split"];
    const seizureStarts = committed.filter((item) => item.labelId === "ictal").map((item) => item.start).sort((a, b) => a - b);
    for (let start = 0; start < meta.durationSec; start += 30) {
      const end = Math.min(meta.durationSec, start + 30);
      const overlapping = committed.filter((item) => item.start < end && item.end >= start).map((item) => item.labelId);
      const nextSeizure = seizureStarts.find((time) => time >= end);
      const relevant = committed.filter((item) => item.start < end && item.end >= start);
      const confidence = relevant.length ? Math.round(relevant.reduce((sum, item) => sum + item.confidence, 0) / relevant.length) : "";
      const reliability = relevant.length ? relevant.map((item) => item.reliability).join("|") : "gray";
      windowRows.push([patientId, recordingId, start.toFixed(3), end.toFixed(3), Math.round(start * sampleRate), Math.round(end * sampleRate), `"${[...new Set(overlapping)].join("|")}"`, nextSeizure === undefined ? "" : (nextSeizure - end).toFixed(3), confidence, reliability, `"${[...badChannels].join("|")}"`, "unassigned"].join(","));
    }
    const recordingJson = JSON.stringify({
      patient_id: patientId,
      session_id: recordingId,
      recording_type: recordingType,
      format: meta.format,
      duration_seconds: meta.durationSec,
      sampling_frequency: sampleRate,
      start_time: meta.startedAt?.toISOString(),
      source_hash: sourceHash,
      display_snapshot: { montage, filters, gain, snapMode },
      local_processing: true,
      generated_at: new Date().toISOString(),
    }, null, 2);
    const ontology = JSON.stringify({ version: "neurotrace-1.0.0", labels: LABELS }, null, 2);
    const annotationsJsonl = annotations.map((item) => JSON.stringify({ ...item, label: LABEL_BY_ID.get(item.labelId)?.name, start_sample: Math.round(item.start * sampleRate), end_sample: Math.round(item.end * sampleRate), source_hash: sourceHash, montage, display_filters: filters })).join("\n");
    const qcReport = JSON.stringify({ generated_at: new Date().toISOString(), issues: qcIssues, bad_channels: [...badChannels].map((index) => meta.channelLabels[index]), drafts_excluded_from_events_tsv: annotations.filter((item) => item.status === "draft").length }, null, 2);
    const manifest = JSON.stringify({ schema: "neurotrace-forecasting-manifest/1.0", patient: patientId, recording_type: recordingType, session: recordingId, files: ["events.tsv", "channels.tsv", "recording.json", "annotations.jsonl", "windows.csv", "ontology.json", "qc_report.json"], leakage_guard: "Assign train/validation/test split by patient; current split is unassigned." }, null, 2);
    const readme = "NeuroTrace model-ready annotation bundle\n\nRaw EEG is not included. Boundaries are stored in seconds and samples. Draft labels remain in annotations.jsonl but are excluded from events.tsv. Review recording.json and qc_report.json before training. Group dataset splits by patient to prevent leakage.\n";
    const zip = createStoredZip([
      { name: `${base}/events.tsv`, content: eventsTsv },
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
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select")) return;
      const lower = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && lower === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault(); setViewStartSafe((value) => value - (event.shiftKey ? 10 : 1));
      } else if (event.key === "ArrowRight") {
        event.preventDefault(); setViewStartSafe((value) => value + (event.shiftKey ? 10 : 1));
      } else if (event.key === "PageDown") {
        event.preventDefault(); setViewStartSafe((value) => value + timebase);
      } else if (event.key === "PageUp") {
        event.preventDefault(); setViewStartSafe((value) => value - timebase);
      } else if (event.key === "+" || event.key === "=") {
        setTimebase((value) => Math.max(5, value / 2));
      } else if (event.key === "-" || event.key === "_") {
        setTimebase((value) => Math.min(120, value * 2));
      } else if (lower === "u") {
        event.shiftKey ? redo() : undo();
      } else if (lower === "i") {
        setMarkOnset(cursorTime); setActiveTool("seizure"); setToast(`Onset placed at ${formatClock(cursorTime, true)} — press O at offset`);
      } else if (lower === "o" && markOnset !== null) {
        if (cursorTime > markOnset) { addAnnotation(LABEL_BY_ID.get("ictal")!, markOnset, cursorTime); setMarkOnset(null); setActiveTool("cursor"); }
        else setToast("Offset must be after onset");
      } else if (lower === "s" || event.key === "Enter") {
        commitSelected();
      } else if (event.key === "Escape") {
        setSelection(null); setMarkOnset(null); setActiveTool("cursor"); setToast("Current tool cancelled");
      } else if (lower === "n" && candidates.length) {
        selectCandidate(Math.min(candidates.length - 1, activeCandidate + 1));
      } else if (lower === "p" && candidates.length) {
        selectCandidate(Math.max(0, activeCandidate - 1));
      } else if (lower === "b" && selectedChannels.size) {
        const originalIndex = [...selectedChannels][focusedChannel] ?? [...selectedChannels][0];
        setBadChannels((current) => { const next = new Set(current); next.has(originalIndex) ? next.delete(originalIndex) : next.add(originalIndex); return next; });
        setToast("Focused channel quality updated");
      } else if (event.key === "?") {
        setShowShortcuts(true);
      } else if (/^[1-9]$/.test(event.key)) {
        const label = LABELS.find((item) => item.shortcut === event.key);
        if (label) addAnnotation(label, selection?.start ?? cursorTime, selection?.end);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeCandidate, addAnnotation, candidates, commitSelected, cursorTime, focusedChannel, markOnset, redo, selectCandidate, selectedChannels, selection, setViewStartSafe, timebase, undo]);

  const overviewLeft = (viewStart / Math.max(1, meta.durationSec)) * 100;
  const overviewWidth = Math.min(100, (timebase / Math.max(1, meta.durationSec)) * 100);
  const activeLabelGroups = ["Seizure", "EEG state", "Quality", "Clinical"] as const;
  const filteredLabels = LABELS.filter((label) => label.name.toLowerCase().includes(paletteSearch.toLowerCase()));
  const tracks: Array<{ id: TrackId; label: string }> = [
    { id: "context", label: "Context" },
    { id: "state", label: "State / windows" },
    { id: "events", label: "Events" },
  ];

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
          <span className="privacy-pill"><span className="privacy-dot" /> Local-only · PHI stays here</span>
          <button className="qc-pill" onClick={() => { setRightTab("qc"); setRightTab("qc"); }}><span>{qcIssues.filter((issue) => issue.level === "warning").length}</span> QC</button>
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

      <div className="workspace-grid">
        <aside className="left-sidebar">
          <section className="sidebar-section session-card">
            <div className="section-heading"><span>Session</span><button aria-label="Open session map" onClick={() => setShowSessionMap(true)}>↗</button></div>
            <div className="file-row"><span className="file-type">{meta.format}</span><div><strong title={meta.name}>{shortFileName(meta.name)}</strong><small>{formatClock(meta.durationSec)} · {meta.channelLabels.length} ch · {primarySampleRate(meta)} Hz</small></div></div>
            <div className="session-detail-grid">
              <div><span>Started</span><strong>{meta.startedAt ? meta.startedAt.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Not provided"}</strong></div>
              <div><span>Source</span><strong className="hash-text">{sourceHash}</strong></div>
            </div>
            <label className="compact-field"><span>Recording type</span><select value={recordingType} onChange={(event) => setRecordingType(event.target.value)}><option>SEEG / iEEG</option><option>Scalp EEG</option><option>Simultaneous scalp + iEEG</option><option>Other ephys</option></select></label>
          </section>

          <section className="sidebar-section queue-section">
            <div className="section-heading"><span>Review queue</span><small>{candidates.filter((item) => item.status === "reviewed").length}/{candidates.length}</small></div>
            <div className="queue-list">
              {candidates.length ? candidates.map((candidate, index) => <button key={candidate.id} className={`queue-item ${index === activeCandidate ? "active" : ""}`} onClick={() => selectCandidate(index)}>
                <span className={`queue-status ${candidate.status}`} />
                <span className="queue-copy"><strong>{candidate.label}</strong><small>{formatClock(candidate.time, true)} · {reliabilityLabel(candidate.source)}</small></span>
                <span className="queue-arrow">›</span>
              </button>) : <div className="empty-queue"><strong>No imported candidates</strong><p>Review freely or add the cursor position.</p><button onClick={() => setCandidates([{ id: makeId("cand"), time: cursorTime, label: "Manual review target", source: "gold", status: "active" }])}>+ Add {formatClock(cursorTime, true)}</button></div>}
            </div>
          </section>

          <section className="sidebar-section channel-section">
            <div className="section-heading"><span>Channels</span><small>{selectedChannels.size}/{meta.channelLabels.length}</small></div>
            <div className="channel-tools"><input aria-label="Search channels" placeholder="Find contact…" value={channelSearch} onChange={(event) => setChannelSearch(event.target.value)} /><button onClick={() => setSelectedChannels(new Set(meta.channelLabels.map((_, index) => index)))}>All</button></div>
            <div className="channel-list">
              {meta.channelLabels.map((name, index) => ({ name, index })).filter(({ name }) => name.toLowerCase().includes(channelSearch.toLowerCase())).map(({ name, index }) => <label key={`${name}-${index}`} className={`channel-row ${badChannels.has(index) ? "bad" : ""}`}>
                <input type="checkbox" checked={selectedChannels.has(index)} onChange={() => setSelectedChannels((current) => { const next = new Set(current); next.has(index) ? next.delete(index) : next.add(index); return next; })} />
                <span className="channel-name">{name}</span>
                <span className="channel-unit">{meta.channelUnits[index] ?? "µV"}</span>
                <button type="button" title={badChannels.has(index) ? "Restore channel" : "Mark bad"} onClick={(event) => { event.preventDefault(); setBadChannels((current) => { const next = new Set(current); next.has(index) ? next.delete(index) : next.add(index); return next; }); }}>{badChannels.has(index) ? "BAD" : "···"}</button>
              </label>)}
            </div>
          </section>
        </aside>

        <section className="review-surface">
          <div className="viewer-toolbar">
            <div className="transport-group">
              <button aria-label="Previous page" onClick={() => setViewStartSafe((value) => value - timebase)}>‹</button>
              <button className={`play-button ${playing ? "playing" : ""}`} aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying((value) => !value)}>{playing ? "Ⅱ" : "▶"}</button>
              <button aria-label="Next page" onClick={() => setViewStartSafe((value) => value + timebase)}>›</button>
            </div>
            <div className="toolbar-divider" />
            <button className={`tool-button ${activeTool === "cursor" ? "active" : ""}`} onClick={() => setActiveTool("cursor")}><span>⌖</span> Cursor</button>
            <button className={`tool-button ${activeTool === "interval" ? "active" : ""}`} onClick={() => setActiveTool("interval")}><span>↔</span> Select</button>
            <button className={`tool-button onset-tool ${activeTool === "seizure" ? "active" : ""}`} onClick={() => { setActiveTool("seizure"); setMarkOnset(null); setToast("Seizure tool — click onset, then offset"); }}><span>◈</span> Mark seizure</button>
            <div className="toolbar-spacer" />
            <label className="toolbar-select"><span>Montage</span><select value={montage} onChange={(event) => setMontage(event.target.value as MontageMode)}><option value="referential">Recorded reference</option><option value="average">Average reference</option><option value="bipolar">Anatomical bipolar</option></select></label>
            <button className={`compact-toggle ${showFilters ? "active" : ""}`} onClick={() => setShowFilters((value) => !value)}><span className="filter-glyph">≋</span> Filters <i>{filters.enabled ? `${filters.highPassHz}–${filters.lowPassHz} · ${filters.notchHz}Hz` : "Raw"}</i></button>
            <label className="toolbar-select small"><span>Window</span><select value={timebase} onChange={(event) => setTimebase(Number(event.target.value))}>{[5, 10, 20, 30, 60, 120].map((value) => <option key={value} value={value}>{value} s</option>)}</select></label>
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

          <div className={`signal-and-tracks ${spectrogramOpen ? "with-spectrogram" : ""}`} onDragOver={onLabelDragOver} onDrop={onLabelDrop} onDragLeave={() => setDragGhost(null)}>
            <div className="waveform-wrap">
              <div className="channel-rail" style={{ gridTemplateRows: `repeat(${Math.max(1, display.labels.length)}, 1fr)` }}>
                {display.labels.map((label, index) => <button key={`${label}-${index}`} className={focusedChannel === index ? "focused" : ""} onClick={() => setFocusedChannel(index)}><strong>{label}</strong><span>{formatAmplitude(display.data[index]?.[Math.floor(display.data[index].length / 2)] ?? 0)}</span></button>)}
              </div>
              <div className="canvas-shell">
                <canvas ref={canvasRef} onPointerDown={onWavePointerDown} onPointerMove={onWavePointerMove} onPointerUp={onWavePointerUp} />
                {loadingSignal && <div className="signal-loading"><span /> Reading signal window…</div>}
                {dragGhost && <div className="drop-ghost" style={{ left: `${((dragGhost.time - viewStart) / timebase) * 100}%` }}><span>{formatClock(dragGhost.time, true)}</span></div>}
                {!display.data.length && !loadingSignal && <div className="no-channels"><strong>No visible channels</strong><span>Select channels in the left panel.</span></div>}
              </div>
            </div>

            {spectrogramOpen && <SpectrogramPanel data={display.data[focusedChannel]} sampleRate={display.sampleRates[focusedChannel] || primarySampleRate(meta)} start={viewStart} cursor={cursorTime} label={display.labels[focusedChannel] || "Focused channel"} />}

            <div className="timeline" ref={timelineRef}>
              {tracks.map((track) => <div className="timeline-row" key={track.id}>
                <div className="track-label"><span className={`track-icon ${track.id}`} />{track.label}</div>
                <div className="track-lane" onDoubleClick={(event) => {
                  const time = timeFromPointer(event, event.currentTarget, event.altKey);
                  const label = filteredLabels.find((item) => item.track === track.id);
                  if (label) addAnnotation(label, time);
                }}>
                  <div className="window-grid">{Array.from({ length: Math.ceil(timebase / 5) }, (_, index) => <i key={index} />)}</div>
                  {annotations.filter((item) => item.track === track.id && item.end >= viewStart && item.start <= viewStart + timebase).map((item) => {
                    const label = LABEL_BY_ID.get(item.labelId)!;
                    const point = label.geometry === "point";
                    const left = ((item.start - viewStart) / timebase) * 100;
                    const width = point ? 0 : Math.max(0.7, ((item.end - item.start) / timebase) * 100);
                    return point ? <button key={item.id} className={`event-pin ${selectedAnnotationId === item.id ? "selected" : ""}`} style={{ left: `${left}%`, "--label-color": label.color } as React.CSSProperties} onClick={() => setSelectedAnnotationId(item.id)} title={`${label.name} · ${formatClock(item.start, true)}`}><i /><span>{label.short}</span></button> : <div key={item.id} className={`annotation-block ${item.status} ${selectedAnnotationId === item.id ? "selected" : ""}`} style={{ left: `${left}%`, width: `${width}%`, "--label-color": label.color } as React.CSSProperties} onPointerDown={(event) => startAnnotationDrag(event, item, "move")} onClick={() => setSelectedAnnotationId(item.id)}>
                      <button className="resize-handle start" aria-label="Resize start" onPointerDown={(event) => startAnnotationDrag(event, item, "start")} />
                      <strong>{label.short}</strong><span>{(item.end - item.start).toFixed(1)}s</span>
                      <button className="resize-handle end" aria-label="Resize end" onPointerDown={(event) => startAnnotationDrag(event, item, "end")} />
                    </div>;
                  })}
                </div>
              </div>)}
            </div>
          </div>

          <footer className="command-strip">
            <div className="cursor-readout"><span className="crosshair-mini">⌖</span><strong>{formatClock(cursorTime, true)}</strong><span>{display.labels[focusedChannel] ?? "—"}</span><span>{formatAmplitude(cursorAmplitude)}</span><span>sample {Math.round(cursorTime * primarySampleRate(meta)).toLocaleString()}</span></div>
            <div className="command-status"><span className="status-dot" />{toast}</div>
            <div className="strip-actions"><button onClick={undo}>U <span>Undo</span></button><button onClick={redo}>⇧U <span>Redo</span></button><button onClick={() => setSpectrogramOpen((value) => !value)} className={spectrogramOpen ? "active" : ""}>W <span>Spectrum</span></button><button onClick={() => setShowShortcuts(true)}>?</button><label>Snap <select value={snapMode} onChange={(event) => setSnapMode(event.target.value as "1s" | "100ms" | "sample")}><option value="1s">1 s</option><option value="100ms">100 ms</option><option value="sample">Sample</option></select></label></div>
          </footer>
        </section>

        <aside className="right-sidebar">
          <div className="right-tabs"><button className={rightTab === "labels" ? "active" : ""} onClick={() => setRightTab("labels")}>Labels</button><button className={rightTab === "qc" ? "active" : ""} onClick={() => setRightTab("qc")}>QC <span>{qcIssues.length}</span></button></div>
          {rightTab === "labels" ? <>
            <section className="palette-section">
              <div className="palette-heading"><div><strong>Label palette</strong><span>Drag onto exact time</span></div><button title="Manage ontology">＋</button></div>
              <input className="palette-search" placeholder="Search ontology…" value={paletteSearch} onChange={(event) => setPaletteSearch(event.target.value)} />
              <div className="palette-groups">
                {activeLabelGroups.map((category) => {
                  const group = filteredLabels.filter((label) => label.category === category);
                  if (!group.length) return null;
                  return <div className="palette-group" key={category}><span>{category}</span><div>{group.map((label) => <button key={label.id} draggable onDragStart={(event) => { event.dataTransfer.setData("application/x-neurotrace-label", label.id); event.dataTransfer.effectAllowed = "copy"; setDragGhost({ labelId: label.id, time: cursorTime }); }} onDragEnd={() => setDragGhost(null)} onClick={() => addAnnotation(label, selection?.start ?? cursorTime, selection?.end)} style={{ "--label-color": label.color } as React.CSSProperties} title={`Drag to waveform${label.shortcut ? ` · shortcut ${label.shortcut}` : ""}`}><i />{label.name}{label.shortcut && <kbd>{label.shortcut}</kbd>}</button>)}</div></div>;
                })}
              </div>
            </section>
            <section className="inspector-section">
              <div className="inspector-heading"><strong>{selectedAnnotation ? "Annotation inspector" : "Selection inspector"}</strong>{selectedAnnotation && <span className={`revision-state ${selectedAnnotation.status}`}>{selectedAnnotation.status}</span>}</div>
              {selectedAnnotation ? <div className="inspector-form">
                <div className="selected-label" style={{ "--label-color": LABEL_BY_ID.get(selectedAnnotation.labelId)?.color } as React.CSSProperties}><i /><div><strong>{LABEL_BY_ID.get(selectedAnnotation.labelId)?.name}</strong><span>{LABEL_BY_ID.get(selectedAnnotation.labelId)?.geometry} label · revision {selectedAnnotation.revision}</span></div></div>
                <div className="time-fields"><label><span>Start (s)</span><input type="number" step="0.001" value={selectedAnnotation.start} onChange={(event) => updateAnnotation(selectedAnnotation.id, { start: clamp(Number(event.target.value), 0, selectedAnnotation.end) })} /></label><label><span>End (s)</span><input type="number" step="0.001" value={selectedAnnotation.end} disabled={LABEL_BY_ID.get(selectedAnnotation.labelId)?.geometry === "point"} onChange={(event) => updateAnnotation(selectedAnnotation.id, { end: clamp(Number(event.target.value), selectedAnnotation.start, meta.durationSec) })} /></label></div>
                <div className="duration-line"><span>{formatClock(selectedAnnotation.start, true)}</span><i /><span>{(selectedAnnotation.end - selectedAnnotation.start).toFixed(3)} s</span></div>
                <label className="form-field"><span>Reviewer</span><input value={selectedAnnotation.reviewer} onChange={(event) => updateAnnotation(selectedAnnotation.id, { reviewer: event.target.value })} /></label>
                <label className="form-field"><span>Source / reliability</span><select value={selectedAnnotation.reliability} onChange={(event) => updateAnnotation(selectedAnnotation.id, { reliability: event.target.value as Reliability })}><option value="gold">Gold · SME expert</option><option value="silver">Silver · detector / pseudo-label</option><option value="bronze">Bronze · imported file label</option><option value="gray">Gray · unlabeled</option></select></label>
                <label className="confidence-field"><span>Confidence <strong>{selectedAnnotation.confidence}%</strong></span><input type="range" min="0" max="100" value={selectedAnnotation.confidence} onChange={(event) => updateAnnotation(selectedAnnotation.id, { confidence: Number(event.target.value) }, false)} /></label>
                <label className="form-field"><span>Clinical / review note</span><textarea rows={3} placeholder="Evidence, uncertainty, or rationale…" value={selectedAnnotation.notes} onChange={(event) => updateAnnotation(selectedAnnotation.id, { notes: event.target.value }, false)} /></label>
                <div className="inspector-actions"><button className="button primary" onClick={() => commitSelected()}>{selectedAnnotation.status === "committed" ? "Save revision" : "Commit label"}</button><button className="icon-danger" onClick={() => deleteAnnotation(selectedAnnotation.id)} title="Delete annotation">⌫</button></div>
                <div className="snapshot-note"><span>DISPLAY SNAPSHOT</span><strong>{montage === "bipolar" ? "Bipolar" : montage === "average" ? "Average ref" : "Recorded ref"} · {filters.enabled ? `${filters.highPassHz}–${filters.lowPassHz} Hz · ${filters.notchHz} Hz notch` : "Raw"}</strong><small>Stored with exported revision; raw samples unchanged.</small></div>
              </div> : <div className="selection-empty">
                <div className="selection-graphic"><span /><span /></div>
                <strong>{selection ? `${(selection.end - selection.start).toFixed(1)} second selection` : "Select or place a label"}</strong>
                <p>Drag a label onto the waveform, paint an interval, or click any timeline item to inspect it.</p>
              </div>}
            </section>
          </> : <QcPanel issues={qcIssues} annotations={annotations} badChannels={badChannels} meta={meta} onSelect={(id) => { setSelectedAnnotationId(id); setRightTab("labels"); }} />}
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
            <p>{pendingLegacyMeta ? `Companion MAT metadata found ${pendingLegacyMeta.channelLabels.length || pendingLegacyMeta.channelCount || 0} channels and ${pendingLegacyMeta.events.length} timestamped events. Confirm the recovered binary layout.` : "Confirm the raw binary layout. These values are required because the legacy MATLAB tool delegates them to Buzcode."}</p>
            <div className="mapper-fields"><label><span>Sample rate</span><input type="number" value={datMapping.sampleRate} onChange={(event) => setDatMapping((current) => ({ ...current, sampleRate: Number(event.target.value) }))} /><small>Hz</small></label><label><span>Channels</span><input type="number" value={datMapping.channelCount} onChange={(event) => setDatMapping((current) => ({ ...current, channelCount: Number(event.target.value) }))} /></label><label><span>Scale</span><input type="number" step="0.001" value={datMapping.physicalScale} onChange={(event) => setDatMapping((current) => ({ ...current, physicalScale: Number(event.target.value) }))} /><small>µV/count</small></label></div>
            <button className="button primary wide" onClick={confirmDatImport}>Open mapped DAT</button>
          </div>}
          <div className="format-cards"><div><strong>EDF / EDF+</strong><span>Calibrated signals, channel metadata, full recording timeline</span></div><div><strong>MAT v5</strong><span>Automatic largest-matrix detection with sampling-rate discovery</span></div><div><strong>MAT + DAT</strong><span>Manual binary confirmation for legacy Buzcode sessions</span></div></div>
          <div className="research-notice"><span>✦</span><p><strong>Research annotation workspace.</strong> Not for diagnosis or autonomous clinical decision-making. Hospital deployment still requires institutional privacy, security, and validation review.</p></div>
        </div>
      </div>}

      {confirmCommit.length > 0 && <div className="modal-backdrop"><div className="modal confirm-modal"><span className="warning-mark">!</span><h2>Review before committing</h2><p>The label is valid, but the QC engine found an advisory:</p><ul>{confirmCommit.map((warning) => <li key={warning}>{warning}</li>)}</ul><div className="modal-actions"><button className="button secondary" onClick={() => setConfirmCommit([])}>Return to label</button><button className="button primary" onClick={() => commitSelected(true)}>Commit with advisory</button></div></div></div>}

      {showShortcuts && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowShortcuts(false); }}><div className="modal shortcuts-modal"><button className="modal-close" onClick={() => setShowShortcuts(false)}>×</button><span className="modal-eyebrow">KEYBOARD WORKFLOW</span><h2>Review at signal speed.</h2><div className="shortcut-grid">{[["← / →", "Pan 1 second"], ["⇧ ← / →", "Pan 10 seconds"], ["PgUp / PgDn", "Previous / next page"], ["I / O", "Seizure onset / offset"], ["1–9", "Apply palette label"], ["S / Enter", "Commit selected label"], ["U / ⇧U", "Undo / redo"], ["N / P", "Next / previous candidate"], ["B", "Toggle focused channel bad"], ["Esc", "Cancel current tool"]].map(([key, action]) => <div key={key}><kbd>{key}</kbd><span>{action}</span></div>)}</div></div></div>}

      {showSessionMap && <SessionMap meta={meta} annotations={annotations} candidates={candidates} onClose={() => setShowSessionMap(false)} />}
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
      const cursorX = ((cursor - start) / (data.length / sampleRate)) * width;
      ctx.strokeStyle = "#57dfb7"; ctx.beginPath(); ctx.moveTo(cursorX, 0); ctx.lineTo(cursorX, height); ctx.stroke();
    };
    draw();
    const observer = new ResizeObserver(draw); observer.observe(canvas); return () => observer.disconnect();
  }, [cursor, data, sampleRate, start]);
  return <div className="spectrogram-panel"><div className="spectrogram-label"><strong>{label}</strong><span>1–{Math.min(150, Math.floor(sampleRate / 2))} Hz · log power · display only</span></div><canvas ref={ref} /></div>;
}

function QcPanel({ issues, annotations, badChannels, meta, onSelect }: { issues: Array<{ level: "warning" | "info"; text: string; annotationId?: string }>; annotations: Annotation[]; badChannels: Set<number>; meta: RecordingMeta; onSelect: (id: string) => void }) {
  const committed = annotations.filter((item) => item.status === "committed").length;
  const drafts = annotations.filter((item) => item.status === "draft").length;
  return <div className="qc-panel">
    <section className="qc-score"><div className="score-ring"><strong>{issues.filter((item) => item.level === "warning").length ? "92" : "100"}</strong><span>QC</span></div><div><strong>Export readiness</strong><span>{issues.filter((item) => item.level === "warning").length ? "Advisories need review" : "All blocking checks passed"}</span></div></section>
    <section className="qc-metrics"><div><strong>{committed}</strong><span>Committed</span></div><div><strong>{drafts}</strong><span>Drafts</span></div><div><strong>{badChannels.size}</strong><span>Bad ch</span></div></section>
    <section className="qc-checks"><div className="qc-heading"><strong>Checks</strong><span>{issues.length} findings</span></div>{issues.length ? issues.map((issue, index) => <button key={`${issue.text}-${index}`} onClick={() => issue.annotationId && onSelect(issue.annotationId)}><i className={issue.level} /><div><strong>{issue.level === "warning" ? "Advisory" : "Review note"}</strong><span>{issue.text}</span></div><b>›</b></button>) : <div className="qc-clean"><span>✓</span><strong>No annotation conflicts</strong><p>Bounds, provenance, state overlap, and duplicate checks passed.</p></div>}</section>
    <section className="file-qc"><div className="qc-heading"><strong>Source integrity</strong><span>{meta.format}</span></div><ul><li><span>✓</span> Header parsed and duration bounded</li><li><span>✓</span> {meta.channelLabels.length} named channels retained</li><li><span>✓</span> Raw source remains immutable</li><li><span>✓</span> Local recovery enabled</li></ul></section>
  </div>;
}

function SessionMap({ meta, annotations, candidates, onClose }: { meta: RecordingMeta; annotations: Annotation[]; candidates: Candidate[]; onClose: () => void }) {
  const tracks = [
    { id: "context", label: "Context / notes" },
    { id: "state", label: "Session / segment state" },
    { id: "events", label: "Event labels" },
  ] as const;
  return <div className="modal-backdrop map-backdrop"><div className="session-map-modal"><header><div><span className="modal-eyebrow">MODEL-READY SESSION MAP</span><h2>{patientLabel(meta)} <i>/</i> {recordingLabel(meta)}</h2><p>{meta.channelLabels.length} channels · {formatClock(meta.durationSec)} · {primarySampleRate(meta)} Hz</p></div><button onClick={onClose}>×</button></header><div className="map-equation"><span>session timeline</span><b>＋</b><span>context labels</span><b>＋</b><span>window labels</span><b>＋</b><span>event labels</span><b>→</b><strong>training data</strong></div><div className="map-timeline"><div className="map-ruler">{[0, .25, .5, .75, 1].map((fraction) => <span key={fraction} style={{ left: `${fraction * 100}%` }}>{formatClock(meta.durationSec * fraction)}</span>)}</div>{tracks.map((track) => <div className="map-row" key={track.id}><strong>{track.label}</strong><div>{annotations.filter((item) => item.track === track.id).map((item) => { const label = LABEL_BY_ID.get(item.labelId)!; return <span key={item.id} title={`${label.name} · ${formatClock(item.start, true)}`} style={{ left: `${(item.start / meta.durationSec) * 100}%`, width: `${Math.max(.35, ((item.end - item.start) / meta.durationSec) * 100)}%`, background: label.color }}>{label.geometry === "point" ? "" : label.short}</span>; })}</div></div>)}<div className="map-row candidates"><strong>Candidate queue</strong><div>{candidates.map((item) => <span key={item.id} style={{ left: `${(item.time / meta.durationSec) * 100}%` }} title={item.label} />)}</div></div></div><footer><div className="reliability-legend"><span><i className="gold" />Gold · SME</span><span><i className="silver" />Silver · detector</span><span><i className="bronze" />Bronze · imported</span><span><i className="gray" />Gray · unlabeled</span></div><button className="button primary" onClick={onClose}>Return to review</button></footer></div></div>;
}
