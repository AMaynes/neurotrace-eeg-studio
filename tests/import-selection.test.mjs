import assert from "node:assert/strict";
import test from "node:test";
import { DirectoryImportError } from "../app/directory-import.ts";
import { classifyRecordingSelection, collectDroppedRecordingFiles } from "../app/import-selection.ts";

function fileAt(path, relative = false) {
  const file = new File([new Uint8Array(256)], path.split("/").at(-1));
  if (relative) Object.defineProperty(file, "webkitRelativePath", { value: path, configurable: true });
  for (const method of ["arrayBuffer", "text", "stream", "slice", "bytes"]) {
    Object.defineProperty(file, method, { value() { assert.fail(`Unexpected waveform read: ${path}`); } });
  }
  return file;
}
function expectError(files, fromDirectory, code) {
  assert.throws(() => classifyRecordingSelection(files, fromDirectory), (error) => error instanceof DirectoryImportError && error.code === code);
}
function fileEntry(file) {
  return { name: file.name, isFile: true, isDirectory: false, file(success) { success(file); } };
}
function folderEntry(name, children, batchSize = 100) {
  let reads = 0;
  return {
    name, isFile: false, isDirectory: true,
    get reads() { return reads; },
    createReader() {
      let offset = 0;
      return { readEntries(success) { reads += 1; const batch = children.slice(offset, offset + batchSize); offset += batch.length; success(batch); } };
    },
  };
}
function dropEntries(entries) {
  return { files: [], items: entries.map((entry) => ({ kind: "file", webkitGetAsEntry: () => entry, getAsFile: () => null })) };
}

test("a plain single recording remains a file selection without reading bytes", () => {
  for (const name of ["one.edf", "one.MAT", "one.dat", "one.neurotrace"]) {
    const file = fileAt(name);
    const result = classifyRecordingSelection([file]);
    assert.deepEqual(result, { kind: "files", files: [file] });
    assert.equal(result.files[0], file);
  }
});
test("one MAT + DAT pair with companions remains a single session", () => {
  const files = [fileAt("one.mat"), fileAt("one.dat"), fileAt("one_events.tsv")];
  assert.deepEqual(classifyRecordingSelection(files), { kind: "files", files });
});
test("a folder containing one recording is detected from relative paths", () => {
  const file = fileAt("study/one.edf", true);
  const result = classifyRecordingSelection([file]);
  assert.equal(result.kind, "directory");
  assert.equal(result.plan.format, "edf");
  assert.equal(result.plan.recordings[0].primary, file);
});
test("an explicit folder selection is recognized even without relative paths", () => {
  const result = classifyRecordingSelection([fileAt("one.mat")], true);
  assert.equal(result.kind, "directory");
  assert.equal(result.plan.format, "mat");
});
test("flat multiple EDF, MAT, or NeuroTrace sessions automatically become collections", () => {
  for (const format of ["edf", "mat", "neurotrace"]) {
    const result = classifyRecordingSelection([fileAt(`a.${format}`), fileAt(`b.${format}`), fileAt("notes.txt")]);
    assert.equal(result.kind, "directory");
    assert.equal(result.plan.format, format);
    assert.equal(result.plan.recordings.length, 2);
    assert.equal(result.plan.supportingFiles.length, 1);
  }
});
test("multiple flat MAT + DAT pairs infer paired format", () => {
  const result = classifyRecordingSelection(["b.dat", "a.mat", "b.MAT", "a.DAT"].map((name) => fileAt(name)));
  assert.equal(result.kind, "directory");
  assert.equal(result.plan.format, "mat-dat");
  assert.equal(result.plan.recordings.length, 2);
});
test("mixed families are rejected before a first recording can be silently chosen", () => {
  expectError([fileAt("a.edf"), fileAt("b.mat")], false, "MIXED_FORMATS");
  expectError([fileAt("a.edf"), fileAt("b.dat")], false, "MIXED_FORMATS");
  expectError([fileAt("a.mat"), fileAt("a.dat"), fileAt("b.mat")], false, "MISSING_PAIR");
});

test("explicit folder formats override automatic detection and exclude other recording types", () => {
  const files = [fileAt("study/one.edf", true), fileAt("study/two.MAT", true), fileAt("study/two.dat", true),
    fileAt("study/review.neurotrace", true), fileAt("study/extra.bdf", true), fileAt("study/metadata.json", true)];
  for (const [format, expected] of [["edf", [files[0]]], ["mat", [files[1]]], ["mat-dat", [files[2]]], ["neurotrace", [files[3]]]]) {
    for (const fromDirectory of [true, false]) {
      const result = classifyRecordingSelection(files, fromDirectory, format);
      assert.equal(result.kind, "directory");
      assert.equal(result.plan.format, format);
      assert.deepEqual(result.plan.recordings.map((entry) => entry.primary), expected);
      assert.deepEqual(result.plan.supportingFiles, [files[5]]);
    }
  }
  const flat = [fileAt("a.mat"), fileAt("a.edf")];
  assert.equal(classifyRecordingSelection(flat, true, "mat").plan.format, "mat", "directory provenance need not be stored on File objects");
});

