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
