/** Runs record-aligned EDF envelope and optional integrity work off the UI thread. */

import { executeEDFEnvelopeBuild } from "./edf-envelope-integrity.ts";
import { edfEnvelopeTransferList } from "./edf-envelope.ts";
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
  | { type: "complete"; requestId: number; result: EDFEnvelopeBuildResult }
  | { type: "error"; requestId: number; name: string; message: string };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<EDFEnvelopeWorkerRequest>) => void) | null;
  postMessage(message: EDFEnvelopeWorkerResponse, transfer?: Transferable[]): void;
};

workerScope.onmessage = (event) => {
  const { requestId, request } = event.data;
  void executeEDFEnvelopeBuild(request, {
    backend: "worker",
    onProgress: (progress) => {
      workerScope.postMessage({ type: "progress", requestId, progress });
    },
  }).then(
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
