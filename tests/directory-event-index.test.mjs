/** Anonymous metadata fixtures and deterministic worker boundaries; never opens a browser. */
import assert from "node:assert/strict";
import test from "node:test";
import { matWriter, legacyMatFile } from "./fixtures/legacy-mat.mjs";
import { indexMatRecordingLabels, parseLegacyMatMetadata } from "../app/eeg-core.ts";
import { COMMON_EVENT_KEYWORDS, eventLabelMatches, readDirectoryEventIndex } from "../app/directory-event-index.ts";
import { directoryEventCache, scanDirectoryEvents } from "../app/directory-event-client.ts";
import { planDirectoryImport } from "../app/directory-import.ts";
import { createNeurotraceProjectArchive } from "../app/neurotrace-project.ts";

function eventMat({ little = true, compressed = false, padded = false, waveform = false, nested = false } = {}) {
  const w = matWriter(little);
  const session = w.struct("sessionInfo", [{
    sFile: w.struct("", [{ events: w.struct("", [
      { label: w.string("Seizure onset"), times: w.numeric([1, 5]) },
      { label: w.string("Stim β"), times: w.numeric([2, 4], { dimensions: [2, 1] }) },
    ]) }]),
    unused: w.unset(),
    ...(nested ? { waveform: w.numeric(Array(100000).fill(7), { dimensions: [2, 50000] }) } : {}),
  }]);
  return w.file([...(waveform ? [w.numeric(Array(100000).fill(7), { name: "data", dimensions: [2, 50000] })] : []), session,
    w.numeric([1000], { name: "Fs" })], "session.mat", { compressed, padded });
}

test("keyword matching is case-insensitive literal substring OR, with multiword phrases and no regex interpretation", () => {
  assert.equal(eventLabelMatches(["EEG ONSET", "button"], " EEG onset, artifact "), true);
  assert.equal(eventLabelMatches(["seizure"], "spike, artifact"), false);
  assert.equal(eventLabelMatches(["seizure onset"], "onset seizure"), false);
  assert.equal(eventLabelMatches(["spike"], ".*"), false);
  assert.equal(eventLabelMatches([], " ,  , "), true);
  assert.ok(COMMON_EVENT_KEYWORDS.some((preset) => preset.name === "Seizure" && eventLabelMatches(["SZ onset"], preset.query)));
});

test("selective MAT event reads match the production importer across endian, compression, and padding variants", async () => {
  for (const little of [true, false]) for (const compressed of [true, false]) for (const padded of [true, false]) {
    const file = eventMat({ little, compressed, padded });
    const expected = await parseLegacyMatMetadata(file);
    const result = await indexMatRecordingLabels(file);
    assert.deepEqual(result.warnings, [], JSON.stringify({ little, compressed, padded }));
    assert.deepEqual(result.labels, [...new Set(expected.recordingLabels.map((label) => label.label))]);
  }
});

test("uncompressed top-level and nested waveform arrays are skipped rather than read into memory", async () => {
  for (const nested of [false, true]) {
    const file = eventMat({ waveform: !nested, nested });
    let bytesRequested = 0;
    const slice = file.slice.bind(file);
    file.arrayBuffer = () => { throw new Error("Whole-file read is forbidden"); };
    file.slice = (start = 0, end = file.size) => { bytesRequested += end - start; return slice(start, end); };
    const result = await indexMatRecordingLabels(file);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.labels, ["Seizure onset", "Stim β"]);
    assert.ok(bytesRequested < 10000, `requested only ${bytesRequested} bytes from ${file.size}`);
  }
});

test("compressed waveforms stream through without whole-file buffers, retaining following event metadata", async () => {
  const file = eventMat({ compressed: true, waveform: true, nested: true });
  file.arrayBuffer = () => { throw new Error("Whole-file buffering is forbidden"); };
  const result = await indexMatRecordingLabels(file);
  assert.deepEqual(result, { labels: ["Seizure onset", "Stim β"], warnings: [] });
});

