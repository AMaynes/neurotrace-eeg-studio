import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { detectRecordingChannelModality } from "../app/bids-companions.ts";
import {
  MATLAB_ANNOTATION_COLUMNS, matlabAnnotationRows, matlabCsvNumber, formatMatlabTimestamp,
  serializeMatlabAnnotations, parseMatlabAnnotations, mergeMatlabAnnotationRows,
  matlabAnnotationFilename, writeMatlabAnnotations, MatlabReviewCsvCache,
} from "../app/matlab-annotations-csv.ts";

// Transcribed from savedT.VariableNames in the supplied MATLAB viewer, not the exporter.
const header = "mat_path,data_dir,dat_file,event_label,event_time_original_sec,onset_offset_sec,onset_time_adjusted_sec,offset_offset_sec,offset_time_adjusted_sec,sampling_rate,n_channels,bad_channels,review_timestamp,accepted";
const reviewedAt = new Date(2026, 9, 30, 9, 4, 5).toISOString();
function input() {
  return {
    meta: { name: "session.dat", sampleRates: Array(128).fill(1000), channelLabels: Array.from({ length: 128 }, (_, n) => `A${n + 1}`) },
    sourceInterpretation: { companion_mat_path: "C:\\study\\patient\\session.mat", data_dir_hint: "C:\\study\\patient", dat_file_base: "session" },
    candidates: [{ id: "event-1", time: 100, label: 'Sz, "left"', status: "reviewed", badChannels: "  A1, A7  ", ictalChannels: "B1-B4", reviewedAt }],
    annotations: [{ candidateId: "event-1", labelId: "ictal", status: "committed", start: 98.125, end: 104.75, updatedAt: reviewedAt }],
  };
}
const row = () => matlabAnnotationRows(input())[0];

test("CSV matches the supplied MATLAB schema, order, quoting, timestamps and accepted flag", () => {
  assert.equal(MATLAB_ANNOTATION_COLUMNS.join(","), header);
  assert.equal(serializeMatlabAnnotations([row()]), header + '\r\nC:\\study\\patient\\session.mat,C:\\study\\patient,session,"Sz, ""left""",100,-1.875,98.125,4.75,104.75,1000,128,"A1, A7",2026-10-30 09:04:05,1\r\n');
  assert.equal(serializeMatlabAnnotations([]), header + "\r\n");
  assert.equal(matlabAnnotationFilename("Patient One", "AM"), "Patient_One_AM_annotations.csv");
});

test("only accepted source-linked seizure intervals are exported; skipped/draft/manual/other labels stay out", () => {
  const data = input();
  for (const status of ["skipped", "queued", "active", "conflict"]) {
    data.candidates.push({ ...data.candidates[0], id: status, status });
    data.annotations.push({ ...data.annotations[0], candidateId: status });
  }
  data.annotations.push({ ...data.annotations[0], candidateId: undefined });
  assert.equal(matlabAnnotationRows(data).length, 1);
  data.annotations[0].status = "draft";
  assert.equal(matlabAnnotationRows(data).length, 0);
  data.annotations[0].status = "committed";
  data.annotations[0].labelId = "artifact";
  assert.equal(matlabAnnotationRows(data).length, 0);
});

test("bad channels are independent free text; source fs/count and submicrosecond timing are retained", () => {
  const data = input();
  delete data.candidates[0].badChannels;
  data.annotations[0].start = 98.1234567890123;
  const saved = matlabAnnotationRows(data)[0];
  assert.equal(saved.bad_channels, "");
  assert.equal(saved.n_channels, 128);
  assert.equal(saved.sampling_rate, 1000);
  const parsed = parseMatlabAnnotations(serializeMatlabAnnotations([saved]))[0];
  assert.equal(parsed.onset_time_adjusted_sec, "98.1234567890123");
  assert.ok(Math.abs(Number(parsed.onset_offset_sec) - (data.annotations[0].start - 100)) < 1e-13);
});

