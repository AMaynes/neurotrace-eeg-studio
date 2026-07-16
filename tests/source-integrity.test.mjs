import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { IncrementalSha256, sha256Blob } from "../app/source-integrity.ts";

function trustedSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("hashes an empty Blob", async () => {
  const expected = trustedSha256(new Uint8Array());
  assert.equal(await sha256Blob(new Blob([])), expected);
});

test("hashes the SHA-256 'abc' reference message", async () => {
  const bytes = new TextEncoder().encode("abc");
  assert.equal(
    await sha256Blob(new Blob([bytes]), { chunkSizeBytes: 1 }),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("hashes a deterministic multi-block payload", async () => {
  const bytes = new Uint8Array(1024 * 1024 + 137);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * 131 + (index >>> 7) * 17) & 0xff;
  }

  assert.equal(
    await sha256Blob(new Blob([bytes]), { chunkSizeBytes: 4093 }),
    trustedSha256(bytes),
  );
});

test("is independent of Blob and update chunk boundaries", async () => {
  const bytes = new Uint8Array(64 * 7 + 19);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * 29 + 11) & 0xff;
  }
  const expected = trustedSha256(bytes);

  for (const chunkSizeBytes of [1, 7, 63, 64, 65, 127, bytes.length]) {
    assert.equal(
      await sha256Blob(new Blob([bytes]), { chunkSizeBytes }),
      expected,
      `Blob chunk size ${chunkSizeBytes}`,
    );
  }

  const incremental = new IncrementalSha256();
  for (let offset = 0; offset < bytes.length; offset += 31) {
    incremental.update(bytes.subarray(offset, Math.min(offset + 31, bytes.length)));
  }
  assert.equal(incremental.hexDigest(), expected);
  assert.equal(incremental.hexDigest(), expected, "digest is stable when read twice");
});
