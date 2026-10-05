/** Patient-free collection discovery: structure only, never waveform decoding. */
import assert from "node:assert/strict";
import test from "node:test";

import { DirectoryImportError, directoryRecordingFiles, planDirectoryImport } from "../app/directory-import.ts";
import { analyzeBidsCompanions } from "../app/bids-companions.ts";

function fileAt(path) {
  const file = new File([], path.replaceAll("\\", "/").split("/").at(-1), { lastModified: 1 });
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  // A planner must never sample either recording data or metadata contents.
  for (const method of ["arrayBuffer", "text", "stream", "slice", "bytes"]) {
    Object.defineProperty(file, method, { value() { throw new Error(`Unexpected file read: ${path}`); } });
  }
  return file;
}

function textFileAt(path, contents) {
  const file = new File([contents], path.split("/").at(-1));
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

function expectError(files, format, code) {
  let failure;
  assert.throws(() => planDirectoryImport(files, format), (error) => {
    failure = error;
    return error instanceof DirectoryImportError && error.code === code;
  });
  return failure;
}

test("recursively enumerates every EDF in stable natural relative-path order", () => {
  const paths = ["study/session-10/run-1.edf", "study/session-2/run-10.EDF", "study/session-1/run-1.edf", "study/session-2/run-2.edf"];
  const files = paths.map(fileAt);
  const plan = planDirectoryImport(files, "edf");
  assert.equal(plan.format, "edf");
  assert.deepEqual(plan.recordings.map((entry) => entry.relativePath), [paths[2], paths[3], paths[1], paths[0]]);
  assert.deepEqual(plan.recordings.map((entry) => entry.id), planDirectoryImport([...files].reverse(), "edf").recordings.map((entry) => entry.id));
  assert.equal(plan.recordings.length, files.length);
  assert.ok(plan.recordings.every((entry) => entry.files.length === 1 && entry.files[0] === entry.primary && entry.label === entry.relativePath));
});

test("same basenames in different folders stay separate sessions", () => {
  const plan = planDirectoryImport([fileAt("study/day-1/eeg.edf"), fileAt("study/day-2/eeg.edf")], "edf");
  assert.equal(plan.recordings.length, 2);
  assert.notEqual(plan.recordings[0].id, plan.recordings[1].id);
  assert.notEqual(plan.recordings[0].label, plan.recordings[1].label);
});

test("standalone MAT collection includes every MAT and shares metadata companions once", () => {
  const first = fileAt("study/session-1/eeg.mat");
  const second = fileAt("study/session-2/eeg.MAT");
  const description = fileAt("study/dataset_description.json");
  const events = fileAt("study/session-2/eeg_events.tsv");
  const notes = fileAt("study/notes.txt");
  const plan = planDirectoryImport([second, events, notes, first, description], "mat");
  assert.deepEqual(plan.recordings.map((entry) => entry.primary), [first, second]);
  assert.deepEqual(plan.supportingFiles, [description, notes, events]);
  assert.deepEqual(plan.recordings.map((entry) => entry.files), [[first], [second]]);
});

test("a folder with one saved project is catalogued without inspecting the archive", () => {
  const project = fileAt("study/review.neurotrace");
  const plan = planDirectoryImport([project], "neurotrace");
  assert.equal(plan.format, "neurotrace");
  assert.equal(plan.recordings.length, 1);
  assert.equal(plan.recordings[0].primary, project);
  assert.equal(plan.recordings[0].relativePath, "study/review.neurotrace");
  assert.deepEqual(directoryRecordingFiles(plan, plan.recordings[0]), [project]);
  assert.ok(!("verified" in plan.recordings[0]), "filename discovery cannot verify archive contents or embedded recordings");
});

test("nested projects preserve identity and exclude every external companion on opening", () => {
  const first = fileAt("study/session-2/review.neurotrace");
  const second = fileAt("study/session-10/review.NEUROTRACE");
  const metadata = fileAt("study/metadata.json");
  const events = fileAt("study/session-2/review_events.tsv");
  const custom = fileAt("study/session-2/labels.txt");
  const plan = planDirectoryImport([second, metadata, events, first, custom], "neurotrace");
  assert.deepEqual(plan.recordings.map((entry) => entry.primary), [first, second]);
  assert.notEqual(plan.recordings[0].id, plan.recordings[1].id);
  assert.deepEqual(new Set(plan.supportingFiles), new Set([metadata, events, custom]));
  for (const recording of plan.recordings) {
    assert.deepEqual(directoryRecordingFiles(plan, recording), [recording.primary]);
    assert.deepEqual(recording.files, [recording.primary], "opening must not mutate the project entry");
  }
});

test("pairs MAT and DAT by case-insensitive relative folder and exact basename", () => {
  const firstMat = fileAt("study/session-1/EEG.MAT");
  const firstDat = fileAt("study/session-1/eeg.dat");
  const secondMat = fileAt("study/session-2/eeg.mat");
  const secondDat = fileAt("study/session-2/EEG.DAT");
  const channels = fileAt("study/session-1/eeg_channels.tsv");
  const plan = planDirectoryImport([secondDat, firstMat, channels, firstDat, secondMat], "mat-dat");
  assert.equal(plan.recordings.length, 2);
  assert.deepEqual(plan.recordings.map((entry) => entry.primary), [firstDat, secondDat]);
  assert.deepEqual(plan.recordings.map((entry) => entry.files), [[firstMat, firstDat], [secondMat, secondDat]]);
  assert.deepEqual(plan.supportingFiles, [channels]);
});

test("normalizes Windows separators before same-folder pairing", () => {
  const mat = fileAt("study\\day-1\\eeg.mat");
  const dat = fileAt("study/day-1/eeg.dat");
  const plan = planDirectoryImport([mat, dat], "mat-dat");
  assert.deepEqual(plan.recordings[0].files, [mat, dat]);
  assert.equal(plan.recordings[0].relativePath, "study/day-1/eeg.dat");
});

test("rejects cross-directory pairing even when basenames match", () => {
  const failure = expectError([fileAt("study/day-1/eeg.mat"), fileAt("study/day-2/eeg.dat")], "mat-dat", "MISSING_PAIR");
  assert.equal(failure.paths.length, 2);
  assert.match(failure.message, /same folder/);
});

test("rejects orphan MATs and DATs instead of importing an incomplete subset", () => {
  for (const orphan of ["orphan.mat", "orphan.dat"]) {
    const failure = expectError([fileAt("study/good.mat"), fileAt("study/good.dat"), fileAt(`study/${orphan}`)], "mat-dat", "MISSING_PAIR");
    assert.deepEqual(failure.paths, [`study/${orphan}`]);
  }
});

test("requires exact pair basenames, never fuzzy matches", () => {
  expectError([fileAt("study/eeg.mat"), fileAt("study/eeg-1.dat")], "mat-dat", "MISSING_PAIR");
});

test("selected format filters mixed recording families anywhere in a directory", () => {
  const cases = [
    ["edf", ["one.edf", "nested/two.mat"]],
    ["edf", ["one.edf", "nested/two.dat"]],
    ["mat", ["one.mat", "nested/two.edf"]],
    ["mat", ["one.mat", "nested/one.dat"]],
    ["mat-dat", ["one.mat", "one.dat", "nested/two.edf"]],
    ["neurotrace", ["one.neurotrace", "nested/two.edf"]],
    ["neurotrace", ["one.neurotrace", "nested/two.mat"]],
    ["neurotrace", ["one.neurotrace", "nested/two.dat"]],
    ["neurotrace", ["one.neurotrace", "nested/two.bdf"]],
  ];
  for (const [format, paths] of cases) {
    const files = paths.map(fileAt);
    const plan = planDirectoryImport(files, format);
    assert.equal(plan.recordings.length, 1);
    const expected = format === "mat-dat" ? files.slice(0, 2) : files.slice(0, 1);
    assert.deepEqual(plan.recordings[0].files, expected);
    assert.deepEqual(directoryRecordingFiles(plan, plan.recordings[0]), expected);
    assert.deepEqual(plan.supportingFiles, [], "ignored recordings must not become metadata companions");
  }
});

test("saved projects and known unsupported waveform formats are ignored, not companions", () => {
  for (const extension of ["neurotrace", "bdf", "set", "nwb", "vhdr", "vmrk", "eeg", "fdt", "mefd"]) {
    const recording = fileAt("study/one.edf");
    const metadata = fileAt("study/one_events.tsv");
    const plan = planDirectoryImport([recording, metadata, fileAt(`study/other.${extension}`)], "edf");
    assert.deepEqual(plan.recordings.map((entry) => entry.primary), [recording]);
    assert.deepEqual(plan.supportingFiles, [metadata]);
    assert.deepEqual(directoryRecordingFiles(plan, plan.recordings[0]), [recording, metadata]);
  }
});

test("ignored recording duplicates do not block the selected format, and no matches fail clearly", () => {
  const recording = fileAt("study/one.edf");
  const ignored = [fileAt("study/two.mat"), fileAt("study/TWO.MAT"), fileAt("study/two.dat")];
  assert.deepEqual(planDirectoryImport([recording, ...ignored], "edf").recordings.map((entry) => entry.primary), [recording]);
  const failure = expectError(ignored, "edf", "NO_RECORDINGS");
  assert.match(failure.message, /No EDF \/ EDF\+ recordings/);
});

test("automatic detection can require one format instead of silently choosing a subset", () => {
  assert.throws(() => planDirectoryImport([fileAt("study/one.edf"), fileAt("study/two.mat")], "edf", { rejectOtherFormats: true }),
    (error) => error.code === "MIXED_FORMATS" && /Choose a recording type, then Folder/.test(error.message));
});

test("rejects duplicate and case-ambiguous paths including partner metadata", () => {
  for (const paths of [
    ["study/one.edf", "study/one.edf"],
    ["study/one.edf", "STUDY/ONE.EDF"],
    ["study/one.mat", "study/ONE.MAT", "study/one.dat"],
    ["study/one.edf", "study/one.json", "study/ONE.JSON"],
  ]) {
    expectError(paths.map(fileAt), paths[0].endsWith("mat") ? "mat-dat" : "edf", "DUPLICATE_PATH");
  }
});

test("duplicate filenames without relative paths are ambiguous rather than guessed", () => {
  const files = [new File([], "eeg.edf"), new File([], "eeg.edf")];
  expectError(files, "edf", "DUPLICATE_PATH");
});

test("rejects malformed or non-relative paths", () => {
  for (const path of ["/study/one.edf", "study//one.edf", "study/../one.edf", "study/./one.edf", "C:\\study\\one.edf"]) {
    expectError([fileAt(path)], "edf", "INVALID_PATH");
  }
});

test("empty and companion-only directories have actionable failures", () => {
  expectError([], "edf", "EMPTY_DIRECTORY");
  expectError([fileAt("study/events.tsv"), fileAt("study/metadata.json")], "mat", "NO_RECORDINGS");
});

test("discovery stays filename-only and does not claim file contents are valid", () => {
  // Deliberately empty fake waveform files: the actual loader must reject these,
  // while the planner can list them without touching protected recording bytes.
  const files = [fileAt("study/eeg.dat"), fileAt("study/eeg.mat"), fileAt("study/eeg.json")];
  const plan = planDirectoryImport(files, "mat-dat");
  assert.equal(plan.recordings.length, 1);
  assert.equal(plan.recordings[0].primary.size, 0);
  assert.ok(!("verified" in plan.recordings[0]));
});

test("large synthetic directory retains linear file references and stable order", () => {
  const files = Array.from({ length: 5000 }, (_, index) => fileAt(`study/session-${5000 - index}/eeg.edf`));
  const companions = Array.from({ length: 50 }, (_, index) => fileAt(`study/metadata-${index}.json`));
  const plan = planDirectoryImport([...files, ...companions], "edf");
  assert.equal(plan.recordings.length, 5000);
  assert.equal(plan.recordings[0].relativePath, "study/session-1/eeg.edf");
  assert.equal(plan.recordings.at(-1).relativePath, "study/session-5000/eeg.edf");
  assert.equal(plan.recordings.reduce((count, entry) => count + entry.files.length, plan.supportingFiles.length), files.length + companions.length);
});

test("opening a session includes same-folder and ancestor companions only", () => {
  const primary = fileAt("study/day-10/eeg.edf");
  const ancestor = fileAt("study/metadata.json");
  const same = fileAt("study/day-10/eeg_channels.tsv");
  const sibling = fileAt("study/day-1/eeg_channels.tsv");
  const descendant = fileAt("study/day-10/other/metadata.json");
  const otherRecording = fileAt("study/day-1/eeg.edf");
  const plan = planDirectoryImport([primary, ancestor, same, sibling, descendant, otherRecording], "edf");
  const recording = plan.recordings.find((entry) => entry.primary === primary);
  assert.deepEqual(directoryRecordingFiles(plan, recording), [primary, same, ancestor]);
  assert.deepEqual(recording.files, [primary], "Opening must not mutate catalog entries.");
  assert.equal(plan.supportingFiles.length, 4, "Excluded companions remain catalogued for their own sessions.");
});

test("companion scope handles case and slash differences without sibling prefix matches", () => {
  const mat = fileAt("STUDY/Day-1/eeg.mat");
  const dat = fileAt("STUDY/Day-1/eeg.dat");
  const sibling = fileAt("study/day-10/eeg_events.tsv");
  const same = fileAt("study\\day-1\\eeg_events.tsv");
  const ancestor = fileAt("study/metadata.json");
  const plan = planDirectoryImport([mat, dat, sibling, same, ancestor], "mat-dat");
  const files = directoryRecordingFiles(plan, plan.recordings[0]);
  assert.deepEqual(files, [mat, dat, same, ancestor]);
});

test("identical session basenames in different folders cannot exchange channels or events", async () => {
  const primaryA = fileAt("study/day-1/eeg.edf");
  const primaryB = fileAt("study/day-2/eeg.edf");
  const files = [
    primaryA, primaryB,
    textFileAt("study/metadata.json", JSON.stringify({ SharedStudyField: "inherited" })),
    textFileAt("study/day-1/eeg_channels.tsv", "name\ttype\nCHANNEL_A\tEEG\n"),
    textFileAt("study/day-2/eeg_channels.tsv", "name\ttype\nCHANNEL_B\tEEG\n"),
    textFileAt("study/day-1/eeg_events.tsv", "onset\tduration\ttrial_type\n1\t0\tEVENT_A\n"),
    textFileAt("study/day-2/eeg_events.tsv", "onset\tduration\ttrial_type\n2\t0\tEVENT_B\n"),
  ];
  const plan = planDirectoryImport(files, "edf");
  for (const [index, expected] of ["A", "B"].entries()) {
    const recording = plan.recordings[index];
    const bundle = await analyzeBidsCompanions(directoryRecordingFiles(plan, recording), {
      recordingFile: recording.primary,
      channelCount: 1,
    });
    assert.deepEqual(bundle.channels.map((channel) => channel.name), [`CHANNEL_${expected}`]);
    assert.deepEqual(bundle.events.map((event) => event.label), [`EVENT_${expected}`]);
    assert.equal(bundle.metadata.SharedStudyField, "inherited");
  }
});

test("non-BIDS sidecars in a shared folder require exact recording basenames", async () => {
  const primaryA = fileAt("study/a.edf");
  const primaryB = fileAt("study/ab.edf");
  const files = [primaryA, primaryB];
  for (const name of ["a", "ab"]) {
    files.push(
      textFileAt(`study/${name}.json`, JSON.stringify({ exactName: name })),
      textFileAt(`study/${name}_channels.tsv`, `name\ttype\nCHANNEL_${name}\tEEG\n`),
      textFileAt(`study/${name}_events.tsv`, `onset\tduration\ttrial_type\n1\t0\tEVENT_${name}\n`),
      textFileAt(`study/${name}_electrodes.tsv`, `name\tx\ty\tz\nCHANNEL_${name}\t0\t0\t0\n`),
    );
  }
  const plan = planDirectoryImport(files, "edf");
  for (const recording of plan.recordings) {
    const name = recording.primary.name.replace(".edf", "");
    const selected = directoryRecordingFiles(plan, recording);
    assert.equal(selected.length, 5);
    assert.ok(selected.some((file) => file.name === `${name}.json`));
    const bundle = await analyzeBidsCompanions(selected, { recordingFile: recording.primary, channelCount: 1 });
    assert.deepEqual(bundle.channels.map((channel) => channel.name), [`CHANNEL_${name}`]);
    assert.deepEqual(bundle.events.map((event) => event.label), [`EVENT_${name}`]);
    assert.equal(bundle.tables.find((table) => table.kind === "electrodes").path, `study/${name}_electrodes.tsv`);
  }
});

test("BIDS inheritance requires all sidecar entities to exist and match", async () => {
  const primary = fileAt("study/sub-01/sub-01_task-rest_eeg.edf");
  const inherited = textFileAt("study/task-rest_events.tsv", "onset\tduration\ttrial_type\n1\t0\tMATCHED\n");
  const missingRun = textFileAt("study/sub-01/sub-01_task-rest_run-2_events.tsv", "onset\tduration\ttrial_type\n2\t0\tWRONG_RUN\n");
  const wrongSubject = textFileAt("study/sub-01/sub-02_task-rest_events.tsv", "onset\tduration\ttrial_type\n2\t0\tWRONG_SUBJECT\n");
  const invalidPrefix = textFileAt("study/sub-01/other_sub-01_events.tsv", "onset\tduration\ttrial_type\n2\t0\tWRONG_PREFIX\n");
  const matchingJson = textFileAt("study/task-rest_eeg.json", JSON.stringify({ TaskName: "Rest" }));
  const wrongTaskJson = textFileAt("study/task-other_eeg.json", JSON.stringify({ TaskName: "Wrong" }));
  const participants = textFileAt("study/participants.tsv", "participant_id\tage\nsub-01\t32\n");
  const plan = planDirectoryImport([primary, inherited, missingRun, wrongSubject, invalidPrefix, matchingJson, wrongTaskJson, participants], "edf");
  const selected = directoryRecordingFiles(plan, plan.recordings[0]);
  assert.deepEqual(new Set(selected), new Set([primary, inherited, matchingJson, participants]));
  const bundle = await analyzeBidsCompanions(selected, { recordingFile: primary });
  assert.deepEqual(bundle.events.map((event) => event.label), ["MATCHED"]);
  assert.equal(bundle.metadata.TaskName, "Rest");
  assert.equal(bundle.metadata.age, "32");
});

test("non-BIDS EEG stems match their own sidecars without applying another modality", () => {
  const primary = fileAt("study/a_eeg.edf");
  const events = fileAt("study/a_events.tsv");
  const named = fileAt("study/a_eeg.json");
  const shared = fileAt("study/eeg.json");
  const wrongNamed = fileAt("study/a_ieeg.json");
  const wrongShared = fileAt("study/ieeg.json");
  const plan = planDirectoryImport([primary, events, named, shared, wrongNamed, wrongShared], "edf");
  assert.deepEqual(new Set(directoryRecordingFiles(plan, plan.recordings[0])), new Set([primary, events, named, shared]));
});

test("unqualified events and channels are omitted when multiple sessions share a folder", async () => {
  const primaryA = fileAt("study/a.edf");
  const primaryB = fileAt("study/b.edf");
  const events = textFileAt("study/events.tsv", "onset\tduration\ttrial_type\n1\t0\tAMBIGUOUS\n");
  const channels = textFileAt("study/channels.tsv", "name\ttype\nAMBIGUOUS\tEEG\n");
  const plan = planDirectoryImport([primaryA, primaryB, events, channels], "edf");
  for (const recording of plan.recordings) {
    const selected = directoryRecordingFiles(plan, recording);
    assert.deepEqual(selected, [recording.primary]);
    const bundle = await analyzeBidsCompanions(selected, { recordingFile: recording.primary });
    assert.equal(bundle.events.length, 0);
    assert.equal(bundle.channels.length, 0);
  }
  assert.equal(plan.supportingFiles.length, 2, "Ambiguous files are retained, not discarded from the catalog.");
  const single = planDirectoryImport([primaryA, events, channels], "edf");
  assert.deepEqual(new Set(directoryRecordingFiles(single, single.recordings[0])), new Set([primaryA, events, channels]));
});

test("unstructured named and bare sidecars are not guessed from ancestor folders", () => {
  const primary = fileAt("study/day-1/a.edf");
  const files = [primary, fileAt("study/a_events.tsv"), fileAt("study/events.tsv"), fileAt("study/a.json"), fileAt("study/metadata.json")];
  const plan = planDirectoryImport(files, "edf");
  assert.deepEqual(directoryRecordingFiles(plan, plan.recordings[0]), [primary, files.at(-1)]);
});

test("overlapping non-BIDS stems do not make one sidecar belong to multiple recordings", () => {
  const a = fileAt("study/a.edf");
  const eeg = fileAt("study/a_eeg.edf");
  const ieeg = fileAt("study/a_ieeg.edf");
  const events = fileAt("study/a_events.tsv");
  const exact = fileAt("study/a_eeg.json");
  const plan = planDirectoryImport([a, eeg, ieeg, events, exact], "edf");
  for (const recording of plan.recordings) {
    const selected = directoryRecordingFiles(plan, recording);
    assert.equal(selected.includes(events), recording.primary === a);
    assert.equal(selected.includes(exact), recording.primary === eeg);
  }
  const ambiguous = planDirectoryImport([eeg, ieeg, events], "edf");
  for (const recording of ambiguous.recordings) {
    assert.ok(!directoryRecordingFiles(ambiguous, recording).includes(events));
  }
});
