import { EDFSource, RawDatSource, type EnvelopeWindowData, type SignalSource } from "./eeg-core.ts";
import { buildEDFEnvelopeWindowOffThread } from "./edf-envelope-worker-client.ts";
import { buildRawDatEnvelopeWindowOffThread } from "./raw-dat-envelope-worker-client.ts";
import { recordingOverviewPlan } from "./recording-overview.ts";
import type { PerformanceDiagnosticsCollector } from "./performance-diagnostics.ts";

/** Optional navigation index. Never hashes the file or gates editing/export. */
export async function buildBackgroundRecordingOverview(source: SignalSource, signal: AbortSignal,
  publish: (window: EnvelopeWindowData, complete?: boolean) => void, performanceDiagnostics: PerformanceDiagnosticsCollector) {
  const plan = recordingOverviewPlan(source.meta);
  if (!plan || !source.getEnvelopeWindow) return;
  if (signal.aborted) throw signal.reason ?? new DOMException("Overview canceled", "AbortError");
  const options = { signal, fallbackToMainThread: false, onOverview: publish };
  const request = { startSec: 0, durationSec: source.meta.durationSec, bucketCount: plan.bucketCount,
    channelIndices: plan.channelIndices, overviewIntervalMs: 500 };
  const read = performanceDiagnostics.beginSourceRead({ label: "Full-session overview", totalBytes: source.meta.byteLength ?? null, phase: "Reading overview samples" });
  const decode = performanceDiagnostics.beginDecode({ label: "Full-session overview", totalBytes: source.meta.byteLength ?? null, phase: "Reducing samples" });
  let previousBytes = 0;
  const onProgress = (progress: { bytesRead: number; totalBytes: number }) => {
    read.update({ completedBytes: progress.bytesRead, totalBytes: progress.totalBytes,
      transientAllocatedBytes: Math.max(0, progress.bytesRead - previousBytes) });
    previousBytes = progress.bytesRead;
    decode.update({ completedBytes: progress.bytesRead, totalBytes: progress.totalBytes });
  };
  try {
    if (source instanceof EDFSource || source instanceof RawDatSource) {
      const result = source instanceof EDFSource
        ? await buildEDFEnvelopeWindowOffThread({ ...request, blob: source.sourceBlob, header: source.header }, { ...options, onProgress })
        : await buildRawDatEnvelopeWindowOffThread({ ...request, ...source.envelopeWorkerSource }, { ...options, onProgress });
      if (signal.aborted) throw signal.reason ?? new DOMException("Overview canceled", "AbortError");
      publish(result.window, true);
      read.finish({ completedBytes: result.metrics.bytesRead, totalBytes: result.metrics.totalBytes, durationMs: result.metrics.readMs });
      decode.finish({ completedBytes: result.metrics.bytesRead, totalBytes: result.metrics.totalBytes, durationMs: result.metrics.decodeMs });
    } else {
      const window = await source.getEnvelopeWindow(0, source.meta.durationSec, plan.bucketCount, plan.channelIndices,
        { signal, overviewIntervalMs: 500, onOverview: publish });
      if (signal.aborted) throw signal.reason ?? new DOMException("Overview canceled", "AbortError");
      publish(window, true);
      read.finish();
      decode.finish();
    }
  } catch (error) {
    const finish = signal.aborted ? "cancel" : "fail";
    read[finish]();
    decode[finish]();
    throw error;
  }
}
