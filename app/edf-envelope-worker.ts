/*
Purpose: Runs record-aligned EDF envelope and optional integrity work off the UI thread.
File Dependencies: app/edf-envelope-integrity.ts, app/edf-envelope.ts, app/eeg-core.ts,
  app/progressive-envelope.ts, app/scan-hash-worker-client.ts.
*/


import { executeEDFEnvelopeBuild } from "./edf-envelope-integrity.ts";
import { edfEnvelopeTransferList } from "./edf-envelope.ts";
import type { EnvelopeWindowData } from "./eeg-core";
import { envelopeOverviewTransferList } from "./progressive-envelope.ts";
import { createScanHashPipeline } from "./scan-hash-worker-client.ts";
import type {
  EDFEnvelopeBuildRequest,
  EDFEnvelopeBuildResult,
  EDFEnvelopeProgress,
} from "./edf-envelope";

export type EDFEnvelopeWorkerRequest = {
  type: "build";
  requestId: number;
  request: EDFEnvelopeBuildRequest;
};

export type EDFEnvelopeWorkerResponse =
  | { type: "progress"; requestId: number; progress: EDFEnvelopeProgress }
  | { type: "overview"; requestId: number; window: EnvelopeWindowData }
  | { type: "complete"; requestId: number; result: EDFEnvelopeBuildResult }
  | { type: "error"; requestId: number; name: string; message: string };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<EDFEnvelopeWorkerRequest>) => void) | null;
  postMessage(message: EDFEnvelopeWorkerResponse, transfer?: Transferable[]): void;
};

workerScope.onmessage = (event) => {
  const { requestId, request } = event.data;
  /** Builds the EDF overview and disposes the optional hash pipeline. */
  const build = async () => {
    const hashPipeline = request.integrity?.sha256 ? await createScanHashPipeline(request.blob.size) : undefined;
    try {
      return await executeEDFEnvelopeBuild(request, {
        backend: "worker",
        hashPipeline,
        /** Handles the progress. */
        onProgress: (progress) => {
          workerScope.postMessage({ type: "progress", requestId, progress });
        },
        /** Handles the overview. */
        onOverview: (window) => {
          workerScope.postMessage(
            { type: "overview", requestId, window },
            envelopeOverviewTransferList(window),
          );
        },
      });
    } finally { hashPipeline?.dispose(); }
  };
  void build().then(
    (result) => {
      workerScope.postMessage(
        { type: "complete", requestId, result },
        edfEnvelopeTransferList(result),
      );
    },
    (error: unknown) => {
      workerScope.postMessage({
        type: "error",
        requestId,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : "EDF envelope construction failed",
      });
    },
  );
};

export {};
