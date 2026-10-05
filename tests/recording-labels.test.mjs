import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { decodeMatRecordingLabels, edfRecordingLabels, mergeRecordingLabels, recordingLabelAnnotations, validRecordingLabel } from "../app/recording-labels.ts";
import { inspectMatRecording, parseLegacyMatMetadata, RawDatSource } from "../app/eeg-core.ts";
import { resolveMatDatImport } from "../app/mat-import.ts";
import { createNeurotraceProjectArchive, readNeurotraceProjectArchive } from "../app/neurotrace-project.ts";
import { matWriter, standaloneMatFile } from "./fixtures/legacy-mat.mjs";

function eventFixture({ littleEndian = true, compressed = false, standalone = false } = {}) {
  const w = matWriter(littleEndian);
  const group = (label, values, dimensions, extra = {}) => ({
    label: w.string(label), times: w.numeric(values, { dimensions }),
    channels: extra.channels ?? w.cell([]), notes: extra.notes ?? w.cell([]), epochs: extra.epochs ?? w.numeric([]),
  });
  return w.file([w.struct("sessionInfo", [{
    sFile: w.struct("", [{
      header: w.struct("", [{ num_channels: w.numeric([2]), sample_rate: w.numeric([10]) }]),
      events: w.struct("", [
        group("Button push", [1, 3, 7], [1, 3], {
          channels: w.cell([w.cell([w.string("SYN1")]), w.cell([w.string("SYN2")]), w.cell([])]),
          notes: w.cell([w.string("first note"), w.string("second note"), w.string("")]),
        }),
        group("Seizure marker", [2, 4, 8, 11], [2, 2]),
        group("Unknown custom text <test>", [5], [1, 1], {
          channels: w.cell([w.cell([w.string("SYN1"), w.string("SYN2")])]),
          notes: w.cell([w.string("single-cell note")]),
        }),
      ]),
    }]),
    ChannelMat: w.struct("", [{ Channel: w.struct("", [{ Name: w.string("SYN1") }, { Name: w.string("SYN2") }]) }]),
    ...(standalone ? { waveform: w.numeric(Array.from({ length: 200 }, (_, index) => index), { dimensions: [2, 100] }) } : {}),
  }]), ...(standalone ? [w.numeric([10], { name: "Fs" })] : [])], "labels.mat", { compressed });
}

test("MAT metadata detects every point/interval, preserving notes and channel cells in both endian formats", async () => {
  for (const compressed of [false, true]) for (const littleEndian of [false, true]) {
    const metadata = await parseLegacyMatMetadata(eventFixture({ compressed, littleEndian }));
    assert.deepEqual(metadata.recordingLabels.map(({ label, timeSec, durationSec }) => [label, timeSec, durationSec]), [
      ["Button push", 1, 0], ["Button push", 3, 0], ["Button push", 7, 0],
      ["Seizure marker", 2, 2], ["Seizure marker", 8, 3], ["Unknown custom text <test>", 5, 0],
    ]);
    assert.deepEqual(metadata.recordingLabels[0].channels, ["SYN1"]);
    assert.deepEqual(metadata.recordingLabels[1].channels, ["SYN2"]);
    assert.equal(metadata.recordingLabels[1].notes, "second note");
    assert.deepEqual(metadata.recordingLabels[5].channels, ["SYN1", "SYN2"]);
    assert.equal(metadata.recordingLabels[5].notes, "single-cell note");
    assert.deepEqual(metadata.warnings, []);
    assert.deepEqual(metadata.events.map(({ timeSec }) => timeSec), [1, 2, 5], "existing MATLAB queue identities retain the original first occurrence");
  }
});

test("two-element row vectors are two markers, not a guessed interval", () => {
  const values = [1, 5];
  const read = (dimensions) => decodeMatRecordingLabels({ groupIndex: 0, label: "mark", dimensions, count: 2, valueAt: (index) => values[index] });
  assert.deepEqual(read([1, 2]).labels.map((label) => label.durationSec), [0, 0]);
  assert.deepEqual(read([2, 1]).labels.map((label) => label.durationSec), [4]);
});

test("invalid markers and unmappable epochs are reported without inventing timing", () => {
  const values = [1, 2, -1, 3, NaN, 4, 8, 7, 9, Infinity, 10, 11];
  const result = decodeMatRecordingLabels({ groupIndex: 4, label: "event", dimensions: [2, 6], count: values.length,
    valueAt: (index) => values[index], epochAt: (index) => index === 5 ? 2 : 1 });
  assert.deepEqual(result.labels.map((label) => label.timeSec), [1]);
  assert.match(result.warnings.join(" "), /4 invalid occurrence/);
  assert.match(result.warnings.join(" "), /1 occurrence.*unmapped epoch/);
  const unsupported = decodeMatRecordingLabels({ groupIndex: 0, label: "event", dimensions: [3, 1], count: 3, valueAt: () => 1 });
  assert.equal(unsupported.labels.length, 0);
  assert.match(unsupported.warnings[0], /unsupported time dimensions/);
});