test("numeric writing follows long-g conventions, including scientific notation and rollover", () => {
  const cases = [[0, "0"], [-0, "0"], [1, "1"], [.0001, "0.0001"], [.00001, "1e-05"],
    [Math.PI, "3.14159265358979"], [1e15, "1e+15"], [1e14, "100000000000000"],
    [9.999999999999999e14, "1e+15"], [-1.234567890123456e-7, "-1.23456789012346e-07"]];
  for (const [number, expected] of cases) assert.equal(matlabCsvNumber(number), expected);
  for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => matlabCsvNumber(value));
  assert.equal(formatMatlabTimestamp(reviewedAt), "2026-10-30 09:04:05");
});

test("CSV resaving parses embedded newlines/quotes/unicode and preserves previous rows", async () => {
  const previous = { ...row(), event_label: 'sz\n左 "A"', event_time_original_sec: 25 };
  const changed = { ...row(), bad_channels: "A4" };
  let contents = serializeMatlabAnnotations([previous, row()]);
  const log = [];
  const handle = {
    async getFile() { log.push("read"); return new Blob([contents]); },
    async createWritable() { log.push("open"); return {
      async write(blob) { log.push("write"); contents = await blob.text(); },
      async close() { log.push("close"); },
    }; },
  };
  assert.equal(await writeMatlabAnnotations(handle, [changed]), 2);
  assert.deepEqual(log, ["read", "open", "write", "close"]);
  const saved = parseMatlabAnnotations(contents);
  assert.equal(saved[0].event_label, previous.event_label);
  assert.equal(saved[1].bad_channels, "A4");
  assert.equal(saved[0].event_time_original_sec, "25");
  assert.deepEqual(parseMatlabAnnotations("\uFEFF" + contents.replaceAll("\r\n", "\n")), saved);
});

test("invalid existing files are never truncated and write failures abort", async () => {
  for (const contents of ["other,format\n1,2", `${header}\nnot,enough`, `${header}\n"unterminated`, `${header}\n"x"junk`]) {
    let opened = false;
    await assert.rejects(writeMatlabAnnotations({ getFile: async () => new Blob([contents]), createWritable: async () => { opened = true; } }, [row()]));
    assert.equal(opened, false);
  }
  let aborted = false;
  await assert.rejects(writeMatlabAnnotations({ getFile: async () => new Blob(), createWritable: async () => ({
    write: async () => { throw Error("disk full"); }, close: async () => assert.fail("must not close"), abort: async () => { aborted = true; },
  }) }, [row()]), /disk full/);
  assert.equal(aborted, true);
});

test("invalid timing/rates fail rather than silently creating misleading MATLAB values", () => {
  for (const patch of [{ sampling_rate: "" }, { sampling_rate: 0 }, { n_channels: 0 }, { onset_time_adjusted_sec: Infinity }, { accepted: 0 }, { review_timestamp: "" }]) {
    assert.throws(() => serializeMatlabAnnotations([{ ...row(), ...patch }]));
  }
  const data = input(); data.meta.sampleRates[0] = 200;
  assert.throws(() => serializeMatlabAnnotations(matlabAnnotationRows(data)), /one source sampling rate/);
});

test("upserts use MATLAB path plus six-decimal event key, keeping other sessions and times", () => {
  const otherSession = { ...row(), mat_path: "C:\\study\\second.mat" };
  const sameKey = { ...row(), event_time_original_sec: 100.0000001, bad_channels: "A3" };
  const merged = mergeMatlabAnnotationRows([row(), otherSession], [sameKey]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].bad_channels, "A3");
  assert.equal(merged[1].mat_path, otherSession.mat_path);
});

test("directory rows survive closing a session, update on revision and remain isolated by directory", () => {
  const cache = new MatlabReviewCsvCache();
  cache.update("session-1", "dir-1", [row()]);
  cache.update("session-2", "dir-1", [{ ...row(), mat_path: "second.mat" }]);
  cache.update("session-1", "dir-2", [{ ...row(), mat_path: "unrelated.mat" }]);
  assert.equal(cache.rows("dir-1").length, 2);
  cache.update("session-2", "dir-1", []);
  assert.equal(cache.rows("dir-1").length, 1);
  assert.equal(cache.rows("dir-2")[0].mat_path, "unrelated.mat");
});

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const variables = new Map(), functions = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) variables.set(node.name.text, node.initializer);
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
  ts.forEachChild(node, visit);
}
visit(ast);
function evaluate(code, expression, env) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(...Object.keys(env), `${js}\nreturn ${expression};`)(...Object.values(env));
}

