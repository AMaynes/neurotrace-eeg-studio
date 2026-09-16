import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { RawDatSource } from "../app/eeg-core.ts";
import { mergeSelectedFiles } from "../app/bids-companions.ts";
import { findMatDatCompanion, legacyMetadataIssue, MatDatImportError, pendingFilesForSelection, resolveMatDatImport } from "../app/mat-import.ts";
import { legacyMatFile, standaloneMatFile } from "./fixtures/legacy-mat.mjs";

function datFile(name = "synthetic.dat", channelCount = 157) {
  const bytes = Buffer.alloc(channelCount * 4 * 2);
  for (let frame = 0; frame < 4; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      bytes.writeInt16LE(frame * 1000 + channel - 2000, 2 * (frame * channelCount + channel));
    }
  }
  return new File([bytes], name);
}

test("routes a local legacy pair to DAT with all 157 channels and their original order", async () => {
  const labels = Array.from({ length: 157 }, (_, index) => `SYN${157 - index}`);
  ["E", "DC01", "Mark1", "X35", "EKG", "Events"].forEach((label, index) => { labels[index * 25] = label; });
  const mat = legacyMatFile({ name: "SYNTHETIC.MAT", labels, compressed: true });
  const dat = datFile();
  for (const primary of [mat, dat]) {
    const result = await resolveMatDatImport(primary, [dat, mat]);
    assert.equal(result.kind, "legacy-dat");
    assert.equal(result.file, dat, "use the selected local DAT, never the stale acquisition path");
    assert.equal(result.mat, mat);
    assert.equal(result.metadataIssue, null);
    assert.equal(result.metadata.sampleRate, 1000);
    assert.equal(result.metadata.channelCount, 157);
    assert.deepEqual(result.metadata.channelLabels, labels);
    assert.equal(result.metadata.events.length, 2);
    const source = await RawDatSource.create(result.file, result.metadata);
    const window = await source.getWindow(0, 0.004);
    assert.equal(window.data.length, 157);
    assert.deepEqual(source.meta.channelLabels, labels);
    for (let channel = 0; channel < 157; channel += 1) {
      assert.deepEqual([...window.data[channel]], [-2000, -1000, 0, 1000].map((value) => value + channel));
    }
    assert.deepEqual(result.diagnostics, { format: "legacy-mat-dat", sampleRate: 1000, channelCount: 157, channelLabelCount: 157 });
    assert.doesNotMatch(JSON.stringify(result.diagnostics), /synthetic|onset|unavailable|SYN|filename|patient/i);
  }
});

test("standalone MAT keeps its exact signals even with a same-basename DAT", async () => {
  const mat = standaloneMatFile({ name: "synthetic.mat", compressed: true });
  const dat = datFile();
  for (const [primary, files] of [[mat, [mat]], [mat, [mat, dat]], [dat, [mat, dat]]]) {
    const result = await resolveMatDatImport(primary, files);
    assert.equal(result.kind, "standalone-mat");
    assert.equal(result.file, mat);
    assert.equal(result.source.meta.sampleRate, 128);
    assert.deepEqual((await result.source.getWindow(0, 1)).data.map((values) => [...values]), [[1, 2, 3, 4], [10, 20, 30, 40]]);
  }
});

test("legacy MAT without its DAT reports the expected companion instead of selecting header arrays", async () => {
  const mat = legacyMatFile();
  for (const files of [[mat], [mat, datFile("unrelated.dat")]]) {
    await assert.rejects(resolveMatDatImport(mat, files), (error) => {
      assert.ok(error instanceof MatDatImportError);
      assert.equal(error.title, "Legacy MAT needs its DAT file");
      assert.match(error.message, /synthetic\.dat/);
      assert.doesNotMatch(error.message, /invalid.*header|missing flags/i);
      return true;
    });
  }
  const unrelated = datFile("unrelated.dat");
  const raw = await resolveMatDatImport(unrelated, [unrelated, mat]);
  assert.equal(raw.kind, "raw-dat");
  assert.equal(raw.file, unrelated);
  assert.equal(raw.diagnostics.sampleRate, null, "never borrow unrelated metadata");
});

test("standalone waveforms alongside sessionInfo stay standalone, with or without DAT", async () => {
  const mat = legacyMatFile({ standaloneSignal: true });
  const dat = datFile();
  for (const [primary, files] of [[mat, [mat]], [dat, [mat, dat]]]) {
    const result = await resolveMatDatImport(primary, files);
    assert.equal(result.kind, "standalone-mat");
    assert.equal(result.source.meta.channelCount, 2);
    assert.equal(result.source.meta.sampleRate, 128);
    assert.deepEqual([...(await result.source.getWindow(0, 1)).data[1]], [10, 20, 30, 40]);
  }
});

