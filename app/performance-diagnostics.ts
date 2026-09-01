/**
 * Lightweight, browser-safe performance diagnostics for the EEG workspace.
 *
 * The collector deliberately keeps performance work separate from React. A
 * caller records source reads, decoding, canvas surfaces, and rendered frames;
 * subscribers receive throttled immutable snapshots suitable for a diagnostics
 * panel. Browser-only observers are optional and feature-detected.
 */

export type DiagnosticsOperationKind = "source-read" | "decode";

export type HeapMemorySample = {
  usedBytes: number;
  allocatedBytes?: number | null;
  limitBytes?: number | null;
};

export type DiagnosticsPerformanceEntry = {
  entryType: string;
  startTime: number;
  duration: number;
  name?: string;
  detail?: unknown;
  kind?: unknown;
};

export type DiagnosticsEntryObserver = (
  entryType: "longtask" | "gc",
  onEntries: (entries: readonly DiagnosticsPerformanceEntry[]) => void,
) => (() => void) | null;

export type PerformanceDiagnosticsOptions = {
  /** Monotonic milliseconds. Defaults to performance.now(), then Date.now(). */
  now?: () => number;
  /** Subscriber updates are coalesced to this interval. Defaults to 200 ms. */
  notificationIntervalMs?: number;
  /** Event-loop lag probe interval. Set to zero to disable. Defaults to 250 ms. */
  eventLoopSampleIntervalMs?: number;
  /** Rolling interval used for the FPS result. Defaults to 2 seconds. */
  frameWindowMs?: number;
  /** Rolling interval used for the live main-thread headline. Defaults to 10 seconds. */
  mainThreadWindowMs?: number;
  /** Expected animation rate used to estimate dropped frames. Defaults to 60. */
  targetFrameRate?: number;
  /** Gaps beyond this value start a new frame sequence. Defaults to 1 second. */
  frameGapResetMs?: number;
  /** Starts browser observers immediately. Defaults to true only in a window. */
  autoStart?: boolean;
  /** Test/host override for the non-standard performance.memory API. */
  readHeapMemory?: () => HeapMemorySample | null;
  /** Test/host override for PerformanceObserver. */
  observeEntries?: DiagnosticsEntryObserver;
};

export type OperationProgressUpdate = {
  /** Absolute progress. Values lower than prior progress are ignored. */
  completedBytes?: number;
  totalBytes?: number | null;
  phase?: string;
  /** Known temporary allocations not retained by a cache. */
  transientAllocatedBytes?: number;
  /** Exact measured work time when read and decode overlap in one worker. */
  durationMs?: number;
};

export type DiagnosticsOperationHandle = {
  readonly id: string;
  readonly kind: DiagnosticsOperationKind;
  /** Adds completed/read bytes to this operation. */
  advance(bytes: number, phase?: string): void;
  /** Updates absolute progress, phase, or an expected total. */
  update(update: OperationProgressUpdate): void;
  /** Completes the operation and returns its elapsed milliseconds. */
  finish(update?: OperationProgressUpdate): number;
  /** Records an unsuccessful operation and returns its elapsed milliseconds. */
  fail(update?: OperationProgressUpdate): number;
  /** Records a superseded operation and returns its elapsed milliseconds. */
  cancel(update?: OperationProgressUpdate): number;
};

export type RenderSpan = {
  /** Completes the timed render and returns its duration in milliseconds. */
  finish(): number;
};

export type ActiveDiagnosticsOperation = {
  id: string;
  kind: DiagnosticsOperationKind;
  label: string;
  phase: string;
  startedAtMs: number;
  elapsedMs: number;
  completedBytes: number;
  totalBytes: number | null;
  progress: number | null;
  throughputBytesPerSecond: number;
};

export type CanvasSurfaceSnapshot = {
  id: string;
  width: number;
  height: number;
  bytesPerPixel: number;
  gpuSurfaceCopies: number;
  backingBytes: number;
  estimatedGpuBytes: number;
};

