import assert from "node:assert/strict";
import test from "node:test";
import { localRecordingIdentity, recordingReferenceMatches } from "../app/local-recording-identity.ts";

const file = (patch = {}) => ({ name: "recording.dat", size: 8_000_000_000, lastModified: 12345,
  webkitRelativePath: "patient/recording.dat", slice() { assert.fail("must not read recording bytes"); },
  arrayBuffer() { assert.fail("must not read recording bytes"); }, ...patch });

test("local recovery identity does no file I/O and is stable across property order and re-selection", () => {
  const first = localRecordingIdentity(file(), { rate: 1000, channels: ["A1", "A2"] }, file({ name: "metadata.mat", size: 42 }));
  assert.match(first, /^local-v1:[0-9a-f]{64}$/);
  assert.equal(first, localRecordingIdentity(file(), { channels: ["A1", "A2"], rate: 1000 }, file({ name: "metadata.mat", size: 42 })));
});

test("separate paths, changed files, interpretations and companions retain independent reviews", () => {
  const baseline = localRecordingIdentity(file(), { rate: 1000 }, file({ size: 42 }));
  for (const patch of [{ size: 20 }, { lastModified: 987 }, { webkitRelativePath: "patient2/recording.dat" }]) {
    assert.notEqual(baseline, localRecordingIdentity(file(patch), { rate: 1000 }, file({ size: 42 })));
  }
  assert.notEqual(baseline, localRecordingIdentity(file(), { rate: 2000 }, file({ size: 42 })));
  assert.notEqual(baseline, localRecordingIdentity(file(), { rate: 1000 }, file({ size: 43 })));
  assert.notEqual(baseline, localRecordingIdentity(file(), { rate: 1000 }));
});

test("reference-only saved projects require matching recording metadata without claiming a checksum", () => {
  const reference = { name: "test.edf", format: "edf+", byteLength: 1000, channelCount: 18, durationSec: 20 };
  assert.equal(recordingReferenceMatches(reference, { ...reference }), true);
  assert.equal(recordingReferenceMatches(null, reference), false);
  for (const patch of [{ name: "other.edf" }, { format: "mat-v5" }, { byteLength: 2000 }, { channelCount: 16 }, { durationSec: 25 }]) {
    assert.equal(recordingReferenceMatches(reference, { ...reference, ...patch }), false);
  }
});
