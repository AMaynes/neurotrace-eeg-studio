/*
Purpose: Persistent browser worker client for file-backed MATLAB v7.3 signal reads.
File Dependencies: app/mat73-worker.ts, app/mat73.ts.
*/


import type {
  Mat73EnvelopeResult,
  Mat73OpenResult,
  Mat73WindowResult,
  Mat73WorkerRequest,
  Mat73WorkerResponse,
} from "./mat73";

type WorkerResult = Mat73OpenResult | Mat73WindowResult | Mat73EnvelopeResult | undefined;
type WithoutRequestId<T> = T extends { requestId: number } ? Omit<T, "requestId"> : never;
type ClientRequest = WithoutRequestId<Mat73WorkerRequest>;

interface PendingRequest {
  resolve: (result: WorkerResult) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  onOverview?: (result: Mat73EnvelopeResult) => void;
}

let nextRequestId = 1;

/** Allocates a request identifier and wraps before the safe-integer limit. */
function requestId() {
  const value = nextRequestId;
  nextRequestId = nextRequestId >= Number.MAX_SAFE_INTEGER ? 1 : nextRequestId + 1;
  return value;
}

/** Returns the supplied cancellation reason or the operation-specific AbortError. */
function abortReason(signal: AbortSignal | undefined) {
  if (signal?.reason !== undefined) return signal.reason;
  return new DOMException("MATLAB v7.3 signal read canceled", "AbortError");
}

/** Recreates the worker error with its original name and code. */
function responseError(response: Extract<Mat73WorkerResponse, { type: "error" }>) {
  const error = new Error(response.message) as Error & { code?: string };
  error.name = response.name;
  error.code = response.code;
  return error;
}

export class Mat73WorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private failedError: Error | null = null;

  /** Initializes the instance from the supplied arguments. */
  private constructor(worker: Worker) {
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<Mat73WorkerResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.requestId);
      if (!pending) return;
      if (response.type === "overview") {
        try {
          pending.onOverview?.(response.result);
        } catch {
          // An optional display preview must not invalidate the final read.
        }
        return;
      }
      this.finishRequest(response.requestId);
      if (response.type === "error") {
        pending.reject(responseError(response));
      } else if (response.type === "closed") {
        pending.resolve(undefined);
      } else {
        pending.resolve(response.result);
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.failAll(new Error(event.message || "MATLAB v7.3 worker failed to load."));
    };
    worker.onmessageerror = () => {
      this.failAll(new Error("MATLAB v7.3 worker could not deserialize a file read."));
    };
  }

  /** Constructs the source using the supplied metadata. */
  static async create(file: File): Promise<{ client: Mat73WorkerClient; metadata: Mat73OpenResult }> {
    if (typeof Worker === "undefined") {
      throw new Error("This browser does not provide workers required for large MATLAB v7.3 files.");
    }
    const client = new Mat73WorkerClient(
      new Worker(new URL("./mat73-worker.ts", import.meta.url), { type: "module" }),
    );
    try {
      const metadata = await client.send<Mat73OpenResult>({ type: "open", file });
      return { client, metadata };
    } catch (error) {
      client.worker.terminate();
      throw error;
    }
  }

  /** Reads the window. */
  readWindow(
    firstSample: number,
    endSample: number,
    channelIndices: number[],
    signal?: AbortSignal,
  ) {
    return this.send<Mat73WindowResult>({
      type: "window",
      firstSample,
      endSample,
      channelIndices,
    }, signal);
  }

  /** Reads the envelope. */
  readEnvelope(
    request: Omit<Extract<Mat73WorkerRequest, { type: "envelope" }>, "type" | "requestId">,
    signal?: AbortSignal,
    onOverview?: (result: Mat73EnvelopeResult) => void,
  ) {
    return this.send<Mat73EnvelopeResult>({ type: "envelope", ...request }, signal, onOverview);
  }

  /** Closes the owned resource. */
  close() {
    if (this.failedError) return;
    // No caller may remain waiting for a task whose worker is being closed.
    for (const [id, pending] of this.pending) {
      this.finishRequest(id);
      pending.reject(new DOMException("MATLAB v7.3 source closed", "AbortError"));
    }
    const closing = this.send<undefined>({ type: "close" });
    this.failedError = new Error("MATLAB v7.3 source is closed.");
    void closing.then(() => this.worker.terminate(), () => this.worker.terminate());
  }

  /** Dispatches a cancellable HDF5 request and tracks its pending response. */
  private send<T extends WorkerResult>(
    request: ClientRequest,
    signal?: AbortSignal,
    onOverview?: (result: Mat73EnvelopeResult) => void,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.failedError) return Promise.reject(this.failedError);
    const id = requestId();
    return new Promise<T>((resolve, reject) => {
      const onAbort = signal
        ? () => {
          this.finishRequest(id);
          try {
            this.worker.postMessage({ type: "cancel", requestId: id } satisfies Mat73WorkerRequest);
          } catch {
            // A failed/terminated worker has no remaining work to cancel.
          }
          reject(abortReason(signal));
        }
        : undefined;
      this.pending.set(id, {
        /** Resolves the request with its typed worker result. */
        resolve: (result) => resolve(result as T),
        reject,
        signal,
        onAbort,
        onOverview,
      });
      signal?.addEventListener("abort", onAbort!, { once: true });
      try {
        this.worker.postMessage({ ...request, requestId: id } as Mat73WorkerRequest);
      } catch (error) {
        this.finishRequest(id);
        reject(error);
      }
    });
  }

  /** Finishes the request. */
  private finishRequest(id: number) {
    const pending = this.pending.get(id);
    pending?.signal?.removeEventListener("abort", pending.onAbort!);
    this.pending.delete(id);
  }

  /** Reports failure for the all. */
  private failAll(error: Error) {
    this.failedError = error;
    for (const [id, pending] of this.pending) {
      this.finishRequest(id);
      pending.reject(error);
    }
    this.worker.terminate();
  }
}