test("unrelated nested events cannot contaminate sessionInfo.sFile labels", async () => {
  const w = matWriter();
  const event = (label) => w.struct("", [{ label: w.string(label), times: w.numeric([2]) }]);
  const file = w.file([w.struct("sessionInfo", [{
    sFile: w.struct("", [{ events: event("real") }]),
    ChannelMat: w.struct("", [{ events: event("not a recording marker") }]),
  }])], "scope.mat");
  const metadata = await parseLegacyMatMetadata(file);
  assert.deepEqual(metadata.recordingLabels.map((label) => label.label), ["real"]);
  assert.deepEqual(metadata.events.map((label) => label.label), ["real"]);
});

test("absent or empty event groups do not prevent ordinary recording import", async () => {
  const source = await inspectMatRecording(standaloneMatFile());
  assert.equal(source.kind, "standalone");
  assert.deepEqual(source.source.recordingLabels, []);
  const w = matWriter();
  const empty = w.file([w.struct("sessionInfo", [{ sFile: w.struct("", [{
    events: w.struct("", [{ label: w.string("unused"), times: w.numeric([]) }]),
  }]) }])], "empty.mat");
  const metadata = await parseLegacyMatMetadata(empty);
  assert.deepEqual(metadata.recordingLabels, []);
  assert.deepEqual(metadata.events, []);
  assert.match(metadata.warnings.join(" "), /missing a label or finite onset time/, "retain the existing informative legacy warning");
});

test("automatic MAT+DAT import works below 100 channels and preserves exact raw samples", async () => {
  const mat = eventFixture({ compressed: true });
  const bytes = Buffer.alloc(400);
  for (let index = 0; index < 200; index += 1) bytes.writeInt16LE(index - 100, index * 2);
  const dat = new File([bytes], "labels.dat");
  const resolved = await resolveMatDatImport(mat, [mat, dat]);
  const source = await RawDatSource.create(dat, resolved.metadata);
  assert.equal(source.meta.channelCount, 2);
  const imported = recordingLabelAnnotations(source.recordingLabels, source.meta.durationSec, source.meta.channelLabels);
  assert.equal(imported.annotations.length, 6);
  for (const annotation of imported.annotations) {
    assert.equal(annotation.status, "suggestion");
    assert.equal(annotation.origin, "imported");
    assert.equal(annotation.confidence, 0);
    assert.equal(annotation.labelId, "recording-label", "no seizure/artifact diagnosis is inferred from text");
  }
  assert.equal(imported.annotations[4].end, 10, "display is clipped at EOF");
  assert.equal(imported.annotations[4].recordingLabel.durationSec, 3, "source interval remains untouched");
  assert.deepEqual([...((await source.getWindow(0, 0.2, [0])).data[0])], [-100, -98]);
});

test("standalone Level-5 waveforms also expose known embedded session events without rereading the file", async () => {
  const file = eventFixture({ standalone: true });
  const originalRead = file.arrayBuffer.bind(file);
  let reads = 0;
  file.arrayBuffer = () => { reads += 1; return originalRead(); };
  const inspected = await inspectMatRecording(file);
  assert.equal(inspected.kind, "standalone");
  assert.equal(inspected.source.recordingLabels.length, 6);
  assert.equal(reads, 1);
  assert.deepEqual([...(await inspected.source.getWindow(0, 0.2, [1])).data[0]], [1, 3]);
});

test("EDF labels keep custom text and durations with identities independent of other event positions", () => {
  const events = [{ label: "Custom label β", timeSec: 2, durationSec: 3 }, { label: "Button", timeSec: 8 }];
  const labels = edfRecordingLabels(events);
  assert.equal(labels[0].id, edfRecordingLabels([{ label: "Earlier", timeSec: 0 }, ...events])[1].id);
  const imported = recordingLabelAnnotations(labels, 10, []);
  assert.equal(imported.annotations[0].end, 5);
  assert.equal(imported.annotations[0].recordingLabel.label, events[0].label);
  assert.equal(imported.annotations[1].geometry, "point");
  assert.notEqual(edfRecordingLabels([events[0], events[0]])[0].id, edfRecordingLabels([events[0], events[0]])[1].id);
});

