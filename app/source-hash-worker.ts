/**
 * Full-file verification worker. For EDF+, one record-aligned pass computes
 * the exact SHA-256 and extracts TAL annotations without rereading the file.
 */

import { parseEdfTalText, type SourceEvent } from "./eeg-core";
import { IncrementalSha256, sha256Blob } from "./source-integrity";

type EdfAnnotationPlan = {
  headerBytes: number;
  dataRecordCount: number;
  bytesPerDataRecord: number;
  signals: Array<{ byteOffsetInRecord: number; byteLength: number }>;
};

type HashRequest = { blob: Blob; edfAnnotationPlan?: EdfAnnotationPlan };
type HashResponse =
  | { type: "progress"; bytesHashed: number; totalBytes: number }
  | { type: "complete"; hash: string; edfAnnotations?: { events: SourceEvent[]; warnings: string[] } }
  | { type: "error"; message: string };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<HashRequest>) => void) | null;
  postMessage(message: HashResponse): void;
};

function progressReporter(totalBytes: number) {
  let lastReportedBytes = 0;
  return (bytesHashed: number) => {
    if (bytesHashed < totalBytes && bytesHashed - lastReportedBytes < 32 * 1024 * 1024) return;
    lastReportedBytes = bytesHashed;
    workerScope.postMessage({ type: "progress", bytesHashed, totalBytes });
  };
}

async function verifyEdf(blob: Blob, plan: EdfAnnotationPlan) {
  const sha256 = new IncrementalSha256();
  const reportProgress = progressReporter(blob.size);
  const events: SourceEvent[] = [];
  const decoder = new TextDecoder("utf-8");
  const ordinaryChunkBytes = 4 * 1024 * 1024;
  let hashedBytes = 0;

  const hashSlice = async (start: number, end: number) => {
    const bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer());
    sha256.update(bytes);
    hashedBytes = end;
    reportProgress(hashedBytes);
    return bytes;
  };

  for (let offset = 0; offset < Math.min(plan.headerBytes, blob.size); offset += ordinaryChunkBytes) {
    await hashSlice(offset, Math.min(plan.headerBytes, offset + ordinaryChunkBytes, blob.size));
  }

  const recordsPerChunk = Math.max(1, Math.floor(ordinaryChunkBytes / Math.max(1, plan.bytesPerDataRecord)));
  for (let firstRecord = 0; firstRecord < plan.dataRecordCount; firstRecord += recordsPerChunk) {
    const recordCount = Math.min(recordsPerChunk, plan.dataRecordCount - firstRecord);
    const byteStart = plan.headerBytes + firstRecord * plan.bytesPerDataRecord;
    const byteEnd = Math.min(blob.size, byteStart + recordCount * plan.bytesPerDataRecord);
    const bytes = await hashSlice(byteStart, byteEnd);
    for (let localRecord = 0; localRecord < recordCount; localRecord += 1) {
      const recordOffset = localRecord * plan.bytesPerDataRecord;
      for (const signal of plan.signals) {
        const start = recordOffset + signal.byteOffsetInRecord;
        const end = Math.min(bytes.length, start + signal.byteLength);
        events.push(...parseEdfTalText(decoder.decode(bytes.subarray(start, end))));
      }
    }
  }

  const declaredDataEnd = Math.min(
    blob.size,
    plan.headerBytes + plan.dataRecordCount * plan.bytesPerDataRecord,
  );
  for (let offset = declaredDataEnd; offset < blob.size; offset += ordinaryChunkBytes) {
    await hashSlice(offset, Math.min(blob.size, offset + ordinaryChunkBytes));
  }
  if (hashedBytes < blob.size) await hashSlice(hashedBytes, blob.size);

  const deduplicated = new Map<string, SourceEvent>();
  for (const event of events) {
    const key = `${event.timeSec.toFixed(9)}\0${event.durationSec ?? ""}\0${event.label}`;
    if (!deduplicated.has(key)) deduplicated.set(key, event);
  }
  const sortedEvents = [...deduplicated.values()].sort((left, right) =>
    left.timeSec - right.timeSec || left.label.localeCompare(right.label));
  return {
    hash: sha256.hexDigest(),
    edfAnnotations: {
      events: sortedEvents,
      warnings: plan.signals.length && !sortedEvents.length
        ? ["EDF+ annotation channel contained no non-timekeeping text annotations."]
        : [],
    },
  };
}

workerScope.onmessage = (event) => {
  const { blob, edfAnnotationPlan } = event.data;
  const operation = edfAnnotationPlan
    ? verifyEdf(blob, edfAnnotationPlan)
    : sha256Blob(blob, { onProgress: progressReporter(blob.size) }).then((hash) => ({ hash }));
  void operation.then(
    (result) => workerScope.postMessage({ type: "complete", ...result }),
    (error: unknown) => workerScope.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Source hashing failed",
    }),
  );
};

export {};