test("production Save opens a CSV picker and writes the exact contract; fallback downloads CSV only", async () => {
  for (const supportsPicker of [true, false]) {
    let written, filename, options;
    const actions = [], errors = [];
    const env = { projectSaveBusy: false, hasRecording: true, sourceVerificationRef: { current: false }, importBusyRef: { current: false },
      setProjectSaveError: (message) => errors.push(message), reviewer: "AM", meta: {}, setProjectSaveBusy() {},
      collectCsvRows: () => [row()], serializeMatlabAnnotations, writeMatlabAnnotations, csvFileName: "Patient_AM_annotations.csv",
      setShowProjectSave() {}, setToast() {}, notifyTutorialAction: (action) => actions.push(action),
      downloadBlob: (name, blob) => { filename = name; written = blob; },
      window: supportsPicker ? { showSaveFilePicker: async (args) => { options = args; return {
        getFile: async () => new Blob(), createWritable: async () => ({ write: async (blob) => { written = blob; }, close: async () => {} }),
      }; } } : {},
    };
    const save = evaluate(`const save = ${variables.get("saveAnnotationsCsv").getText(ast)};`, "save", env);
    await save();
    assert.deepEqual(errors, [""]);
    assert.deepEqual(actions, ["annotations-saved"]);
    assert.equal(await written.text(), serializeMatlabAnnotations([row()]));
    if (supportsPicker) assert.deepEqual(options.types[0].accept, { "text/csv": [".csv"] });
    else assert.equal(filename, "Patient_AM_annotations.csv");
  }
});

test("production directory save gathers closed, open and active reviews without stale active snapshots", () => {
  const cache = new MatlabReviewCsvCache();
  cache.update("closed", "directory", [{ ...row(), mat_path: "closed.mat" }]);
  const open = { ...input(), hasRecording: true, sessionKey: "open", sourceInterpretation: { companion_mat_path: "open.mat" } };
  const data = input(); data.candidates[0].badChannels = "LATEST";
  const collect = evaluate(`const collect = ${variables.get("collectCsvRows").getText(ast)};`, "collect", {
    ...data, csvDirectoryId: "directory", sessionKey: "active", activeSessionId: "active-tab", primaryFile: null,
    sessionTabs: [{ id: "open-tab", directoryId: "directory" }, { id: "active-tab", directoryId: "directory" }, { id: "unrelated-tab", directoryId: "other" }],
    sessionSnapshotsRef: { current: new Map([["open-tab", open], ["active-tab", open]]) }, matlabCsvCacheRef: { current: cache }, matlabAnnotationRows,
  });
  const rows = collect();
  assert.equal(rows.length, 3);
  assert.equal(rows[2].bad_channels, "LATEST");
});

test("production Save cancellation and disk errors never emit success or close the dialog", async () => {
  for (const error of [new DOMException("Canceled", "AbortError"), new Error("disk full")]) {
    const errors = [], busy = [];
    const save = evaluate(`const save = ${variables.get("saveAnnotationsCsv").getText(ast)};`, "save", {
      projectSaveBusy: false, hasRecording: true, sourceVerificationRef: { current: false }, importBusyRef: { current: false },
      setProjectSaveError: (message) => errors.push(message), reviewer: "AM", meta: {}, setProjectSaveBusy: (value) => busy.push(value),
      collectCsvRows: () => [row()], serializeMatlabAnnotations, csvFileName: "patient_AM_annotations.csv",
      window: { showSaveFilePicker: async () => { throw error; } },
      setShowProjectSave: () => assert.fail("must stay open"), setToast() {}, notifyTutorialAction: () => assert.fail("must not emit success"),
    });
    await save();
    assert.deepEqual(busy, [true, false]);
    assert.deepEqual(errors, error.name === "AbortError" ? [""] : ["", "disk full"]);
  }
});