test("bounds and ambiguous channel references are explicit, not shifted or silently guessed", () => {
  const labels = edfRecordingLabels([{ label: "outside", timeSec: 10 }, { label: "inside", timeSec: 9, durationSec: 2 }]);
  labels[1].channels = ["SYN1", "MISSING", "SYN2"];
  const result = recordingLabelAnnotations(labels, 10, ["SYN1", "SYN1", "SYN2"]);
  assert.equal(result.annotations.length, 1);
  assert.deepEqual(result.annotations[0].channels, [2]);
  assert.deepEqual(result.annotations[0].recordingLabel.channels, labels[1].channels);
  assert.match(result.warnings.join(" "), /1 recording label.*outside/);
  assert.match(result.warnings.join(" "), /2 recording-label channel reference/);
});

test("recovery preserves edited labels, avoids duplicates, and respects previously deleted source labels", () => {
  const detected = recordingLabelAnnotations(edfRecordingLabels([{ label: "one", timeSec: 1 }, { label: "two", timeSec: 2 }]), 10, []).annotations;
  const edited = { ...detected[0], start: 1.5, end: 1.5, notes: "reviewed note", status: "committed" };
  assert.deepEqual(mergeRecordingLabels([edited], [...detected, detected[0]]), [edited, detected[1]]);
  assert.deepEqual(mergeRecordingLabels([edited], detected, true), [edited], "a saved complete import must not resurrect deletions");
  assert.equal(edited.recordingLabel.timeSec, 1);
});

test("source label evidence and import completion survive a portable project round trip", async () => {
  const annotations = recordingLabelAnnotations(edfRecordingLabels([{ label: "Button", timeSec: 1 }]), 10, []).annotations;
  const review = { annotations, recordingLabelsImported: true };
  const archive = await createNeurotraceProjectArchive({ projectId: "synthetic", title: "Synthetic", appVersion: "test", recording: null, review });
  const restored = await readNeurotraceProjectArchive(new File([archive.blob], archive.fileName));
  assert.deepEqual(restored.review, review);
  assert.ok(validRecordingLabel(restored.review.annotations[0].recordingLabel));
  assert.equal(validRecordingLabel({ ...annotations[0].recordingLabel, channels: [3] }), false);
  assert.equal(validRecordingLabel({ ...annotations[0].recordingLabel, timeSec: Infinity }), false);
  assert.equal(validRecordingLabel({ ...annotations[0].recordingLabel, timeSec: Number.MAX_VALUE, durationSec: Number.MAX_VALUE }), false);
});

test("invalid imported provenance is rejected with an explicit warning", () => {
  const valid = edfRecordingLabels([{ label: "marker", timeSec: 1 }])[0];
  const result = recordingLabelAnnotations([{ ...valid, durationSec: -1 }, { ...valid, timeSec: NaN }, valid], 10, []);
  assert.equal(result.annotations.length, 1);
  assert.match(result.warnings.join(" "), /2 invalid recording label/);
});

test("large repeated-label groups remain complete and deterministic", () => {
  const count = 25000;
  const result = decodeMatRecordingLabels({ groupIndex: 7, label: "marker", dimensions: [1, count], count, valueAt: (index) => index / 10 });
  const annotations = recordingLabelAnnotations(result.labels, count / 10, []);
  assert.equal(annotations.annotations.length, count);
  assert.equal(new Set(annotations.annotations.map((item) => item.id)).size, count);
  assert.equal(annotations.annotations.at(-1).start, 2499.9);
});

test("full MAT parsing handles event groups beyond the engine argument-count limit", async () => {
  const w = matWriter();
  const count = 150000;
  const file = w.file([w.struct("sessionInfo", [{ sFile: w.struct("", [{
    events: w.struct("", [{ label: w.string("trigger"), times: w.numeric(Array.from({ length: count }, (_, index) => index / 100)) }]),
  }]) }])], "dense.mat", { compressed: true });
  const metadata = await parseLegacyMatMetadata(file);
  assert.equal(metadata.recordingLabels.length, count);
  assert.equal(metadata.recordingLabels.at(-1).timeSec, (count - 1) / 100);
});

// Exercise the actual UI migration/navigation code, replacing only React/browser
// boundaries. No browser launch or private recording is needed for these paths.
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name) {
  let result;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(syntax);
    if (ts.isVariableDeclaration(node) && node.name.getText(syntax) === name) result = `const ${node.getText(syntax)};`;
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  assert.ok(result, `${name} exists`);
  return result;
}
function compile(names, scope) {
  const compiled = ts.transpileModule(names.map(declaration).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(scope), `${compiled}\nreturn {${names.join(",")}};`)(...Object.values(scope));
}
const recovery = compile([
  "LABELS", "LABEL_BY_ID", "annotationLabel", "annotationGeometry", "normalizeAnnotationGeometry",
  "migrateAnnotationList", "migrateCandidateList", "hasValidRecoveryBounds", "parseRecoveryProject",
], { validRecordingLabel, clamp: (value, min, max) => Math.min(max, Math.max(min, value)) });

