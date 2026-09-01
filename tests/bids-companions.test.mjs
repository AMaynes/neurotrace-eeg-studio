/** Verifies directory discovery, BIDS inheritance, TSV parsing, and additive file selection. */

import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeBidsCompanions,
  classifyUploadedFile,
  detectRecordingChannelModality,
  detectRecordingType,
  mergeSelectedFiles,
  parseTsv,
  relativeFilePath,
} from "../app/bids-companions.ts";

function fixtureFile(path, contents, type = "text/plain", lastModified = 1) {
  const name = path.split("/").at(-1);
  const file = new File([contents], name, { type, lastModified });
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

test("discovers and applies matching BIDS metadata, channels, participant fields, and events", async () => {
  const recording = fixtureFile("study/sub-01/ses-02/eeg/sub-01_ses-02_task-rest_run-1_eeg.edf", new Uint8Array(512));
  const files = [
    recording,
    fixtureFile("study/dataset_description.json", JSON.stringify({ Name: "Resting EEG", BIDSVersion: "1.11.1" }), "application/json"),
    fixtureFile("study/task-rest_eeg.json", JSON.stringify({ TaskName: "Rest", PowerLineFrequency: 60 }), "application/json"),
    fixtureFile("study/sub-01/ses-02/eeg/sub-01_ses-02_task-rest_run-1_eeg.json", JSON.stringify({ EEGReference: "Cz", RecordingType: "continuous" }), "application/json"),
    fixtureFile("study/sub-02/eeg/sub-02_task-rest_eeg.json", JSON.stringify({ TaskName: "Wrong subject" }), "application/json"),
    fixtureFile("study/participants.tsv", "participant_id\tage\tsex\nsub-01\t42\tF\nsub-02\t51\tM\n"),
    fixtureFile("study/sub-01/ses-02/eeg/sub-01_ses-02_task-rest_run-1_channels.tsv", [
      "name\ttype\tunits\tstatus",
      "F3\tEEG\tuV\tgood",
      "F4\tEEG\tuV\tbad",
      "",
    ].join("\n")),
    fixtureFile("study/sub-01/ses-02/eeg/sub-01_ses-02_task-rest_run-1_events.tsv", [
      "onset\tduration\ttrial_type\tdescription\tchannels",
      "10.5\t2\tseizure\tclinical onset\tF3,F4",
      "15\t0\tbutton\tresponse\tn/a",
      "n/a\t1\tinvalid\tskipped\tn/a",
      "",
    ].join("\n")),
  ];

  const bundle = await analyzeBidsCompanions(files, { recordingFile: recording, channelCount: 2 });

  assert.equal(bundle.metadata.Name, "Resting EEG");
  assert.equal(bundle.metadata.TaskName, "Rest");
  assert.equal(bundle.metadata.EEGReference, "Cz");
  assert.equal(bundle.metadata.age, "42");
  assert.equal(bundle.subjectId, "sub-01");
  assert.equal(bundle.sessionId, "ses-02");
  assert.equal(bundle.recordingType, "Scalp EEG");
  assert.deepEqual(bundle.channels.map((channel) => channel.name), ["F3", "F4"]);
  assert.deepEqual(bundle.badChannelIndices, [1]);
  assert.equal(bundle.events.length, 2);
  assert.deepEqual(bundle.events[0].channels, ["F3", "F4"]);
  assert.match(bundle.warnings.join("\n"), /no finite onset/i);
  assert.ok(!bundle.metadataSources.some((path) => path.includes("sub-02")));
  assert.equal(bundle.files.find((file) => file.path.endsWith("_eeg.edf"))?.status, "primary");
  assert.equal(bundle.files.find((file) => file.path.endsWith("_events.tsv"))?.status, "applied");
});

test("detects scalp, intracranial, simultaneous, and unknown recording types from evidence", () => {
  assert.equal(detectRecordingType({ channelLabels: ["Fp1", "Cz", "EKG"] }), "Scalp EEG");
  assert.equal(detectRecordingType({ channelLabels: ["SEEG LA1-REF", "SEEG LA2-REF"] }), "SEEG / iEEG");
  assert.equal(detectRecordingType({ channelLabels: ["Fp1", "LA1", "LA2"] }), "Simultaneous scalp + iEEG");
  assert.equal(detectRecordingType({
    channels: [
      { name: "F3", type: "EEG" },
      { name: "LA1", type: "SEEG" },
    ],
  }), "Simultaneous scalp + iEEG");
  assert.equal(detectRecordingType({ channelLabels: Array.from({ length: 128 }, (_, index) => `CH${index + 1}`) }), "Unknown recording type");
  assert.equal(detectRecordingType({ recordingPath: "sub-01_task-rest_ieeg.edf" }), "SEEG / iEEG");
  assert.equal(detectRecordingChannelModality("ECG", "ECG"), "unknown");
});

test("applies more-specific inherited JSON after task-level metadata", async () => {
  const recording = fixtureFile("sub-03/eeg/sub-03_task-memory_run-2_eeg.edf", new Uint8Array(512));
  const bundle = await analyzeBidsCompanions([
    recording,
    fixtureFile("task-memory_eeg.json", JSON.stringify({ TaskName: "Memory", PowerLineFrequency: 50 })),
    fixtureFile("sub-03/eeg/sub-03_task-memory_run-2_eeg.json", JSON.stringify({ PowerLineFrequency: 60, EEGReference: "average" })),
  ], { recordingFile: recording, channelCount: 0 });

  assert.equal(bundle.metadata.TaskName, "Memory");
  assert.equal(bundle.metadata.PowerLineFrequency, 60);
  assert.equal(bundle.metadata.EEGReference, "average");
  assert.equal(bundle.metadataSources.length, 2);
});

test("TSV parser preserves quoted tabs, doubled quotes, and missing trailing fields", () => {
  const parsed = parseTsv('onset\tdescription\tvalue\n1\t"contains\ta tab"\t"a ""quote"""\n2\tshort\n');
  assert.deepEqual(parsed.columns, ["onset", "description", "value"]);
  assert.deepEqual(parsed.rows, [
    { onset: "1", description: "contains\ta tab", value: 'a "quote"' },
    { onset: "2", description: "short", value: "" },
  ]);
});

test("additive selection replaces a repeated path and retains newly dropped companions", () => {
  const original = fixtureFile("study/sub-01_task-rest_eeg.json", "{}", "application/json", 1);
  const replacement = fixtureFile("study/sub-01_task-rest_eeg.json", '{"TaskName":"rest"}', "application/json", 2);
  const events = fixtureFile("study/sub-01_task-rest_events.tsv", "onset\tduration\n1\t0\n");
  const merged = mergeSelectedFiles([original], [events, replacement]);

  assert.equal(merged.length, 2);
  assert.equal(merged.find((file) => relativeFilePath(file).endsWith("_eeg.json"))?.lastModified, 2);
  assert.equal(classifyUploadedFile(events), "events");
});

test("catalogues malformed companions with a visible parsing error", async () => {
  const malformed = fixtureFile("sub-01_task-rest_eeg.json", "{not-json", "application/json");
  const bundle = await analyzeBidsCompanions([malformed]);

  assert.equal(bundle.files[0].status, "error");
  assert.equal(bundle.metadataSources.length, 0);
  assert.match(bundle.warnings[0], /sub-01_task-rest_eeg\.json/i);
});