test("channel array dimensions must agree with the declared count even when label rows match", () => {
  assert.match(legacyMetadataIssue({
    sampleRate: 128, channelCount: 2, channelEntryCount: 1, channelLabels: ["A", "B"], events: [], warnings: [],
  }), /Channel contains 1 entries/);
});

test("companions added in separate selections resolve in either upload order", async () => {
  const mat = legacyMatFile();
  const dat = datFile();
  const initial = await resolveMatDatImport(dat, [dat]);
  assert.equal(initial.kind, "raw-dat");
  for (const [staged, incoming] of [[[mat], [dat]], [[dat], [mat]]]) {
    const files = mergeSelectedFiles(pendingFilesForSelection(staged, incoming), incoming);
    const result = await resolveMatDatImport(incoming[0], files);
    assert.equal(result.kind, "legacy-dat");
    assert.equal(result.file, dat);
  }
});

test("switching to an unrelated recording discards prior pending channel and event sidecars", () => {
  const pending = [datFile("previous.dat"), new File(["name\nOLD\n"], "channels.tsv"), new File(["onset\n0\n"], "events.tsv")];
  const next = [datFile("next.dat")];
  assert.deepEqual(mergeSelectedFiles(pendingFilesForSelection(pending, next), next), next);
  const previous = Object.defineProperty(datFile(), "webkitRelativePath", { value: "prior/synthetic.dat" });
  const unrelated = Object.defineProperty(legacyMatFile(), "webkitRelativePath", { value: "next/synthetic.mat" });
  assert.deepEqual(pendingFilesForSelection([previous], [unrelated]), []);
  assert.deepEqual(pendingFilesForSelection([legacyMatFile()], [new File([""], "synthetic.edf")]), []);
});

test("missing or inconsistent legacy metadata stays editable without inferred counts", async () => {
  const dat = datFile();
  for (const [options, message] of [
    [{ sampleRate: null }, /sample_rate.*missing/],
    [{ sampleRate: 0 }, /sample_rate.*positive/],
    [{ channelCount: null }, /num_channels.*missing/],
    [{ channelCount: 1.5 }, /num_channels.*whole-number/],
    [{ labels: Array.from({ length: 156 }, (_, index) => `SYN${index}`) }, /157 channels but 156 channel labels/],
    [{ labels: [] }, /no channel names/],
  ]) {
    const mat = legacyMatFile(options);
    const result = await resolveMatDatImport(dat, [dat, mat]);
    assert.equal(result.kind, "legacy-dat");
    assert.match(result.metadataIssue, message);
    if (options.channelCount !== undefined) assert.equal(result.metadata.channelCount, undefined);
    if (options.sampleRate !== undefined) assert.equal(result.metadata.sampleRate, undefined);
    if (options.labels) assert.equal(result.metadata.channelLabels.length, options.labels.length);
  }
});

test("folder pairing prefers a sibling and rejects ambiguous basename-only matches", () => {
  const withPath = (file, path) => Object.defineProperty(file, "webkitRelativePath", { value: path });
  const mat = withPath(legacyMatFile(), "root/session/synthetic.mat");
  const sibling = withPath(datFile(), "root/session/synthetic.dat");
  const other = withPath(datFile(), "root/other/synthetic.dat");
  assert.equal(findMatDatCompanion(mat, [other, sibling], "dat"), sibling);
  assert.equal(findMatDatCompanion(legacyMatFile(), [sibling], "dat"), sibling);
  assert.throws(() => findMatDatCompanion(legacyMatFile(), [sibling, other], "dat"), /More than one matching companion/);
});

test("invalid MAT has a format-specific error; DAT manual mapping remains available", async () => {
  const mat = new File([new Uint8Array(128)], "synthetic.mat");
  const dat = datFile();
  await assert.rejects(resolveMatDatImport(mat, [mat]), (error) => error instanceof MatDatImportError && error.title === "MAT file could not be read");
  const raw = await resolveMatDatImport(dat, [mat, dat]);
  assert.equal(raw.kind, "raw-dat");
  assert.match(raw.metadataError, /mapping manually/);
});

test("recording dialog uses classified imports and retains pending files for a later companion", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /resolveMatDatImport\(/);
  assert.doesNotMatch(page, /MatSource\.create\(/);
  assert.match(page, /mergeSelectedFiles\(stagedFiles, files\)/);
  assert.match(page, /channelCount: legacyMetadata\?\.channelCount \?\? 0/);
  assert.match(page, /console\.info\("\[NeuroTrace import\]", resolved\.diagnostics\)/);
});