test("a selected folder format with no matches errors instead of silently opening another type or metadata", () => {
  for (const files of [[fileAt("study/a.mat", true)], [fileAt("study/events.tsv", true)]]) {
    assert.throws(() => classifyRecordingSelection(files, true, "edf"), (error) => error.code === "NO_RECORDINGS");
  }
  assert.throws(() => classifyRecordingSelection([], true, "edf"), (error) => error.code === "EMPTY_DIRECTORY");
  assert.throws(() => classifyRecordingSelection([fileAt("a.mat"), fileAt("wrong.dat"), fileAt("other.edf")], true, "mat-dat"),
    (error) => error.code === "MISSING_PAIR");
});
test("DAT-only collections require MAT partners but single DAT is preserved", () => {
  expectError([fileAt("a.dat"), fileAt("b.dat")], false, "MISSING_PAIR");
  expectError([fileAt("study/a.dat", true)], false, "MISSING_PAIR");
  assert.equal(classifyRecordingSelection([fileAt("a.dat")]).kind, "files");
});
test("folder pairs require matching basename in the same directory", () => {
  expectError([fileAt("study/day1/a.mat", true), fileAt("study/day2/a.dat", true)], false, "MISSING_PAIR");
});
test("project folders infer NeuroTrace without reading any archive bytes", () => {
  const single = fileAt("study/a.neurotrace", true);
  const one = classifyRecordingSelection([single]);
  assert.equal(one.kind, "directory");
  assert.equal(one.plan.format, "neurotrace");
  assert.equal(one.plan.recordings[0].primary, single);
  const nested = fileAt("study/session-2/a.NEUROTRACE", true);
  const several = classifyRecordingSelection([nested, single, fileAt("study/metadata.json", true)]);
  assert.equal(several.plan.format, "neurotrace");
  assert.deepEqual(several.plan.recordings.map((entry) => entry.primary), [single, nested]);
  assert.equal(classifyRecordingSelection([fileAt("a.neurotrace")], true).plan.format, "neurotrace");
});
test("projects mixed with any recording family reject before opening a subset", () => {
  for (const extension of ["edf", "mat", "dat", "bdf"]) {
    expectError([fileAt("a.neurotrace"), fileAt(`b.${extension}`)], false, "MIXED_FORMATS");
    expectError([fileAt("study/a.neurotrace", true), fileAt(`study/nested/b.${extension}`, true)], true, "MIXED_FORMATS");
  }
  expectError([fileAt("a.neurotrace"), fileAt("b.mat"), fileAt("b.dat")], false, "MIXED_FORMATS");
});
test("recognizable unsupported recordings are not treated as harmless collection companions", () => {
  expectError([fileAt("a.edf"), fileAt("b.bdf")], false, "MIXED_FORMATS");
  expectError([fileAt("study/a.nwb", true)], false, "MIXED_FORMATS");
  expectError([fileAt("a.set"), fileAt("a.fdt")], false, "MIXED_FORMATS");
});
test("companion-only selections and folders remain additive file imports", () => {
  const flat = [fileAt("events.tsv"), fileAt("metadata.json")];
  const nested = [fileAt("study/events.tsv", true), fileAt("study/metadata.json", true)];
  assert.deepEqual(classifyRecordingSelection(flat), { kind: "files", files: flat });
  assert.deepEqual(classifyRecordingSelection(nested), { kind: "files", files: nested });
  assert.deepEqual(classifyRecordingSelection(flat, true), { kind: "files", files: flat });
});
test("empty folder fails while cancelled ordinary file selection remains empty", () => {
  expectError([], true, "EMPTY_DIRECTORY");
  assert.deepEqual(classifyRecordingSelection([]), { kind: "files", files: [] });
});
test("duplicate collection paths fail instead of discarding a file", () => {
  expectError([fileAt("a.edf"), fileAt("A.edf")], false, "DUPLICATE_PATH");
});