test("bad-channel notes survive real local-recovery migration and queue reconciliation", () => {
  const funcs = ["migrateCandidateList", "reconcileCandidateQueue"].map((name) => functions.get(name).getText(ast)).join("\n");
  const { migrateCandidateList, reconcileCandidateQueue } = evaluate(funcs, "({ migrateCandidateList, reconcileCandidateQueue })", { clamp: (x, a, b) => Math.max(a, Math.min(b, x)) });
  const candidate = { ...input().candidates[0], source: "gold", confidence: 100 };
  const migrated = migrateCandidateList(JSON.parse(JSON.stringify([candidate])), 200);
  assert.equal(migrated[0].badChannels, "  A1, A7  ");
  const restored = reconcileCandidateQueue([{ ...candidate, badChannels: "" }], migrated, 0);
  assert.equal(restored.candidates[0].badChannels, "  A1, A7  ");
});

test("model-ready export retains mixed-rate reviews and lists only the files it can represent", () => {
  for (const mixed of [false, true]) {
    const data = input();
    Object.assign(data.meta, { id: "review", format: "edf+", durationSec: 200, channelUnits: Array(128).fill("µV") });
    if (mixed) data.meta.sampleRates[127] = 200;
    Object.assign(data.annotations[0], { id: "accepted", geometry: "interval", track: "instance", confidence: 100,
      channels: [0], origin: "manual", reviewer: "AM", notes: "Accepted review", channelScope: { primarySourceIndex: 0, sourceIndices: [0], montage: "referential" } });
    let files, downloaded, toast;
    const env = { ...data, sourceVerificationRef: { current: false }, companionBundle: { channels: [] },
      primaryFile: null, sourceHash: "local-v1:test", rawSourceHash: "", recordingType: "EEG", montage: "referential",
      filters: {}, gain: 1, snapMode: "none", traceDisplayMode: "clamped",
      detectRecordingChannelModality, matlabAnnotationRows, serializeMatlabAnnotations,
      createStoredZip: (entries) => { files = new Map(entries.map(({ name, content }) => [name.replace("review/", ""), content])); return "archive"; },
      downloadBlob: (name, blob) => { downloaded = [name, blob]; }, setToast: (message) => { toast = message; },
    };
    const helpers = ["primarySampleRate", "patientLabel", "recordingLabel", "annotationLabel", "annotationGeometry",
      "annotationOverlapsWindow", "tsvCell", "csvCell"].map((name) => functions.get(name).getText(ast)).join("\n");
    const code = `const LABELS = ${variables.get("LABELS").getText(ast)};\nconst LABEL_BY_ID = new Map(LABELS.map(label => [label.id, label]));\n${helpers}\nconst run = ${variables.get("exportBundle").getText(ast)};`;
    evaluate(code, "run", env)();
    assert.deepEqual(downloaded, ["review_model_ready.zip", "archive"], toast);
    assert.match(files.get("events.tsv"), /accepted\t98\.125000/);
    const [candidateHeader, candidateValues] = files.get("candidate_events.tsv").split("\n").map(line => line.split("\t"));
    assert.equal(candidateValues[candidateHeader.indexOf("bad_channels")], "  A1, A7  ");
    const annotation = JSON.parse(files.get("annotations.jsonl"));
    assert.equal(annotation.start_sample, 98125);
    assert.equal(annotation.sample_rate_basis_hz, 1000);
    assert.equal(JSON.parse(files.get("recording.json")).sampling_frequency, mixed ? null : 1000);
    const manifest = JSON.parse(files.get("manifest.json"));
    assert.equal(manifest.files.includes("matlab_compatibility.csv"), !mixed);
    assert.equal(files.has("matlab_compatibility.csv"), !mixed);
    assert.ok(manifest.files.every(name => files.has(name)));
    if (mixed) {
      assert.match(files.get("README.txt"), /omitted because the source has multiple sampling rates/);
      assert.match(toast, /MATLAB CSV omitted/);
    } else assert.equal(parseMatlabAnnotations(files.get("matlab_compatibility.csv")).length, 1);
  }
});
