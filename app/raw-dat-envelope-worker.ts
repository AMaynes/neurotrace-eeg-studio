/*
Purpose: Runs exact Raw DAT envelope construction away from the browser UI thread.
File Dependencies: app/eeg-core.ts, app/progressive-envelope.ts, app/raw-dat-envelope.ts,
  app/scan-hash-worker-client.ts.
*/


import {
  buildRawDatEnvelopeWindow,
  rawDatEnvelopeTransferList,
  type RawDatEnvelopeBuildRequest,
  type RawDatEnvelopeBuildResult,
  type RawDatEnvelopeProgress,
} from "./raw-dat-envelope.ts";
import type { EnvelopeWindowData } from "./eeg-core";
import { envelopeOverviewTransferList } from "./progressive-envelope.ts";
import { createScanHashPipeline } from "./scan-hash-worker-client.ts";

export type RawDatEnvelopeWorkerRequest = {
  type: "build";
  requestId: number;
  request: RawDatEnvelopeBuildRequest;
};

export type RawDatEnvelopeWorkerResponse =
  | { type: "progress"; requestId: number; progress: RawDatEnvelopeProgress }
  | { type: "overview"; requestId: number; window: EnvelopeWindowData }
  | { type: "complete"; requestId: number; result: RawDatEnvelopeBuildResult }
  | { type: "error"; requestId: number; name: string; message: string };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<RawDatEnvelopeWorkerRequest>) => void) | null;
  postMessage(message: RawDatEnvelopeWorkerResponse, transfer?: Transferable[]): void;
};

workerScope.onmessage = (event) => {
  const { requestId, request } = event.data;
  /** Builds the DAT overview and disposes the optional hash pipeline. */
  const build = async () => {
    // The child owns one ordered hash stream; this worker decodes the same
    // chunks concurrently. Terminating the parent also terminates its children.
    const hashPipeline = request.integrity?.sha256 ? await createScanHashPipeline(request.blob.size) : undefined;
    try {
      return await buildRawDatEnvelopeWindow(request, {
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
        rawDatEnvelopeTransferList(result),
      );
    },
    (error: unknown) => {
      workerScope.postMessage({
        type: "error",
        requestId,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : "Raw DAT envelope construction failed",
      });
    },
  );
};

export {};