test("actual local recovery retains source evidence, reviewed edits, and completed-import deletions", () => {
  const detected = recordingLabelAnnotations(edfRecordingLabels([
    { label: "Custom marker <β>", timeSec: 1 }, { label: "Custom interval", timeSec: 3, durationSec: 2 },
  ]), 10, []).annotations;
  const edited = { ...detected[0], start: 1.5, end: 1.5, notes: "reviewer note", status: "committed" };
  const restored = recovery.parseRecoveryProject(JSON.stringify({ version: 2, annotations: [edited], recordingLabelsImported: true }), 10, 2);
  assert.equal(restored.recordingLabelsImported, true);
  const merged = mergeRecordingLabels(restored.annotations, detected, restored.recordingLabelsImported);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].start, 1.5);
  assert.equal(merged[0].status, "committed");
  assert.deepEqual(merged[0].recordingLabel, detected[0].recordingLabel);
  assert.equal(recovery.annotationLabel(merged[0]).name, "Custom marker <β>");
  assert.equal(recovery.annotationGeometry(merged[0]), "point");
  const legacy = recovery.parseRecoveryProject(JSON.stringify({ version: 2, annotations: [] }), 10, 2);
  assert.equal(legacy.recordingLabelsImported, false);
  assert.equal(mergeRecordingLabels(legacy.annotations, detected, legacy.recordingLabelsImported).length, 2);
  const interval = recovery.migrateAnnotationList([detected[1]], 10, 2)[0];
  assert.equal(interval.start, 3);
  assert.equal(interval.end, 5);
  assert.equal(recovery.annotationGeometry(interval), "interval");
});

test("actual recovery rejects corrupted source evidence rather than disguising it as a valid label", () => {
  const label = recordingLabelAnnotations(edfRecordingLabels([{ label: "event", timeSec: 1 }]), 10, []).annotations[0];
  for (const recordingLabel of [undefined, null, { ...label.recordingLabel, timeSec: "1" }, { ...label.recordingLabel, source: "unknown" }]) {
    assert.throws(() => recovery.parseRecoveryProject(JSON.stringify({ version: 2, annotations: [{ ...label, recordingLabel }] }), 10, 2), /labels failed validation/);
  }
});

test("filtered queue navigation selects the original annotation without expanding thousands of hidden rows", () => {
  const entries = Array.from({ length: 1000 }, (_, index) => ({
    kind: "annotation", id: `event-${index}`, label: index === 999 ? "Custom target" : "Button",
    detail: "Recording label · imported", status: "suggestion", time: index,
  }));
  const { filteredQueueEntries } = compile(["filteredQueueEntries"], {
    queueSearch: "TARGET imported", instanceQueueEntries: entries, useMemo: (callback) => callback(),
  });
  assert.deepEqual(filteredQueueEntries.map((item) => item.index), [999]);
  let selected, time, limit = 100;
  const { selectInstanceQueueEntry } = compile(["selectInstanceQueueEntry"], {
    filteredQueueEntries, instanceQueueEntries: entries, useCallback: (callback) => callback,
    annotations: [{ id: "event-999", start: 999 }], candidates: [], selectCandidate: () => assert.fail("must select the annotation"),
    setQueueLimit: (update) => { limit = update(limit); }, setSelectedAnnotationId: (id) => { selected = id; },
    setSelectedAnnotationIds: () => {}, setCursorTime: () => {}, setCursorLocked: () => {}, setToast: () => {},
    jumpTo: (value) => { time = value; },
  });
  selectInstanceQueueEntry(filteredQueueEntries[0].index);
  assert.equal(selected, "event-999");
  assert.equal(time, 999);
  assert.equal(limit, 100);
});

test("viewer wiring imports after verification, preserves evidence, and bounds/searches the queue", async () => {
  const load = page.slice(page.indexOf("const loadSource"), page.indexOf("const applyImportedProjectState"));
  assert.ok(load.indexOf("source.applyVerifiedAnnotations") < load.indexOf("recordingLabelAnnotations(detectedRecordingLabels(source)"));
  assert.match(page, /recordingLabels: pendingLegacyMeta\?\.recordingLabels/);
  assert.match(load, /mergeRecordingLabels<Annotation>\(restored, detectedLabels.annotations, recordingLabelsImported\)/);
  assert.match(page, /recordingLabelsImported: snapshot.recordingLabelsImported/);
  assert.ok((page.match(/recordingLabelsImported: recordingLabelsImportedRef.current/g) ?? []).length >= 3);
  assert.match(page, /filteredQueueEntries.slice\(0, queueLimit\)/);
  assert.match(page, /setQueueSearch\(event.target.value\)/);
  assert.match(page, /Original recording label/);
  assert.match(page, /annotationLabel\(item\)\?\.name/);
  assert.match(page, /saved.recordingLabel !== undefined && !validRecordingLabel/);
});
