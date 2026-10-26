/** One ordered SHA-256 stream owned by a recording scan; chunk hashes are never combined. */
import { IncrementalSha256 } from "./source-integrity.ts";

type HashRequest = { id: number; type: "ready" | "update" | "digest"; buffer?: ArrayBuffer };
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<HashRequest>) => void) | null;
  postMessage(message: { id: number; workMs: number; hash?: string; error?: string }): void;
};
const hasher = new IncrementalSha256();
let workMs = 0;
scope.onmessage = (event) => {
  const { id, type, buffer } = event.data;
  try {
    const started = performance.now();
    let hash: string | undefined;
    if (type === "update") {
      if (!buffer) throw new Error("Missing source hash chunk.");
      hasher.update(buffer);
    } else if (type === "digest") hash = hasher.hexDigest();
    workMs += performance.now() - started;
    scope.postMessage({ id, workMs, hash });
  } catch (error) {
    scope.postMessage({ id, workMs, error: error instanceof Error ? error.message : "Source hashing failed." });
  }
};

export {};
