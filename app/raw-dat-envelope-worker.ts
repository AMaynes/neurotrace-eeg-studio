/** Runs exact Raw DAT envelope construction away from the browser UI thread. */

import {
  buildRawDatEnvelopeWindow,
  rawDatEnvelopeTransferList,
  type RawDatEnvelopeBuildRequest,
  type RawDatEnvelopeBuildResult,
  type RawDatEnvelopeProgress,
} from "./raw-dat-envelope.ts";
import type { EnvelopeWindowData } from "./eeg-core";
import { envelopeOverviewTransferList } from "./progressive-envelope.ts";

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
  void buildRawDatEnvelopeWindow(request, {
    backend: "worker",
    onProgress: (progress) => {
      workerScope.postMessage({ type: "progress", requestId, progress });
    },
    onOverview: (window) => {
      workerScope.postMessage(
        { type: "overview", requestId, window },
        envelopeOverviewTransferList(window),
      );
    },
  }).then(
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
