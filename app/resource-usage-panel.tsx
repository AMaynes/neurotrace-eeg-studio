/*
Purpose: Displays sampled browser resources and pipeline measurements without owning recording state.
File Dependencies: app/eeg-core.ts, app/performance-diagnostics.ts, app/recording-info.ts.
*/


"use client";

import { useEffect, useState } from "react";
import type { RecordingMeta } from "./eeg-core";
import type { PerformanceDiagnosticsCollector, PerformanceDiagnosticsSnapshot } from "./performance-diagnostics";
import { formatByteCount, formatByteRate, formatMetricDuration, estimatedDecodedSourceBytes } from "./recording-info";

export type ResourceCacheUsage = {
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

/** Bounds a resource usage ratio to zero through one hundred percent. */
function usagePercent(used: number | null, limit: number | null) {
  if (used === null || limit === null || !(limit > 0)) return 0;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

/** Displays sampled browser resources, signal cache usage, and measured pipeline activity. */
export function ResourceUsagePanel({
  meta,
  hasRecording,
  verifyingSource,
  loadingSignal,
  recoveryStatus,
  activeDisplayBytes,
  activeDisplayVisibleBytes,
  readCacheUsage,
  performanceDiagnostics,
  cacheBudgetBytes,
}: {
  meta: RecordingMeta;
  hasRecording: boolean;
  verifyingSource: boolean;
  loadingSignal: boolean;
  recoveryStatus: "saved" | "error";
  activeDisplayBytes: number;
  activeDisplayVisibleBytes: number;
  readCacheUsage: () => ResourceCacheUsage;
  performanceDiagnostics: PerformanceDiagnosticsCollector;
  cacheBudgetBytes: number;
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
  const [performanceUsage, setPerformanceUsage] = useState<PerformanceDiagnosticsSnapshot>(
    () => performanceDiagnostics.snapshot(),
  );

  useEffect(() => {
    const unsubscribe = performanceDiagnostics.subscribe(setPerformanceUsage);
    return () => { unsubscribe(); };
  }, [performanceDiagnostics]);

  useEffect(() => {
    let active = true;
    /** Samples cache, heap, and storage estimates while the panel remains mounted. */
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
      performanceDiagnostics.sampleHeapMemory(memory ? {
        usedBytes: memory.usedJSHeapSize,
        allocatedBytes: memory.totalJSHeapSize,
        limitBytes: memory.jsHeapSizeLimit,
      } : null);
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
  }, [readCacheUsage, performanceDiagnostics]);

  const signalCacheBytes = cacheUsage.rawBytes + cacheUsage.processedBytes + cacheUsage.envelopeBytes;
  const cacheEntries = cacheUsage.rawEntries + cacheUsage.processedEntries + cacheUsage.envelopeEntries;
  const decodedSourceBytes = hasRecording ? estimatedDecodedSourceBytes(meta) : 0;
  const activeOperation = performanceUsage.activeOperations[0] ?? null;
  const mainThreadPercent = performanceUsage.mainThread.utilizationEstimate * 100;
  const transientObservationBytes = Math.max(
    performanceUsage.allocations.reportedTransientBytes,
    performanceUsage.allocations.observedHeapGrowthBytes,
  );
  const processingStatus = activeOperation?.phase
    ?? (verifyingSource ? "Opening recording" : loadingSignal ? "Preparing signal window" : "Ready");

  // Keep primary measurements visible; hover exposes secondary counts and caveats.
  const metrics = [
    { label: "Main-thread pressure", value: `${mainThreadPercent.toFixed(1)}% · ${formatMetricDuration(performanceUsage.mainThread.eventLoopDelayMs)} delay`,
      detail: "Rolling 10 s event-loop estimate. Process CPU utilization is not exposed by browsers." },
    { label: "UI frame cadence", value: `${performanceUsage.rendering.rollingFrameSamples > 1 ? `${performanceUsage.rendering.rollingFps.toFixed(0)} fps` : "Sampling"} · ${performanceUsage.rendering.rollingDroppedFrames}/${performanceUsage.rendering.totalDroppedFrames} drops`,
      detail: `Dropped frames: ${performanceUsage.rendering.rollingDroppedFrames} recent, ${performanceUsage.rendering.totalDroppedFrames} total.` },
    { label: "Last canvas draw", value: `${formatMetricDuration(performanceUsage.rendering.lastDurationMs)} · avg ${formatMetricDuration(performanceUsage.rendering.averageDurationMs)}`,
      detail: `${performanceUsage.rendering.renders} renders; ${formatMetricDuration(performanceUsage.rendering.longestDurationMs)} longest draw.` },
    { label: "File reads", value: `${formatByteCount(performanceUsage.sourceReads.bytes)} · ${formatByteRate(performanceUsage.sourceReads.throughputBytesPerSecond)}`,
      detail: `Total source bytes read: ${formatByteCount(performanceUsage.sourceReads.bytes)} in ${formatMetricDuration(performanceUsage.sourceReads.durationMs)}. Measured at the browser file boundary; physical disk and operating-system cache reads cannot be distinguished.` },
    { label: "Read operations", value: `${performanceUsage.sourceReads.operationsCompleted} / ${performanceUsage.sourceReads.operationsCancelled} / ${performanceUsage.sourceReads.operationsFailed}`,
      detail: "Completed / canceled / failed source reads." },
    { label: "Decoding", value: `${formatMetricDuration(performanceUsage.decoding.durationMs)} · ${formatByteRate(performanceUsage.decoding.throughputBytesPerSecond)}`,
      detail: `${performanceUsage.decoding.activeOperations} active decode/reduction operations; ${performanceUsage.sourceReads.activeOperations} active source reads.` },
    { label: "Long tasks", value: `${performanceUsage.mainThread.longTaskCount} · max ${formatMetricDuration(performanceUsage.mainThread.longestLongTaskMs)}`,
      detail: `${formatMetricDuration(performanceUsage.mainThread.longTaskDurationMs)} total long-task duration.` },
    { label: "Canvas backing store", value: formatByteCount(performanceUsage.canvases.backingBytes),
      detail: `GPU/compositor surfaces: approximately ${formatByteCount(performanceUsage.canvases.estimatedGpuBytes)}. Conservative surface estimate; exact GPU allocation is not exposed.` },
    { label: "Temporary memory ≥", value: formatByteCount(transientObservationBytes),
      detail: `Transient buffers processed: ${formatByteCount(performanceUsage.allocations.reportedTransientBytes)}. Observed heap growth: ${formatByteCount(performanceUsage.allocations.observedHeapGrowthBytes)}; release: ${formatByteCount(performanceUsage.allocations.observedHeapReleaseBytes)}. A lower bound, not complete native allocation accounting.` },
    { label: "Browser JS heap", value: browserUsage.heapUsedBytes === null ? "Not exposed" : `${formatByteCount(browserUsage.heapUsedBytes)} / ${formatByteCount(browserUsage.heapLimitBytes)}`,
      detail: `Used / limit. Allocated heap: ${formatByteCount(browserUsage.heapAllocatedBytes)}; browser-managed.` },
    { label: "Garbage collection", value: performanceUsage.garbageCollection.supported ? `${performanceUsage.garbageCollection.count} · ${formatMetricDuration(performanceUsage.garbageCollection.durationMs)}` : "Timing not exposed",
      detail: "Count and duration when exposed by the browser; complete garbage-collector accounting is unavailable." },
    { label: "Signal cache / view", value: `${formatByteCount(signalCacheBytes)} / ${formatByteCount(activeDisplayBytes)}`,
      detail: `Signal cache: ${cacheEntries} windows, ${usagePercent(signalCacheBytes, cacheBudgetBytes).toFixed(0)}% of ceiling. Raw: ${formatByteCount(cacheUsage.rawBytes)} (${cacheUsage.rawEntries}); processed: ${formatByteCount(cacheUsage.processedBytes)} (${cacheUsage.processedEntries}); envelopes: ${formatByteCount(cacheUsage.envelopeBytes)} (${cacheUsage.envelopeEntries}). Active retained view: ${formatByteCount(activeDisplayBytes)}, ${formatByteCount(activeDisplayVisibleBytes)} visible; backing may be shared with cache.${decodedSourceBytes > 0 ? ` Decoded MAT estimate: ${formatByteCount(decodedSourceBytes)}.` : ""}` },
    { label: "Site storage", value: browserUsage.storageUsedBytes === null ? "Not exposed" : `${formatByteCount(browserUsage.storageUsedBytes)} / ${formatByteCount(browserUsage.storageQuotaBytes)}`,
      detail: "Used / browser storage quota. Estimates may not be available in every browser." },
    { label: "Recovery / loading", value: `${recoveryStatus === "saved" ? "Saved" : "Unavailable"} · ${processingStatus}`,
      detail: `Local recovery: ${recoveryStatus === "saved" ? "Saved" : "Unavailable"}. Processing: ${processingStatus}.` },
  ];

  return <section className="resource-panel resource-panel-compact" aria-label="Resource usage">
    <section className={`resource-operation-card${activeOperation ? " active" : ""}`}
      title={`${activeOperation?.label ?? "No read or decode operation running"}\n${activeOperation?.phase ?? "Cached interactions do not touch the source file."}\n${activeOperation ? `${formatByteCount(activeOperation.completedBytes)} / ${formatByteCount(activeOperation.totalBytes)} · ${formatByteRate(activeOperation.throughputBytesPerSecond)}` : `${formatByteCount(performanceUsage.sourceReads.bytes)} read this session`}`}>
      <header><span>{activeOperation?.label ?? "Data pipeline"}</span><strong>{activeOperation ? `${Math.round((activeOperation.progress ?? 0) * 100)}%` : "IDLE"}</strong></header>
      <p>{activeOperation?.phase ?? "No read or decode operation running"}</p>
      <div className="resource-meter"><i style={{ width: `${(activeOperation?.progress ?? 0) * 100}%` }} /></div>
    </section>
    <dl className="resource-metrics">{metrics.map(({ label, value, detail }) => <div key={label} title={`${label}: ${value}\n${detail}`}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </section>;
}
