/*
Purpose: Checks recording labels csv behavior with deterministic fixtures and controlled runtime boundaries.
File Dependencies: app/recording-labels-csv.ts.
*/


import assert from "node:assert/strict";
import test from "node:test";
import { serializeRecordingLabels } from "../app/recording-labels-csv.ts";

const label = {
  id: "one", labelId: "clinical", start: 1, end: 2, track: "instance", confidence: 80,
  status: "draft", origin: "manual", reviewer: "R017", notes: "", updatedAt: "2026-11-16T20:00:00.000Z",
};

test("exports raw and reviewer labels from multiple recordings with one source column", () => {
  const csv = serializeRecordingLabels([
    { recording: "a/session.edf", annotations: [
      { ...label, id: "edf-1", labelId: "recording-label", origin: "imported", recordingLabel: { label: "Stimulation" } },
      { ...label, id: "bids-1", origin: "imported", sourceLabel: 'Press, "left"' },
      { ...label, id: "edited-1", origin: "imported", candidateId: "source-candidate", status: "committed" },
    ] },
    { recording: "b/session.mat", annotations: [
      { ...label, id: "manual-1" }, { ...label, id: "older-1", origin: "legacy" },
    ] },
  ], (annotation) => annotation.recordingLabel?.label ?? "Clinical event");
  const [header, ...rows] = csv.trimEnd().split("\r\n");
  assert.equal(header.split(",").filter((name) => name === "label_source").length, 1);
  assert.equal(rows.length, 5);
  assert.match(rows[0], /^a\/session\.edf,edf-1,Stimulation,.*?,imported,detected,/);
  assert.match(rows[1], /,"Press, ""left""",.*?,imported,detected,/);
  assert.match(rows[2], /,committed,imported,reviewer,/);
  assert.match(rows[3], /^b\/session\.mat,manual-1,.*?,draft,manual,reviewer,/);
  assert.match(rows[4], /,legacy,legacy,/);
});

test("a recording with no labels still has a usable CSV header", () => {
  const csv = serializeRecordingLabels([{ recording: "empty.edf", annotations: [] }], () => "");
  assert.match(csv, /^recording,annotation_id,label,.*label_source,.*\r\n$/);
});

test("manual labels created before ID entry receive the active reviewer in CSV", () => {
  const csv = serializeRecordingLabels([{ recording: "test.edf", reviewer: "R017", annotations: [
    { ...label, reviewer: "" }, { ...label, id: "original", reviewer: "", origin: "imported" },
    { ...label, id: "owned", reviewer: "R018" },
  ] }], () => "Marker");
  const rows = csv.trimEnd().split("\r\n");
  assert.match(rows[1], /,reviewer,R017,/);
  assert.match(rows[2], /,detected,,/);
  assert.match(rows[3], /,reviewer,R018,/);
});

test("portable CSV retains unlabeled recording references and round-trips full annotation data", async () => {
  const { parseRecordingLabelsCsv } = await import("../app/recording-labels-csv.ts");
  const source = { ...label, dictionaryLabel: { id: "dict-1", name: "Ambiguous, marker", code: "AM", description: "A note" },
    notes: "Line one\nLine two", recordingLabel: undefined };
  const csv = serializeRecordingLabels([
    { recording: "study/session.edf", reviewer: "R017", sourcePath: "/data/study/session.edf", format: "edf",
      files: [{ name: "session.edf", path: "/data/study/session.edf", size: 32 }], reviewSessionId: 4, annotations: [source],
      candidates: [{ id: "event", time: 2, status: "skipped" }], recordingLabelsImported: true },
    { recording: "study/empty.edf", reviewer: "R017", annotations: [], format: "edf",
      files: [{ name: "empty.edf", path: "study/empty.edf", size: 16 }], recordingLabelsImported: false },
  ], () => source.dictionaryLabel.name, true);
  const parsed = parseRecordingLabelsCsv(csv);
  assert.equal(parsed.recordings.length, 2);
  assert.deepEqual(parsed.recordings[0].annotations[0], JSON.parse(JSON.stringify(source)));
  assert.equal(parsed.recordings[0].sourcePath, "/data/study/session.edf");
  assert.equal(parsed.recordings[0].recordingLabelsImported, true);
  assert.equal(parsed.recordings[1].annotations.length, 0);
  assert.equal(parsed.recordings[1].recordingLabelsImported, false);
  assert.equal(parsed.reviewSessionId, 4);
});

test("paths use absolute information only when the host or recording mapping supplies it", async () => {
  const { recordingSourcePath } = await import("../app/recording-labels-csv.ts");
  const file = new File([], "source.dat");
  assert.equal(recordingSourcePath(file), "source.dat");
  assert.equal(recordingSourcePath(file, { data_dir_hint: "/data/study" }), "/data/study/source.dat");
  Object.defineProperty(file, "path", { value: "/actual/source.dat" });
  assert.equal(recordingSourcePath(file), "/actual/source.dat");
});