export type PerformanceDiagnosticsSnapshot = {
  capturedAtMs: number;
  capabilities: {
    heapMemory: boolean;
    longTaskObserver: boolean;
    gcObserver: boolean;
    eventLoopProbe: boolean;
  };
  sourceReads: {
    bytes: number;
    operationsStarted: number;
    operationsCompleted: number;
    operationsFailed: number;
    operationsCancelled: number;
    activeOperations: number;
    durationMs: number;
    throughputBytesPerSecond: number;
  };
  decoding: {
    bytes: number;
    operationsStarted: number;
    operationsCompleted: number;
    operationsFailed: number;
    operationsCancelled: number;
    activeOperations: number;
    durationMs: number;
    throughputBytesPerSecond: number;
  };
  activeOperations: ActiveDiagnosticsOperation[];
  mainThread: {
    observationWindowMs: number;
    eventLoopSamples: number;
    eventLoopDelayMs: number;
    utilizationEstimate: number;
    longTaskCount: number;
    longTaskDurationMs: number;
    longestLongTaskMs: number;
  };
  allocations: {
    /** Caller-reported temporary typed-array/ArrayBuffer allocation volume. */
    reportedTransientBytes: number;
    /** Positive deltas observed from performance.memory; a lower-bound proxy. */
    observedHeapGrowthBytes: number;
    /** Negative deltas observed from performance.memory. */
    observedHeapReleaseBytes: number;
    samples: number;
    currentHeapUsedBytes: number | null;
    currentHeapAllocatedBytes: number | null;
    heapLimitBytes: number | null;
    peakHeapUsedBytes: number | null;
  };
  garbageCollection: {
    supported: boolean;
    count: number;
    durationMs: number;
    longestDurationMs: number;
    byKind: Record<string, number>;
  };
  canvases: {
    count: number;
    backingBytes: number;
    estimatedGpuBytes: number;
    surfaces: CanvasSurfaceSnapshot[];
  };
  rendering: {
    renders: number;
    totalDurationMs: number;
    averageDurationMs: number;
    lastDurationMs: number;
    longestDurationMs: number;
    rollingFps: number;
    rollingFrameSamples: number;
    rollingDroppedFrames: number;
    totalDroppedFrames: number;
  };
};

type OperationState = {
  id: string;
  kind: DiagnosticsOperationKind;
  label: string;
  phase: string;
  startedAtMs: number;
  completedBytes: number;
  totalBytes: number | null;
};

type OperationTotals = {
  bytes: number;
  started: number;
  completed: number;
  failed: number;
  cancelled: number;
  finishedDurationMs: number;
};

type CanvasSurfaceState = Omit<CanvasSurfaceSnapshot, "backingBytes" | "estimatedGpuBytes">;
type FrameSample = { atMs: number; droppedBefore: number };
type TimedWorkSample = { atMs: number; durationMs: number };
type TimeoutHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;

const EMPTY_TOTALS = (): OperationTotals => ({
  bytes: 0,
  started: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  finishedDurationMs: 0,
});