test("MAT empty cells, unrelated event arrays, and malformed/unsupported metadata cannot invent matches", async () => {
  const legacy = await indexMatRecordingLabels(legacyMatFile());
  assert.deepEqual(legacy.labels, ["Synthetic onset", "Synthetic end"]);
  const w = matWriter();
  const unrelated = w.file([w.struct("notes", [{ events: w.struct("", [{ label: w.string("Seizure"), times: w.numeric([1]) }]) }])], "other.mat");
  assert.deepEqual(await indexMatRecordingLabels(unrelated), { labels: [], warnings: [] });
  for (const file of [new File(["broken"], "broken.mat"), new File(["MATLAB 7.3 MAT-file".padEnd(128)], "hdf5.mat"), new File([await eventMat().slice(0, 210).arrayBuffer()], "cut.mat")]) {
    const result = await readDirectoryEventIndex({ format: "mat", file, eventTables: [] });
    assert.equal(result.state, "error");
    assert.ok(result.warnings.length);
  }
});

test("MAT trailing corruption and truncated structures are incomplete checks, not confirmed non-matches", async () => {
  const w = matWriter();
  const valid = eventMat();
  const trailing = new File([valid, new Uint8Array(8), w.numeric([1], { name: "later" })], "partial.mat");
  const partial = await readDirectoryEventIndex({ format: "mat", file: trailing, eventTables: [] });
  assert.equal(partial.state, "partial");
  assert.ok(partial.labels.includes("Seizure onset"));
  assert.match(partial.warnings.join(), /Invalid MAT tag/);
  const keys = Buffer.from("events\0");
  const missingField = w.matrix("sessionInfo", 2, [1, 1], w.tag(5, w.integers([keys.length])), w.tag(1, keys));
  const invalid = await readDirectoryEventIndex({ format: "mat", file: w.file([missingField], "invalid.mat"), eventTables: [] });
  assert.equal(invalid.state, "error");
  assert.match(invalid.warnings.join(), /Incomplete MAT structure/);
});

function edfFile() {
  const header = Buffer.alloc(768, 32);
  const fixed = (offset, width, value) => header.write(String(value).padEnd(width), offset, width, "ascii");
  fixed(0, 8, "0"); fixed(168, 8, "01.01.25"); fixed(176, 8, "00.00.00");
  fixed(184, 8, 768); fixed(192, 44, "EDF+C"); fixed(236, 8, 2); fixed(244, 8, 1); fixed(252, 4, 2);
  let cursor = 256;
  for (const [width, values] of [[16, ["A1", "EDF Annotations"]], [80, ["", ""]], [8, ["uV", ""]],
    [8, [-100, -1]], [8, [100, 1]], [8, [-32768, -32768]], [8, [32767, 32767]], [80, ["", ""]],
    [8, [5000, 64]], [32, ["", ""]]]) for (const value of values) { fixed(cursor, width, value); cursor += width; }
  const parts = [header];
  for (const label of ["Seizure onset", "Button β"]) {
    const annotation = Buffer.alloc(128);
    annotation.write(`+0\x14\x14\0+1\x14${label}\x14\0`, 0, "utf8");
    parts.push(Buffer.alloc(10000), annotation);
  }
  return new File(parts, "synthetic.edf");
}

test("EDF indexing reads only the header and annotation channel ranges, never EEG samples", async () => {
  const file = edfFile();
  const slice = file.slice.bind(file);
  file.arrayBuffer = () => { throw new Error("Full EDF reads are forbidden"); };
  file.slice = (start, end) => {
    assert.ok(end <= 768 || (start === 10768 && end === 10896) || (start === 20896 && end === 21024), `${start}..${end} crossed EEG data`);
    return slice(start, end);
  };
  const result = await readDirectoryEventIndex({ format: "edf", file, eventTables: [] });
  assert.equal(result.state, "ready");
  assert.deepEqual(result.labels, ["Button β", "Seizure onset"]);
});

test("valid sidecar matches survive a failed embedded metadata scan, with explicit partial status", async () => {
  const result = await readDirectoryEventIndex({ format: "mat", file: new File(["bad"], "bad.mat"), eventTables: [
    new File(["onset\tduration\ttrial_type\n1\t2\t\"Button, push\"\n\t1\tIgnore\n"], "bad_events.tsv"),
  ] });
  assert.equal(result.state, "partial");
  assert.deepEqual(result.labels, ["Button, push"]);
  assert.ok(result.warnings.length);
});

