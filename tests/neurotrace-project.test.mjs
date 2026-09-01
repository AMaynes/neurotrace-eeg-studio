import assert from "node:assert/strict";
import test from "node:test";
import { File } from "node:buffer";

import {
  NEUROTRACE_PROJECT_MIME,
  classifyCustomTool,
  createNeurotraceProjectArchive,
  importCustomToolFiles,
  mergeCustomToolAssets,
  readCustomToolAsset,
  safeArchivePath,
} from "../app/neurotrace-project.ts";

const decoder = new TextDecoder();

async function storedZipEntries(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    if (view.getUint32(0, true) !== 0x04034b50) break;
    const size = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const nameStart = offset + 30;
    const contentStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.set(name, bytes.slice(contentStart, contentStart + size));
    offset = contentStart + size;
  }
  return entries;
}

test("creates one versioned neurotrace ZIP with selected state and binary files", async () => {
  const recording = new File([new Uint8Array([1, 2, 3, 4])], "patient.edf", { type: "application/octet-stream" });
  const companion = new File(["onset\tduration\n1\t2\n"], "events.tsv", { type: "text/tab-separated-values" });
  const tool = {
    id: "tool-dictionary",
    kind: "dictionary",
    name: "Clinical words",
    sourceName: "clinical.dictionary",
    mimeType: "text/plain",
    byteLength: 11,
    importedAt: "2026-09-01T12:00:00.000Z",
    content: "alpha\nbeta\n",
  };
  const result = await createNeurotraceProjectArchive({
    projectId: "session-1",
    title: "Patient 01",
    appVersion: "0.1.0",
    createdAt: "2026-09-01T12:00:00.000Z",
    recording: {
      name: recording.name,
      format: "edf+",
      byteLength: recording.size,
      durationSec: 60,
      channelCount: 2,
      sourceContentSha256: "abc",
      sessionInterpretationSha256: "def",
    },
    review: { annotations: [{ id: "a1" }] },
    workspace: { montage: "referential" },
    labelDefinitions: { labels: [{ id: "ictal" }] },
    customTools: [tool],
    supportingFiles: [companion],
    recordingFile: recording,
  });

  assert.equal(result.fileName, "Patient 01.neurotrace");
  assert.equal(result.blob.type, NEUROTRACE_PROJECT_MIME);
  const entries = await storedZipEntries(result.blob);
  assert.deepEqual(
    [...entries.keys()],
    [
      "manifest.json",
      "review/state.json",
      "workspace/settings.json",
      "definitions/labels.json",
      "custom-tools/files/clinical.dictionary",
      "custom-tools/index.json",
      "uploads/files/events.tsv",
      "uploads/index.json",
      "recording/patient.edf",
      "README.txt",
    ],
  );
  assert.deepEqual([...entries.get("recording/patient.edf")], [1, 2, 3, 4]);
  const manifest = JSON.parse(decoder.decode(entries.get("manifest.json")));
  assert.equal(manifest.schema, "neurotrace-project");
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.recording.included, true);
  assert.equal(manifest.recording.archivePath, "recording/patient.edf");
  assert.equal(manifest.security.importedToolsAreExecutable, false);
  assert.equal(manifest.contents.find((entry) => entry.path === "manifest.json").byteLength, entries.get("manifest.json").byteLength);
});

test("omits unselected sections while retaining the portable manifest", async () => {
  const result = await createNeurotraceProjectArchive({
    projectId: "blank-1",
    title: "Blank workspace",
    appVersion: "0.1.0",
    recording: null,
  });
  const entries = await storedZipEntries(result.blob);
  assert.deepEqual([...entries.keys()], ["manifest.json", "README.txt"]);
  const manifest = JSON.parse(decoder.decode(entries.get("manifest.json")));
  assert.deepEqual(manifest.sections, {
    review: null,
    workspace: null,
    labelDefinitions: null,
    customTools: null,
    supportingFiles: null,
  });
});

test("recognizes explicit tool assets without stealing ordinary BIDS JSON", async () => {
  assert.equal(classifyCustomTool("medical.dictionary"), "dictionary");
  assert.equal(classifyCustomTool("artifact-filtering-method.json"), "filter-method");
  assert.equal(classifyCustomTool("depth-channel-groups.yaml"), "channel-grouping");
  assert.equal(classifyCustomTool("sub-01_task-rest_eeg.json", { SamplingFrequency: 256 }), null);
  assert.equal(classifyCustomTool("portable.json", { kind: "equation" }), "equation");

  const bids = new File([JSON.stringify({ SamplingFrequency: 256 })], "sub-01_task-rest_eeg.json", { type: "application/json" });
  const equation = new File([JSON.stringify({ kind: "equation", equation: "theta / delta" })], "ratio.json", { type: "application/json" });
  const words = new File(["seizure\nartifact\n"], "clinical.words", { type: "text/plain" });
  const imported = await importCustomToolFiles([bids, equation, words]);
  assert.deepEqual(imported.assets.map((asset) => asset.kind), ["equation", "dictionary"]);
  assert.deepEqual(imported.remainingFiles.map((file) => file.name), [bids.name]);
  assert.deepEqual(imported.errors, []);
});

test("rejects malformed explicit tool JSON and bounds imported tool size", async () => {
  const malformed = new File(["{"], "custom-equations.json", { type: "application/json" });
  await assert.rejects(readCustomToolAsset(malformed), /Custom tool JSON is invalid/);
  const result = await importCustomToolFiles([malformed]);
  assert.equal(result.assets.length, 0);
  assert.equal(result.remainingFiles.length, 0);
  assert.match(result.errors[0].message, /invalid/);
});

test("normalizes traversal paths and replaces tools with repeated source names", () => {
  assert.equal(safeArchivePath("../../outside\\filters?.json"), "_/_/outside/filters_.json");
  const older = { id: "old", sourceName: "METHOD.FILTER", importedAt: "old" };
  const newer = { id: "new", sourceName: "method.filter", importedAt: "new" };
  const merged = mergeCustomToolAssets([older], [newer]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "new");
});