test("dropped plain files retain identity and are not given fabricated relative paths", async () => {
  const file = fileAt("a.edf");
  const result = await collectDroppedRecordingFiles(dropEntries([fileEntry(file)]));
  assert.equal(result.files[0], file);
  assert.equal(Boolean(result.files[0].webkitRelativePath), false);
  assert.equal(result.directory, false);
});
test("multiple loose recordings and MAT + DAT pairs remain available without folder permission", async () => {
  for (const names of [["a.edf", "b.edf"], ["one.mat", "one.dat", "one_events.tsv"]]) {
    const files = names.map((name) => fileAt(name));
    const result = await collectDroppedRecordingFiles(dropEntries(files.map(fileEntry)));
    assert.deepEqual(result, { files, directory: false });
    const selection = classifyRecordingSelection(result.files, result.directory);
    if (names[0].endsWith("edf")) {
      assert.equal(selection.kind, "directory");
      assert.equal(selection.plan.recordings.length, 2);
    } else assert.deepEqual(selection, { kind: "files", files });
  }
});
test("folder roots reject by default before any file callback or directory traversal", async () => {
  const forbiddenFile = { name: "one.edf", isFile: true, isDirectory: false,
    file() { assert.fail("a rejected selection must not request loose files"); } };
  const forbiddenFolder = { name: "study", isFile: false, isDirectory: true,
    createReader() { assert.fail("a rejected selection must not enumerate a folder"); } };
  for (const entries of [[forbiddenFolder], [forbiddenFile, forbiddenFolder], [forbiddenFolder, forbiddenFile]]) {
    await assert.rejects(collectDroppedRecordingFiles(dropEntries(entries)), /Nothing was imported.*inside Load recording.*recording type, then Folder/);
    await assert.rejects(collectDroppedRecordingFiles(dropEntries(entries), { allowDirectories: false }), /Folder drops/);
  }
});
test("relative-path fallbacks reject before any root traversal, including mixed drops", async () => {
  const nested = fileAt("study/one.edf", true);
  const loose = fileAt("two.edf");
  const forbidden = { name: "two.edf", isFile: true, isDirectory: false,
    file() { assert.fail("relative-path input must be detected before requesting another file"); } };
  const transfers = [
    { files: [nested], items: [] },
    { files: [loose, nested], items: [] },
    { files: [nested], items: dropEntries([forbidden]).items },
    { files: [], items: [...dropEntries([forbidden]).items, { kind: "file", getAsFile: () => nested }] },
  ];
  for (const transfer of transfers) {
    await assert.rejects(collectDroppedRecordingFiles(transfer), /Folder drops.*inside Load recording/);
  }
});
test("relative paths exposed only by file callbacks cannot bypass the folder restriction", async () => {
  const nested = fileAt("study/one.edf", true);
  const transfer = dropEntries([fileEntry(fileAt("loose.edf")), fileEntry(nested)]);
  await assert.rejects(collectDroppedRecordingFiles(transfer), /Nothing was imported.*Folder drops/);
});
test("the Folder workflow accepts relative-path fallback files without reading bytes", async () => {
  const files = [fileAt("study/one.mat", true), fileAt("study/one.dat", true)];
  assert.deepEqual(await collectDroppedRecordingFiles({ files, items: [] }, { allowDirectories: true }), { files, directory: true });
});
test("nested dropped directory preserves same-name files and pair paths without copying bytes", async () => {
  const first = fileAt("same.edf");
  const second = fileAt("same.edf");
  const root = folderEntry("study", [folderEntry("day1", [fileEntry(first)]), folderEntry("day2", [fileEntry(second)])]);
  const result = await collectDroppedRecordingFiles(dropEntries([root]), { allowDirectories: true });
  assert.deepEqual(result.files, [first, second]);
  assert.equal(result.directory, true);
  assert.deepEqual(result.files.map((file) => file.webkitRelativePath), ["study/day1/same.edf", "study/day2/same.edf"]);
  assert.equal(classifyRecordingSelection(result.files, result.directory).plan.recordings.length, 2);
});
test("directory readers are drained across batches beyond 100 entries", async () => {
  const entries = Array.from({ length: 251 }, (_, index) => fileEntry(fileAt(`session${index}.edf`)));
  const root = folderEntry("study", entries);
  const result = await collectDroppedRecordingFiles(dropEntries([root]), { allowDirectories: true });
  assert.equal(result.files.length, 251);
  assert.equal(root.reads, 4, "three nonempty batches followed by an empty completion batch");
});
test("all drop entries are captured synchronously before traversal awaits", async () => {
  let readable = true;
  let captures = 0;
  const files = [fileAt("a.edf"), fileAt("b.edf")];
  const transfer = {
    files: [],
    items: files.map((file) => ({
      kind: "file",
      webkitGetAsEntry() { assert.equal(readable, true); captures += 1; return fileEntry(file); },
      getAsFile() { assert.fail("entry was available"); },
    })),
  };
  const promise = collectDroppedRecordingFiles(transfer);
  readable = false;
  assert.equal(captures, 2);
  assert.deepEqual((await promise).files, files);
});
test("empty dropped folders remain identifiable and fail classification clearly", async () => {
  const result = await collectDroppedRecordingFiles(dropEntries([folderEntry("empty", [])]), { allowDirectories: true });
  assert.deepEqual(result, { files: [], directory: true });
  expectError(result.files, result.directory, "EMPTY_DIRECTORY");
});
test("plain files fall back to DataTransfer.files when entries are unavailable", async () => {
  const files = [fileAt("a.edf"), fileAt("b.mat")];
  const result = await collectDroppedRecordingFiles({ files, items: [] });
  assert.deepEqual(result, { files, directory: false });
  const missingEntry = await collectDroppedRecordingFiles({ files: [files[0]], items: [{ kind: "file", getAsFile: () => files[0] }] });
  assert.equal(missingEntry.files[0], files[0]);
});
test("mixed available entries and plain-file fallbacks do not lose either input", async () => {
  const nested = fileAt("a.edf");
  const plain = fileAt("b.edf");
  const transfer = dropEntries([folderEntry("study", [fileEntry(nested)])]);
  transfer.items.push({ kind: "file", getAsFile: () => plain });
  const result = await collectDroppedRecordingFiles(transfer, { allowDirectories: true });
  assert.deepEqual(result.files, [nested, plain]);
  assert.equal(plain.webkitRelativePath, undefined);
  assert.equal(result.directory, true);
});
test("uninspectable directory-like drops give actionable chooser guidance", async () => {
  const directoryLike = new File([], "study");
  await assert.rejects(collectDroppedRecordingFiles({ files: [directoryLike], items: [] }), /Nothing was imported.*Load recording.*recording type.*Files or Folder.*only after choosing Folder/);
});
test("a reader failure rejects the complete drop, never returning the preceding partial batch", async () => {
  let reads = 0;
  const root = {
    name: "study", isFile: false, isDirectory: true,
    createReader() { return { readEntries(success, failure) { reads += 1; if (reads === 1) success([fileEntry(fileAt("a.edf"))]); else failure(new Error("denied")); } }; },
  };
  await assert.rejects(collectDroppedRecordingFiles(dropEntries([root]), { allowDirectories: true }), /could not be fully read.*Nothing was imported/);
  assert.equal(reads, 2);
});
test("file callback failure rejects traversal without a partial result", async () => {
  const broken = { name: "b.edf", isFile: true, isDirectory: false, file(_success, failure) { failure(new Error("denied")); } };
  await assert.rejects(collectDroppedRecordingFiles(dropEntries([folderEntry("study", [fileEntry(fileAt("a.edf")), broken])]), { allowDirectories: true }), /file.*could not be read.*Nothing was imported/);
});
test("entry acquisition errors fail before any traversal", async () => {
  await assert.rejects(collectDroppedRecordingFiles({ files: [], items: [{ kind: "file", webkitGetAsEntry() { throw new Error("blocked"); } }] }), /could not inspect/);
});
test("invalid relative entry names and excessive nesting reject safely", async () => {
  await assert.rejects(collectDroppedRecordingFiles(dropEntries([folderEntry("../study", [])]), { allowDirectories: true }), /invalid relative path/);
  let root = fileEntry(fileAt("a.edf"));
  for (let index = 0; index < 200; index += 1) root = folderEntry(`level${index}`, [root]);
  await assert.rejects(collectDroppedRecordingFiles(dropEntries([root]), { allowDirectories: true }), /200 path segments/);
});
test("failure to preserve relative paths rejects rather than flattening a directory", async () => {
  const locked = Object.preventExtensions(fileAt("a.edf"));
  await assert.rejects(collectDroppedRecordingFiles(dropEntries([folderEntry("study", [fileEntry(locked)])]), { allowDirectories: true }), /could not preserve.*paths/);
});
test("oversized fallback selections are rejected before any file reads", async () => {
  const file = fileAt("a.edf");
  await assert.rejects(collectDroppedRecordingFiles({ files: Array(100_001).fill(file), items: [] }), /maximum 100,000/);
});
test("an endless reader cannot bypass the entry limit", async () => {
  const emptyFolder = folderEntry("empty", []);
  const root = {
    name: "study", isFile: false, isDirectory: true,
    createReader() { return { readEntries(success) { success(Array(1000).fill(emptyFolder)); } }; },
  };
  await assert.rejects(collectDroppedRecordingFiles(dropEntries([root]), { allowDirectories: true }), /maximum 100,000/);
});
