/**
 * Browser client for off-main-thread source hashing. Node/test environments
 * retain the bounded-memory direct implementation as a compatible fallback.
 */

import {
  parseEDFAnnotations,
  type EDFHeader,
  type SourceEvent,
} from "./eeg-core";
import { sha256Blob, type Sha256BlobOptions } from "./source-integrity";

type HashWorkerResponse =
  | { type: "progress"; bytesHashed: number; totalBytes: number }
  | { type: "complete"; hash: string; edfAnnotations?: { events: SourceEvent[]; warnings: string[] } }
  | { type: "error"; message: string };

export type SourceVerificationResult = {
  hash: string;
  edfAnnotations?: { events: SourceEvent[]; warnings: string[] };
};

export type SourceVerificationOptions = Sha256BlobOptions & {
  edfHeader?: EDFHeader;
  fallbackToMainThread?: boolean;
};

async function verifySourceDirectly(
  blob: Blob,
  options: SourceVerificationOptions,
): Promise<SourceVerificationResult> {
  const hash = await sha256Blob(blob, options);
  const edfAnnotations = options.edfHeader && typeof File !== "undefined" && blob instanceof File
    ? await parseEDFAnnotations(blob, options.edfHeader, { signal: options.signal })
    : undefined;
  return { hash, edfAnnotations };
}

export async function verifySourceOffThread(
  blob: Blob,
  options: SourceVerificationOptions = {},
): Promise<SourceVerificationResult> {
  const allowFallback = options.fallbackToMainThread !== false;
  if (typeof Worker === "undefined") {
    if (allowFallback) return verifySourceDirectly(blob, options);
    throw new Error("This browser does not provide a module worker for source verification.");
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL("./source-hash-worker.ts", import.meta.url), { type: "module" });
  } catch (error) {
    if (allowFallback) return verifySourceDirectly(blob, options);
    throw error;
  }

  return new Promise<SourceVerificationResult>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      callback();
    };
    const onAbort = () => finish(() => {
      if (options.signal?.reason !== undefined) reject(options.signal.reason);
      else {
        const error = new Error("SHA-256 hashing was aborted");
        error.name = "AbortError";
        reject(error);
      }
    });
    const fallbackToDirect = (workerError?: unknown) => finish(() => {
      if (!allowFallback) {
        reject(workerError instanceof Error ? workerError : new Error("Source verification worker failed."));
        return;
      }
      if (options.signal?.aborted) {
        if (options.signal.reason !== undefined) reject(options.signal.reason);
        else {
          const error = new Error("SHA-256 hashing was aborted");
          error.name = "AbortError";
          reject(error);
        }
        return;
      }
      void verifySourceDirectly(blob, options).then(resolve, reject);
    });
    worker.onmessage = (event: MessageEvent<HashWorkerResponse>) => {
      const response = event.data;
      if (response.type === "progress") {
        options.onProgress?.(response.bytesHashed, response.totalBytes);
      } else if (response.type === "complete") {
        finish(() => resolve({ hash: response.hash, edfAnnotations: response.edfAnnotations }));
      } else {
        fallbackToDirect(new Error(response.message));
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fallbackToDirect(new Error(event.message || "Source verification worker failed."));
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const annotationSignals = options.edfHeader?.signals.filter((signal) => signal.isAnnotation) ?? [];
    const edfAnnotationPlan = options.edfHeader ? {
      headerBytes: options.edfHeader.headerBytes,
      dataRecordCount: options.edfHeader.dataRecordCount,
      bytesPerDataRecord: options.edfHeader.bytesPerDataRecord,
      signals: annotationSignals.map((signal) => ({
        byteOffsetInRecord: signal.byteOffsetInRecord,
        byteLength: signal.samplesPerRecord * 2,
      })),
    } : undefined;
    try {
      worker.postMessage({ blob, edfAnnotationPlan });
    } catch (error) {
      fallbackToDirect(error);
    }
  });
}

export async function sha256BlobOffThread(blob: Blob, options: Sha256BlobOptions = {}) {
  return (await verifySourceOffThread(blob, options)).hash;
}