test("saved projects index custom display names and source labels without embedded recording bytes", async () => {
  const archive = await createNeurotraceProjectArchive({ projectId: "test", title: "Synthetic", appVersion: "test", recording: null,
    review: { annotations: [{ labelId: "custom", recordingLabel: { label: "Drug given" } }], candidates: [{ label: "Seizure" }] },
    labelDefinitions: { labels: [{ id: "custom", name: "Sleep stage" }] },
  });
  const result = await readDirectoryEventIndex({ format: "neurotrace", file: new File([archive.blob], archive.fileName), eventTables: [] });
  assert.equal(result.state, "ready");
  for (const label of ["custom", "Drug given", "Seizure", "Sleep stage"]) assert.ok(result.labels.includes(label));
});

test("saved projects exclude other sessions' tables and preserve matching tables when embedded metadata fails", async () => {
  const name = "sub-01_task-rest_eeg.mat";
  const archive = await createNeurotraceProjectArchive({ projectId: "scoped", title: "Synthetic", appVersion: "test",
    recording: { name, format: "MAT", byteLength: 3, durationSec: 10, channelCount: 1, sourceContentSha256: "", sessionInterpretationSha256: "" },
    recordingFile: new File(["bad"], name),
    review: { annotations: [{ labelId: "known" }, { unrelated: true }] },
    labelDefinitions: { labels: [{ id: "known", name: "Button" }, { name: "Not an event" }] },
    supportingFiles: [
      new File(["onset\ttrial_type\n1\tSeizure\n"], "sub-01_task-rest_events.tsv"),
      new File(["onset\ttrial_type\n1\tOther session's artifact\n"], "sub-02_task-rest_events.tsv"),
    ],
  });
  const result = await readDirectoryEventIndex({ format: "neurotrace", file: new File([archive.blob], archive.fileName), eventTables: [] });
  assert.equal(result.state, "partial");
  assert.ok(result.labels.includes("Seizure"));
  assert.ok(result.labels.includes("Button"));
  assert.ok(!result.labels.includes("Other session's artifact"));
  assert.ok(!result.labels.includes("Not an event"));
});

test("malformed event tables explicitly remain unchecked while valid sibling tables still match", async () => {
  const w = matWriter();
  const result = await readDirectoryEventIndex({ format: "mat", file: w.file([], "source.mat"), eventTables: [
    new File(["onset\ttrial_type\n\tIgnore\nNaN\tIgnore too\n1\tSpike\n"], "events.tsv"),
    new File(["trial_type\nSeizure\n"], "source_events.tsv"),
  ] });
  assert.equal(result.state, "partial");
  assert.deepEqual(result.labels, ["Spike"]);
  assert.match(result.warnings.join(), /no onset column/);
});

