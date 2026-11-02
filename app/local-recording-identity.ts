import { IncrementalSha256 } from "./source-integrity.ts";

type LocalFile = Pick<File, "name" | "size" | "lastModified" | "webkitRelativePath">;

/** Browser-local recovery identity. No recording bytes are read or verified. */
export function localRecordingIdentity(file: LocalFile, interpretation?: Record<string, unknown>, companion?: LocalFile) {
  const describe = (value: LocalFile) => [value.webkitRelativePath || value.name, value.size, value.lastModified];
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
      : value;
  const material = JSON.stringify(["neurotrace-local-recording-v1", describe(file), companion ? describe(companion) : null, canonical(interpretation ?? null)]);
  const hasher = new IncrementalSha256();
  hasher.update(new TextEncoder().encode(material));
  return `local-v1:${hasher.hexDigest()}`;
}

/** Legacy reference-only projects have metadata, but no new local identity. */
export function recordingReferenceMatches(reference: { name: string; byteLength: number; durationSec: number; channelCount: number; format: string } | null, actual: { name: string; byteLength?: number; durationSec: number; channelCount: number; format: string }) {
  return reference !== null && reference.name === actual.name
    && reference.byteLength === actual.byteLength && reference.channelCount === actual.channelCount
    && reference.format === actual.format && Math.abs(reference.durationSec - actual.durationSec) < 1e-6;
}
