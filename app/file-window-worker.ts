/** Runs exact EDF and Raw DAT sample-window decoding away from the UI thread. */

import {
  buildFileWindow,
  fileWindowTransferList,
  type FileWindowBuildRequest,
  type FileWindowBuildResult,
  type FileWindowProgress,
} from "./file-window.ts";

export type FileWindowWorkerRequest = {
  type: "build";
  requestId: number;
  request: FileWindowBuildRequest;
};

export type FileWindowWorkerResponse =
  | { type: "progress"; requestId: number; progress: FileWindowProgress }
  | { type: "complete"; requestId: number; result: FileWindowBuildResult }
  | {
    type: "error";
    requestId: number;
    name: string;
    message: string;
    code?: string;
  };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<FileWindowWorkerRequest>) => void) | null;
  postMessage(message: FileWindowWorkerResponse, transfer?: Transferable[]): void;
};

workerScope.onmessage = (event) => {
  const { requestId, request } = event.data;
  void buildFileWindow(request, {
    backend: "worker",
    onProgress: (progress) => {
      workerScope.postMessage({ type: "progress", requestId, progress });
    },
  }).then(
    (result) => {
      workerScope.postMessage(
        { type: "complete", requestId, result },
        fileWindowTransferList(result),
      );
    },
    (error: unknown) => {
      workerScope.postMessage({
        type: "error",
        requestId,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : "Signal window decoding failed",
        code: error instanceof Error && "code" in error
          ? String((error as Error & { code?: unknown }).code)
          : undefined,
      });
    },
  );
};

export {};