function fileAt(path, content = "") {
  const file = new File([content], path.split("/").at(-1));
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

test("worker scheduler indexes sequentially, chooses only paired MAT metadata, and caches per catalog", async () => {
  const plan = planDirectoryImport([fileAt("a/x.mat"), fileAt("a/x.dat"), fileAt("b/x.mat"), fileAt("b/x.dat"),
    fileAt("a/x_events.tsv"), fileAt("b/x_events.tsv")], "mat-dat");
  const previous = globalThis.Worker;
  const sent = [], workers = [];
  globalThis.Worker = class {
    constructor(url) { assert.match(String(url), /directory-event-worker/); workers.push(this); }
    postMessage(message) { sent.push(message); queueMicrotask(() => this.onmessage({ data: { id: message.id, result: { state: "ready", labels: [message.request.file.webkitRelativePath], warnings: [] } } })); }
    terminate() { this.stopped = true; }
  };
  try {
    const updates = [];
    await scanDirectoryEvents(plan, new AbortController().signal, (id) => updates.push(id));
    assert.equal(workers.length, 1);
    assert.ok(workers[0].stopped);
    assert.deepEqual(sent.map((message) => message.request.file.webkitRelativePath), ["a/x.mat", "b/x.mat"]);
    assert.deepEqual(sent.map((message) => message.request.eventTables.map((file) => file.webkitRelativePath)), [["a/x_events.tsv"], ["b/x_events.tsv"]]);
    assert.deepEqual(updates, [plan.recordings[0].id, plan.recordings[1].id, null]);
    await scanDirectoryEvents(plan, new AbortController().signal, () => {});
    assert.equal(sent.length, 2, "reopening does not reread completed files");
    const other = planDirectoryImport([fileAt("a/x.mat"), fileAt("a/x.dat")], "mat-dat");
    assert.deepEqual(directoryEventCache(other).entries, {}, "a replacement file at the same path gets a fresh cache");
  } finally { if (previous === undefined) delete globalThis.Worker; else globalThis.Worker = previous; }
});

test("canceling a scan terminates it immediately, ignores late results, and resumes only unfinished entries", async () => {
  const plan = planDirectoryImport([fileAt("a.edf"), fileAt("b.edf")], "edf");
  const previous = globalThis.Worker;
  let message;
  const workers = [];
  globalThis.Worker = class { constructor() { workers.push(this); } postMessage(value) { message = value; } terminate() { this.stopped = true; } };
  try {
    const controller = new AbortController();
    const updates = [];
    const promise = scanDirectoryEvents(plan, controller.signal, (id) => updates.push(id));
    assert.equal(message.id, plan.recordings[0].id);
    controller.abort();
    const worker = workers[0];
    worker.onmessage({ data: { id: message.id, result: { state: "ready", labels: ["late"], warnings: [] } } });
    await promise;
    assert.ok(worker.stopped);
    assert.deepEqual(directoryEventCache(plan).entries, {});
    assert.deepEqual(updates, [plan.recordings[0].id]);
    const alreadyCanceled = new AbortController(); alreadyCanceled.abort();
    await scanDirectoryEvents(plan, alreadyCanceled.signal, () => assert.fail("must not start"));
  } finally { if (previous === undefined) delete globalThis.Worker; else globalThis.Worker = previous; }
});

test("unavailable workers report unchecked sessions instead of decoding on the UI thread or claiming no matches", async () => {
  const plan = planDirectoryImport([fileAt("a.edf"), fileAt("b.edf")], "edf");
  const previous = globalThis.Worker;
  delete globalThis.Worker;
  try {
    await scanDirectoryEvents(plan, new AbortController().signal, () => {});
    assert.ok(Object.values(directoryEventCache(plan).entries).every((entry) => entry.state === "error" && entry.warnings.length));
  } finally { if (previous !== undefined) globalThis.Worker = previous; }
});

test("failed checks retry without rereading ready entries, and cancellation before dispatch cannot strand a promise", async () => {
  const plan = planDirectoryImport([fileAt("a.edf"), fileAt("b.edf")], "edf");
  const cache = directoryEventCache(plan);
  cache.entries[plan.recordings[0].id] = { state: "ready", labels: ["Sleep"], warnings: [] };
  cache.entries[plan.recordings[1].id] = { state: "error", labels: [], warnings: ["Failed"] };
  const previous = globalThis.Worker;
  const sent = [];
  globalThis.Worker = class {
    postMessage(message) { sent.push(message.id); queueMicrotask(() => this.onmessage({ data: { id: message.id, result: { state: "ready", labels: ["Seizure"], warnings: [] } } })); }
    terminate() {}
  };
  try {
    const controller = new AbortController();
    await scanDirectoryEvents(plan, controller.signal, () => controller.abort(), true);
    assert.deepEqual(sent, []);
    assert.equal(cache.entries[plan.recordings[1].id].state, "error");
    await scanDirectoryEvents(plan, new AbortController().signal, () => {}, true);
    assert.deepEqual(sent, [plan.recordings[1].id]);
    assert.deepEqual(cache.entries[plan.recordings[0].id].labels, ["Sleep"]);
    assert.equal(cache.entries[plan.recordings[1].id].state, "ready");
  } finally { if (previous === undefined) delete globalThis.Worker; else globalThis.Worker = previous; }
});