function finiteNonNegative(value: number, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function finitePositive(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function defaultNow() {
  return typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : Date.now();
}

type PerformanceWithMemory = Performance & {
  memory?: {
    usedJSHeapSize?: number;
    totalJSHeapSize?: number;
    jsHeapSizeLimit?: number;
  };
};

function defaultReadHeapMemory(): HeapMemorySample | null {
  if (typeof globalThis.performance === "undefined") return null;
  const memory = (globalThis.performance as PerformanceWithMemory).memory;
  if (!memory || !Number.isFinite(memory.usedJSHeapSize)) return null;
  return {
    usedBytes: finiteNonNegative(memory.usedJSHeapSize ?? 0),
    allocatedBytes: Number.isFinite(memory.totalJSHeapSize) ? memory.totalJSHeapSize ?? null : null,
    limitBytes: Number.isFinite(memory.jsHeapSizeLimit) ? memory.jsHeapSizeLimit ?? null : null,
  };
}

function defaultObserveEntries(
  entryType: "longtask" | "gc",
  onEntries: (entries: readonly DiagnosticsPerformanceEntry[]) => void,
): (() => void) | null {
  if (typeof globalThis.PerformanceObserver !== "function") return null;
  const supported = globalThis.PerformanceObserver.supportedEntryTypes;
  if (Array.isArray(supported) && supported.length > 0 && !supported.includes(entryType)) return null;
  let observer: PerformanceObserver;
  try {
    observer = new PerformanceObserver((list) => {
      const entries = list.getEntries().map((entry): DiagnosticsPerformanceEntry => {
        const extended = entry as PerformanceEntry & { detail?: unknown; kind?: unknown };
        return {
          entryType: entry.entryType,
          startTime: entry.startTime,
          duration: entry.duration,
          name: entry.name,
          detail: extended.detail,
          kind: extended.kind,
        };
      });
      onEntries(entries);
    });
  } catch {
    return null;
  }
  try {
    observer.observe({ type: entryType, buffered: true });
  } catch {
    try {
      observer.observe({ entryTypes: [entryType] });
    } catch {
      observer.disconnect();
      return null;
    }
  }
  return () => observer.disconnect();
}

function gcKindLabel(entry: DiagnosticsPerformanceEntry) {
  const detailKind = entry.detail && typeof entry.detail === "object" && "kind" in entry.detail
    ? (entry.detail as { kind?: unknown }).kind
    : undefined;
  const value = detailKind ?? entry.kind;
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "unspecified";
}

export class PerformanceDiagnosticsCollector {
  private readonly now: () => number;
  private readonly notificationIntervalMs: number;
  private readonly eventLoopSampleIntervalMs: number;
  private readonly frameWindowMs: number;
  private readonly mainThreadWindowMs: number;
  private readonly targetFrameIntervalMs: number;
  private readonly frameGapResetMs: number;
  private readonly readHeapMemory: () => HeapMemorySample | null;
  private readonly observeEntries: DiagnosticsEntryObserver;
  private readonly subscribers = new Set<(snapshot: PerformanceDiagnosticsSnapshot) => void>();
  private readonly activeOperations = new Map<string, OperationState>();
  private readonly sourceTotals = EMPTY_TOTALS();
  private readonly decodeTotals = EMPTY_TOTALS();
  private readonly canvasSurfaces = new Map<string, CanvasSurfaceState>();
  private readonly gcByKind = new Map<string, number>();
  private readonly observerStops: Array<() => void> = [];
  private operationSequence = 0;
  private started = false;
  private disposed = false;
  private startedAtMs = 0;
  private lastNotificationAtMs = Number.NEGATIVE_INFINITY;
  private notificationTimer: TimeoutHandle | null = null;
  private eventLoopTimer: IntervalHandle | null = null;
  private lastEventLoopProbeAtMs = 0;
  private eventLoopSamples = 0;
  private eventLoopDelayMs = 0;
  private longTaskCount = 0;
  private longTaskDurationMs = 0;
  private longestLongTaskMs = 0;
  private reportedTransientBytes = 0;
  private heapSamples = 0;
  private lastHeapUsedBytes: number | null = null;
  private currentHeapUsedBytes: number | null = null;
  private currentHeapAllocatedBytes: number | null = null;
  private heapLimitBytes: number | null = null;
  private peakHeapUsedBytes: number | null = null;
  private observedHeapGrowthBytes = 0;
  private observedHeapReleaseBytes = 0;
  private gcCount = 0;
  private gcDurationMs = 0;
  private longestGcDurationMs = 0;
  private longTaskObserverSupported = false;
  private gcObserverSupported = false;
  private heapMemorySupported = false;
  private renderCount = 0;
  private renderDurationMs = 0;
  private lastRenderDurationMs = 0;
  private longestRenderDurationMs = 0;
  private frameSamples: FrameSample[] = [];
  private lastFrameAtMs: number | null = null;
  private totalDroppedFrames = 0;
  private eventLoopDelaySamples: TimedWorkSample[] = [];
  private longTaskSamples: TimedWorkSample[] = [];

  constructor(options: PerformanceDiagnosticsOptions = {}) {
    this.now = options.now ?? defaultNow;
    this.notificationIntervalMs = finiteNonNegative(options.notificationIntervalMs ?? 200);
    this.eventLoopSampleIntervalMs = finiteNonNegative(options.eventLoopSampleIntervalMs ?? 250);
    this.frameWindowMs = finitePositive(options.frameWindowMs ?? 2_000, 2_000);
    this.mainThreadWindowMs = finitePositive(options.mainThreadWindowMs ?? 10_000, 10_000);
    const targetFrameRate = finitePositive(options.targetFrameRate ?? 60, 60);
    this.targetFrameIntervalMs = 1_000 / targetFrameRate;
    this.frameGapResetMs = finitePositive(options.frameGapResetMs ?? 1_000, 1_000);
    this.readHeapMemory = options.readHeapMemory ?? defaultReadHeapMemory;
    this.observeEntries = options.observeEntries ?? defaultObserveEntries;
    if (options.autoStart ?? typeof window !== "undefined") this.start();
  }

  /** Starts observers and the low-frequency event-loop probe. Safe to call twice. */
  start() {
    if (this.started || this.disposed) return;
    this.started = true;
    this.startedAtMs = this.now();
    this.lastEventLoopProbeAtMs = this.startedAtMs;
    this.sampleHeapMemory();

    let stopLongTasks: (() => void) | null = null;
    try {
      stopLongTasks = this.observeEntries("longtask", (entries) => {
        for (const entry of entries) this.recordLongTask(entry.duration);
      });
    } catch {
      // Optional diagnostics must never prevent the workspace from opening.
    }
    if (stopLongTasks) {
      this.longTaskObserverSupported = true;
      this.observerStops.push(stopLongTasks);
    }

    let stopGc: (() => void) | null = null;
    try {
      stopGc = this.observeEntries("gc", (entries) => {
        for (const entry of entries) this.recordGarbageCollection(entry.duration, gcKindLabel(entry));
      });
    } catch {
      // Chrome, Firefox, and Safari expose different observer entry sets.
    }
    if (stopGc) {
      this.gcObserverSupported = true;
      this.observerStops.push(stopGc);
    }

    if (this.eventLoopSampleIntervalMs > 0 && typeof globalThis.setInterval === "function") {
      this.eventLoopTimer = globalThis.setInterval(
        () => this.sampleEventLoopDelay(),
        this.eventLoopSampleIntervalMs,
      );
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.notificationTimer !== null) globalThis.clearTimeout(this.notificationTimer);
    if (this.eventLoopTimer !== null) globalThis.clearInterval(this.eventLoopTimer);
    this.notificationTimer = null;
    this.eventLoopTimer = null;
    for (const stop of this.observerStops.splice(0)) stop();
    this.subscribers.clear();
  }

  subscribe(listener: (snapshot: PerformanceDiagnosticsSnapshot) => void) {
    this.subscribers.add(listener);
    listener(this.snapshot());
    return () => this.subscribers.delete(listener);
  }

  snapshot(): PerformanceDiagnosticsSnapshot {
    const capturedAtMs = this.now();
    this.trimFrameSamples(capturedAtMs);
    const active = [...this.activeOperations.values()].map((operation) => this.activeOperationSnapshot(operation, capturedAtMs));
    const sourceActive = active.filter((operation) => operation.kind === "source-read");
    const decodeActive = active.filter((operation) => operation.kind === "decode");
    const sourceDurationMs = this.sourceTotals.finishedDurationMs
      + sourceActive.reduce((sum, operation) => sum + operation.elapsedMs, 0);
    const decodeDurationMs = this.decodeTotals.finishedDurationMs
      + decodeActive.reduce((sum, operation) => sum + operation.elapsedMs, 0);
    const observationWindowMs = this.started ? Math.max(0, capturedAtMs - this.startedAtMs) : 0;
    this.trimMainThreadSamples(capturedAtMs);
    const rollingEventLoopDelayMs = this.eventLoopDelaySamples.reduce((sum, sample) => sum + sample.durationMs, 0);
    const rollingLongTaskDurationMs = this.longTaskSamples.reduce((sum, sample) => sum + sample.durationMs, 0);
    const rollingObservationWindowMs = Math.min(this.mainThreadWindowMs, observationWindowMs);
    const mainThreadBusyEstimate = Math.max(rollingEventLoopDelayMs, rollingLongTaskDurationMs);
    const surfaces = [...this.canvasSurfaces.values()].map((surface): CanvasSurfaceSnapshot => {
      const backingBytes = surface.width * surface.height * surface.bytesPerPixel;
      return {
        ...surface,
        backingBytes,
        estimatedGpuBytes: backingBytes * surface.gpuSurfaceCopies,
      };
    });
    const firstFrame = this.frameSamples[0]?.atMs;
    const lastFrame = this.frameSamples.at(-1)?.atMs;
    const rollingFps = firstFrame !== undefined && lastFrame !== undefined && lastFrame > firstFrame
      ? ((this.frameSamples.length - 1) * 1_000) / (lastFrame - firstFrame)
      : 0;

    return {
      capturedAtMs,
      capabilities: {
        heapMemory: this.heapMemorySupported,
        longTaskObserver: this.longTaskObserverSupported,
        gcObserver: this.gcObserverSupported,
        eventLoopProbe: this.eventLoopTimer !== null,
      },
      sourceReads: this.operationTotalsSnapshot(this.sourceTotals, sourceActive.length, sourceDurationMs),
      decoding: this.operationTotalsSnapshot(this.decodeTotals, decodeActive.length, decodeDurationMs),
      activeOperations: active,
      mainThread: {
        observationWindowMs,
        eventLoopSamples: this.eventLoopSamples,
        eventLoopDelayMs: this.eventLoopDelayMs,
        utilizationEstimate: rollingObservationWindowMs > 0 ? clamp01(mainThreadBusyEstimate / rollingObservationWindowMs) : 0,
        longTaskCount: this.longTaskCount,
        longTaskDurationMs: this.longTaskDurationMs,
        longestLongTaskMs: this.longestLongTaskMs,
      },
      allocations: {
        reportedTransientBytes: this.reportedTransientBytes,
        observedHeapGrowthBytes: this.observedHeapGrowthBytes,
        observedHeapReleaseBytes: this.observedHeapReleaseBytes,
        samples: this.heapSamples,
        currentHeapUsedBytes: this.currentHeapUsedBytes,
        currentHeapAllocatedBytes: this.currentHeapAllocatedBytes,
        heapLimitBytes: this.heapLimitBytes,
        peakHeapUsedBytes: this.peakHeapUsedBytes,
      },
      garbageCollection: {
        supported: this.gcObserverSupported,
        count: this.gcCount,
        durationMs: this.gcDurationMs,
        longestDurationMs: this.longestGcDurationMs,
        byKind: Object.fromEntries(this.gcByKind),
      },
      canvases: {
        count: surfaces.length,
        backingBytes: surfaces.reduce((sum, surface) => sum + surface.backingBytes, 0),
        estimatedGpuBytes: surfaces.reduce((sum, surface) => sum + surface.estimatedGpuBytes, 0),
        surfaces,
      },
      rendering: {
        renders: this.renderCount,
        totalDurationMs: this.renderDurationMs,
        averageDurationMs: this.renderCount ? this.renderDurationMs / this.renderCount : 0,
        lastDurationMs: this.lastRenderDurationMs,
        longestDurationMs: this.longestRenderDurationMs,
        rollingFps,
        rollingFrameSamples: this.frameSamples.length,
        rollingDroppedFrames: this.frameSamples.reduce((sum, frame) => sum + frame.droppedBefore, 0),
        totalDroppedFrames: this.totalDroppedFrames,
      },
    };
  }

  beginSourceRead(options: { label?: string; totalBytes?: number | null; phase?: string } = {}) {
    return this.beginOperation("source-read", options);
  }

  beginDecode(options: { label?: string; totalBytes?: number | null; phase?: string } = {}) {
    return this.beginOperation("decode", options);
  }

  async measureSourceRead<T>(
    options: { label?: string; totalBytes?: number | null; phase?: string },
    operation: (progress: DiagnosticsOperationHandle) => Promise<T>,
  ) {
    const progress = this.beginSourceRead(options);
    try {
      const result = await operation(progress);
      progress.finish();
      return result;
    } catch (error) {
      progress.fail();
      throw error;
    }
  }

  async measureDecode<T>(
    options: { label?: string; totalBytes?: number | null; phase?: string },
    operation: (progress: DiagnosticsOperationHandle) => Promise<T>,
  ) {
    const progress = this.beginDecode(options);
    try {
      const result = await operation(progress);
      progress.finish();
      return result;
    } catch (error) {
      progress.fail();
      throw error;
    }
  }

  recordSourceRead(bytes: number, durationMs: number) {
    this.recordCompletedOperation("source-read", bytes, durationMs);
  }

  recordDecode(bytes: number, durationMs: number) {
    this.recordCompletedOperation("decode", bytes, durationMs);
  }

  recordTransientAllocation(bytes: number) {
    this.reportedTransientBytes += finiteNonNegative(bytes);
    this.markDirty();
  }

  /** Samples performance.memory when available, or accepts an injected sample. */
  sampleHeapMemory(sample: HeapMemorySample | null = this.readHeapMemory()) {
    if (!sample || !Number.isFinite(sample.usedBytes) || sample.usedBytes < 0) return null;
    this.heapMemorySupported = true;
    const usedBytes = sample.usedBytes;
    if (this.lastHeapUsedBytes !== null) {
      const delta = usedBytes - this.lastHeapUsedBytes;
      if (delta > 0) this.observedHeapGrowthBytes += delta;
      else this.observedHeapReleaseBytes += -delta;
    }
    this.lastHeapUsedBytes = usedBytes;
    this.currentHeapUsedBytes = usedBytes;
    this.currentHeapAllocatedBytes = sample.allocatedBytes ?? null;
    this.heapLimitBytes = sample.limitBytes ?? null;
    this.peakHeapUsedBytes = Math.max(this.peakHeapUsedBytes ?? 0, usedBytes);
    this.heapSamples += 1;
    this.markDirty();
    return sample;
  }

  recordLongTask(durationMs: number) {
    const duration = finiteNonNegative(durationMs);
    if (!(duration > 0)) return;
    this.longTaskCount += 1;
    this.longTaskDurationMs += duration;
    this.longestLongTaskMs = Math.max(this.longestLongTaskMs, duration);
    const sampledAtMs = this.now();
    this.longTaskSamples.push({ atMs: sampledAtMs, durationMs: duration });
    this.trimMainThreadSamples(sampledAtMs);
    this.markDirty();
  }

  recordGarbageCollection(durationMs: number, kind = "unspecified") {
    const duration = finiteNonNegative(durationMs);
    if (!(duration > 0)) return;
    const normalizedKind = kind.trim() || "unspecified";
    this.gcCount += 1;
    this.gcDurationMs += duration;
    this.longestGcDurationMs = Math.max(this.longestGcDurationMs, duration);
    this.gcByKind.set(normalizedKind, (this.gcByKind.get(normalizedKind) ?? 0) + 1);
    this.markDirty();
  }

  /** Times a synchronous canvas render. Set frame=true for FPS/drop estimates. */
  beginRender(options: { frame?: boolean; frameTimestampMs?: number } = {}): RenderSpan {
    const startedAtMs = this.now();
    let finished = false;
    return {
      finish: () => {
        if (finished) return 0;
        finished = true;
        const durationMs = Math.max(0, this.now() - startedAtMs);
        this.recordRender(durationMs);
        if (options.frame) this.recordFrame(options.frameTimestampMs ?? startedAtMs);
        return durationMs;
      },
    };
  }

  recordRender(durationMs: number) {
    const duration = finiteNonNegative(durationMs);
    this.renderCount += 1;
    this.renderDurationMs += duration;
    this.lastRenderDurationMs = duration;
    this.longestRenderDurationMs = Math.max(this.longestRenderDurationMs, duration);
    this.markDirty();
  }

  /** Records one animation-presented frame; render timing is recorded separately. */
  recordFrame(timestampMs = this.now()) {
    if (!Number.isFinite(timestampMs)) return;
    let droppedBefore = 0;
    if (this.lastFrameAtMs !== null) {
      const gap = timestampMs - this.lastFrameAtMs;
      if (gap > 0 && gap <= this.frameGapResetMs) {
        // A quarter-frame tolerance avoids treating ordinary vsync jitter as a drop.
        droppedBefore = Math.max(0, Math.floor((gap + this.targetFrameIntervalMs * .25) / this.targetFrameIntervalMs) - 1);
      }
    }
    this.lastFrameAtMs = timestampMs;
    this.totalDroppedFrames += droppedBefore;
    this.frameSamples.push({ atMs: timestampMs, droppedBefore });
    this.trimFrameSamples(timestampMs);
    this.markDirty();
  }

  recordCanvasSurface(
    id: string,
    surface: { width: number; height: number },
    options: { bytesPerPixel?: number; gpuSurfaceCopies?: number } = {},
  ) {
    const normalizedId = id.trim();
    if (!normalizedId) throw new Error("Canvas diagnostics require a stable surface id.");
    const width = Math.max(0, Math.floor(finiteNonNegative(surface.width)));
    const height = Math.max(0, Math.floor(finiteNonNegative(surface.height)));
    const bytesPerPixel = finitePositive(options.bytesPerPixel ?? 4, 4);
    const gpuSurfaceCopies = finiteNonNegative(options.gpuSurfaceCopies ?? 1, 1);
    this.canvasSurfaces.set(normalizedId, { id: normalizedId, width, height, bytesPerPixel, gpuSurfaceCopies });
    this.markDirty();
  }

  removeCanvasSurface(id: string) {
    if (this.canvasSurfaces.delete(id)) this.markDirty();
  }

  private beginOperation(
    kind: DiagnosticsOperationKind,
    options: { label?: string; totalBytes?: number | null; phase?: string },
  ): DiagnosticsOperationHandle {
    const id = `${kind}-${++this.operationSequence}`;
    const totals = this.totalsFor(kind);
    const operation: OperationState = {
      id,
      kind,
      label: options.label?.trim() || (kind === "source-read" ? "Source read" : "Decode"),
      phase: options.phase?.trim() || "Active",
      startedAtMs: this.now(),
      completedBytes: 0,
      totalBytes: options.totalBytes === null || options.totalBytes === undefined
        ? null
        : finiteNonNegative(options.totalBytes),
    };
    totals.started += 1;
    this.activeOperations.set(id, operation);
    this.sampleHeapMemory();
    this.markDirty(true);
    let closed = false;

    const update = (next: OperationProgressUpdate = {}) => {
      if (closed) return;
      this.updateOperation(operation, next);
    };
    const close = (outcome: "completed" | "failed" | "cancelled", next: OperationProgressUpdate = {}) => {
      if (closed) return 0;
      update(next);
      closed = true;
      const elapsedMs = next.durationMs === undefined
        ? Math.max(0, this.now() - operation.startedAtMs)
        : finiteNonNegative(next.durationMs);
      totals.finishedDurationMs += elapsedMs;
      if (outcome === "completed") totals.completed += 1;
      else if (outcome === "failed") totals.failed += 1;
      else totals.cancelled += 1;
      this.activeOperations.delete(id);
      this.sampleHeapMemory();
      this.markDirty(true);
      return elapsedMs;
    };

    return {
      id,
      kind,
      advance: (bytes, phase) => update({ completedBytes: operation.completedBytes + finiteNonNegative(bytes), phase }),
      update,
      finish: (next) => close("completed", next),
      fail: (next) => close("failed", next),
      cancel: (next) => close("cancelled", next),
    };
  }

  private updateOperation(operation: OperationState, update: OperationProgressUpdate) {
    const totals = this.totalsFor(operation.kind);
    if (update.totalBytes === null) operation.totalBytes = null;
    else if (update.totalBytes !== undefined) operation.totalBytes = finiteNonNegative(update.totalBytes);
    if (update.completedBytes !== undefined) {
      const completedBytes = finiteNonNegative(update.completedBytes, operation.completedBytes);
      if (completedBytes > operation.completedBytes) {
        totals.bytes += completedBytes - operation.completedBytes;
        operation.completedBytes = completedBytes;
      }
    }
    if (update.phase?.trim()) operation.phase = update.phase.trim();
    if (update.transientAllocatedBytes !== undefined) {
      this.reportedTransientBytes += finiteNonNegative(update.transientAllocatedBytes);
    }
    this.markDirty();
  }

  private recordCompletedOperation(kind: DiagnosticsOperationKind, bytes: number, durationMs: number) {
    const totals = this.totalsFor(kind);
    totals.started += 1;
    totals.completed += 1;
    totals.bytes += finiteNonNegative(bytes);
    totals.finishedDurationMs += finiteNonNegative(durationMs);
    this.markDirty();
  }

  private totalsFor(kind: DiagnosticsOperationKind) {
    return kind === "source-read" ? this.sourceTotals : this.decodeTotals;
  }

  private activeOperationSnapshot(operation: OperationState, capturedAtMs: number): ActiveDiagnosticsOperation {
    const elapsedMs = Math.max(0, capturedAtMs - operation.startedAtMs);
    return {
      id: operation.id,
      kind: operation.kind,
      label: operation.label,
      phase: operation.phase,
      startedAtMs: operation.startedAtMs,
      elapsedMs,
      completedBytes: operation.completedBytes,
      totalBytes: operation.totalBytes,
      progress: operation.totalBytes !== null && operation.totalBytes > 0
        ? clamp01(operation.completedBytes / operation.totalBytes)
        : null,
      throughputBytesPerSecond: elapsedMs > 0 ? operation.completedBytes * 1_000 / elapsedMs : 0,
    };
  }

  private operationTotalsSnapshot(totals: OperationTotals, activeOperations: number, durationMs: number) {
    return {
      bytes: totals.bytes,
      operationsStarted: totals.started,
      operationsCompleted: totals.completed,
      operationsFailed: totals.failed,
      operationsCancelled: totals.cancelled,
      activeOperations,
      durationMs,
      throughputBytesPerSecond: durationMs > 0 ? totals.bytes * 1_000 / durationMs : 0,
    };
  }

  private sampleEventLoopDelay() {
    const sampledAtMs = this.now();
    const elapsedMs = Math.max(0, sampledAtMs - this.lastEventLoopProbeAtMs);
    this.lastEventLoopProbeAtMs = sampledAtMs;
    if (typeof document !== "undefined" && document.hidden) return;
    // Very large gaps are normally timer throttling or sleep, not useful UI load.
    if (elapsedMs > this.eventLoopSampleIntervalMs * 8) return;
    this.eventLoopSamples += 1;
    const delayMs = Math.max(0, elapsedMs - this.eventLoopSampleIntervalMs);
    this.eventLoopDelayMs += delayMs;
    if (delayMs > 0) this.eventLoopDelaySamples.push({ atMs: sampledAtMs, durationMs: delayMs });
    this.trimMainThreadSamples(sampledAtMs);
    if (this.eventLoopSamples % Math.max(1, Math.round(1_000 / this.eventLoopSampleIntervalMs)) === 0) {
      this.sampleHeapMemory();
    }
    this.markDirty();
  }

  private trimFrameSamples(nowMs: number) {
    const cutoff = nowMs - this.frameWindowMs;
    let firstRetained = 0;
    while (firstRetained < this.frameSamples.length && this.frameSamples[firstRetained].atMs < cutoff) {
      firstRetained += 1;
    }
    if (firstRetained > 0) this.frameSamples.splice(0, firstRetained);
    if (this.frameSamples.length > 600) this.frameSamples.splice(0, this.frameSamples.length - 600);
  }

  private trimMainThreadSamples(nowMs: number) {
    const cutoff = nowMs - this.mainThreadWindowMs;
    this.eventLoopDelaySamples = this.eventLoopDelaySamples.filter((sample) => sample.atMs >= cutoff);
    this.longTaskSamples = this.longTaskSamples.filter((sample) => sample.atMs >= cutoff);
  }

  private markDirty(immediate = false) {
    if (!this.subscribers.size || this.disposed) return;
    const nowMs = this.now();
    if (immediate || this.notificationIntervalMs === 0 || nowMs - this.lastNotificationAtMs >= this.notificationIntervalMs) {
      this.emitSnapshot();
      return;
    }
    if (this.notificationTimer !== null) return;
    const delayMs = Math.max(0, this.notificationIntervalMs - (nowMs - this.lastNotificationAtMs));
    this.notificationTimer = globalThis.setTimeout(() => {
      this.notificationTimer = null;
      this.emitSnapshot();
    }, delayMs);
  }

  private emitSnapshot() {
    if (!this.subscribers.size || this.disposed) return;
    this.lastNotificationAtMs = this.now();
    const snapshot = this.snapshot();
    for (const listener of this.subscribers) listener(snapshot);
  }
}

export function createPerformanceDiagnostics(options: PerformanceDiagnosticsOptions = {}) {
  return new PerformanceDiagnosticsCollector(options);
}
