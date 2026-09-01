/**
 * Optional integrity work that can share the EDF envelope builder's sequential
 * source pass. This avoids rereading a large recording for hashing, EDF+ TAL
 * extraction, and a full-session overview.
 */

import { parseEdfTalText, type SourceEvent } from "./eeg-core.ts";
import { IncrementalSha256 } from "./source-integrity.ts";
import {
  buildEDFEnvelopeWindow,
  type EDFEnvelopeBuildHooks,
  type EDFEnvelopeBuildRequest,
  type EDFEnvelopeBuildResult,
  type EDFEnvelopeIntegrityResult,
  type EDFEnvelopeProgress,
  type EDFEnvelopeSourceChunk,
} from "./edf-envelope.ts";

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function finalizeEvents(events: readonly SourceEvent[], annotationSignalCount: number) {
  const deduplicated = new Map<string, SourceEvent>();
  for (const event of events) {
    const key = `${event.timeSec.toFixed(9)}\0${event.durationSec ?? ""}\0${event.label}`;
    if (!deduplicated.has(key)) deduplicated.set(key, event);
  }
  const sorted = [...deduplicated.values()].sort((left, right) =>
    left.timeSec - right.timeSec || left.label.localeCompare(right.label));
  return {
    events: sorted,
    warnings: annotationSignalCount && !sorted.length
      ? ["EDF+ annotation channel contained no non-timekeeping text annotations."]
      : [],
  };
}

/**
 * Executes a display envelope request and, when requested, computes source
 * integrity from those same borrowed chunks. A full-file hash reads the prefix,
 * all declared records, and any trailing bytes exactly once and in byte order.
 */
export async function executeEDFEnvelopeBuild(
  request: EDFEnvelopeBuildRequest,
  hooks: Omit<EDFEnvelopeBuildHooks, "onSourceChunk" | "scanAllRecords" | "scanWholeBlob"> = {},
): Promise<EDFEnvelopeBuildResult> {
  const wantsHash = request.integrity?.sha256 === true;
  const wantsAnnotations = request.integrity?.edfAnnotations === true;
  if (!wantsHash && !wantsAnnotations) return buildEDFEnvelopeWindow(request, hooks);

  const sha256 = wantsHash ? new IncrementalSha256() : null;
  const annotationSignals = wantsAnnotations
    ? request.header.signals.filter((signal) => signal.isAnnotation)
    : [];
  const annotationEvents: SourceEvent[] = [];
  const decoder = new TextDecoder("utf-8");
  let pendingCompleteProgress: EDFEnvelopeProgress | undefined;
  const onSourceChunk = (chunk: EDFEnvelopeSourceChunk) => {
    if (sha256) sha256.update(chunk.bytes);
    if (chunk.section !== "records"
      || chunk.firstRecord === undefined
      || chunk.recordCount === undefined
      || !annotationSignals.length) return;
    for (let localRecord = 0; localRecord < chunk.recordCount; localRecord += 1) {
      const recordOffset = localRecord * request.header.bytesPerDataRecord;
      for (const signal of annotationSignals) {
        const start = recordOffset + signal.byteOffsetInRecord;
        const end = Math.min(chunk.bytes.length, start + signal.samplesPerRecord * 2);
        annotationEvents.push(...parseEdfTalText(decoder.decode(chunk.bytes.subarray(start, end))));
      }
    }
  };

  const result = await buildEDFEnvelopeWindow(request, {
    ...hooks,
    onProgress: (progress) => {
      if (progress.phase === "complete") pendingCompleteProgress = progress;
      else hooks.onProgress?.(progress);
    },
    onSourceChunk,
    scanAllRecords: wantsHash || wantsAnnotations,
    scanWholeBlob: wantsHash,
  });
  const finalizeStartedAt = nowMs();
  const integrity: EDFEnvelopeIntegrityResult = {};
  if (sha256) integrity.hash = sha256.hexDigest();
  if (wantsAnnotations) {
    integrity.edfAnnotations = finalizeEvents(annotationEvents, annotationSignals.length);
  }
  const finalizeMs = nowMs() - finalizeStartedAt;
  result.metrics.integrityMs += finalizeMs;
  result.metrics.elapsedMs += finalizeMs;
  if (pendingCompleteProgress) {
    hooks.onProgress?.({
      ...pendingCompleteProgress,
      elapsedMs: result.metrics.elapsedMs,
      integrityMs: result.metrics.integrityMs,
    });
  }
  return { ...result, integrity };
}
