/**
 * Overlaps ordered SHA-256 with overview decoding without rereading the source.
 * One copied chunk can be in flight; the producer retains its decoding buffer.
 * The owning scan worker must dispose this child on completion or failure.
 */

export interface ScanHashPipeline {
  readonly workMs: number;
  /** Wait for the previous chunk, then enqueue this chunk and return before it is hashed. */
  write(bytes: Uint8Array): Promise<void>;
  hexDigest(): Promise<string>;
  dispose(): void;
}

type HashResponse = { id: number; workMs: number; hash?: string; error?: string };
type PendingHash = { id: number; resolve: (response: HashResponse) => void; reject: (error: Error) => void };

export function parallelScanHashEnabled(byteLength: number, cores = globalThis.navigator?.hardwareConcurrency ?? 4) {
  return byteLength >= 32 * 1024 * 1024 && Number.isFinite(cores) && cores >= 4;
}

class WorkerHashPipeline implements ScanHashPipeline {
  workMs = 0;
  private nextId = 0;
  private pending: PendingHash | undefined;
  private previous: Promise<HashResponse> | undefined;
  private failure: Error | undefined;
  private readonly worker: Worker;

  constructor(worker: Worker) {
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<HashResponse>) => {
      const response = event.data;
      const pending = this.pending;
      if (!pending || response.id !== pending.id) return;
      this.pending = undefined;
      this.workMs = response.workMs;
      if (response.error) {
        this.failure = new Error(response.error);
        pending.reject(this.failure);
      } else pending.resolve(response);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.fail(new Error(event.message || "Parallel source hashing failed."));
    };
    worker.onmessageerror = () => this.fail(new Error("Parallel source hashing returned an unreadable result."));
  }

  async ready() { await this.send("ready"); }

  async write(bytes: Uint8Array) {
    await this.previous;
    if (this.failure) throw this.failure;
    // Transfer a copy so the scan can decode its original bytes concurrently.
    const buffer = bytes.slice().buffer;
    this.previous = this.send("update", buffer);
  }

  async hexDigest() {
    await this.previous;
    if (this.failure) throw this.failure;
    const result = await this.send("digest");
    if (!result.hash) throw new Error("Parallel source hashing completed without a digest.");
    return result.hash;
  }

  dispose() {
    this.worker.terminate();
    this.fail(new Error("Parallel source hashing stopped."));
  }

  private fail(error: Error) {
    this.failure = error;
    this.pending?.reject(error);
    this.pending = undefined;
  }

  private send(type: "ready" | "update" | "digest", buffer?: ArrayBuffer) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    const result = new Promise<HashResponse>((resolve, reject) => {
      this.pending = { id, resolve, reject };
      try { this.worker.postMessage({ id, type, buffer }, buffer ? [buffer] : []); }
      catch (error) { this.fail(error instanceof Error ? error : new Error("Could not send source bytes to the hash worker.")); }
    });
    // A failure remains observable through write/digest, even when it arrives
    // while the producer is still decoding and has not awaited the next write.
    void result.catch(() => {});
    return result;
  }
}

/** Unsupported nested workers fall back before any source bytes are submitted. */
export async function createScanHashPipeline(byteLength: number): Promise<ScanHashPipeline | undefined> {
  if (!parallelScanHashEnabled(byteLength) || typeof Worker === "undefined") return undefined;
  let pipeline: WorkerHashPipeline | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    pipeline = new WorkerHashPipeline(new Worker(new URL("./scan-hash-worker.ts", import.meta.url), { type: "module" }));
    await Promise.race([
      pipeline.ready(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Parallel hash worker did not start.")), 5000); }),
    ]);
    return pipeline;
  } catch {
    pipeline?.dispose();
    return undefined;
  } finally { clearTimeout(timer); }
}
