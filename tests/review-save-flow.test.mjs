/** Exercise the real save action through its download boundary. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { serializeRecordingLabels, parseRecordingLabelsCsv, recordingSourcePath } from "../app/recording-labels-csv.ts";
import { newReviewWorkspace, normalizeReviewerId, reviewWorkspaceNames, reviewFolderKey, parseReviewWorkspace } from "../app/review-workspace.ts";
const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let declaration;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "saveReviewerWorkspace") declaration = node.initializer;
  ts.forEachChild(node, visit);
}
visit(ast);
const compiled = ts.transpile(`const action = ${declaration.getText(ast)};`, { target: ts.ScriptTarget.ES2022 });
function harness() {
  const primaryFile = new File(["recording"], "first.edf");
  const otherFile = new File(["recording"], "second.edf");
  const plan = { format: "edf", supportingFiles: [], recordings: [primaryFile, otherFile].map(file => ({
    id: file.name, primary: file, files: [file], relativePath: file.name, label: file.name,
  })) };
  const manual = { id: "a", labelId: "ictal", start: 12, end: 13, track: "ephys", confidence: 91,
    status: "draft", origin: "manual", reviewer: "", notes: "check", updatedAt: new Date().toISOString() };
  const detected = { ...manual, id: "detected", origin: "imported", recordingLabel: { label: "Seizure" } };
  const snapshots = new Map([["active", { viewStart: 100, channelScrollTop: 20 }], ["other", {
    hasRecording: true, annotations: [detected], candidates: [], recordingLabelsImported: true,
    viewStart: 50, timebase: 30, cursorTime: 55, cursorLocked: true,
  }]]);
  const downloads = [], errors = [], messages = [];
  const folder = { sessions: new Map([["second.edf", { sessionId: "other" }]]) };
  const state = { reviewer: "" };
  const env = {
    projectSaveBusy: false, hasRecording: true, sourceVerificationRef: {current: false}, importBusyRef: {current: false},
    reviewViewArrival: null, primaryFile, normalizeReviewerId, csvDirectoryId: "folder",
    directoryCatalogWorkspacesRef: {current: new Map([["folder", folder]])},
    setProjectSaveError: v => errors.push(v), setProjectSaveBusy() {}, flushSessionRef: {current() {}},
    directoryCatalogs: [{id: "folder", plan}], meta: {format: "edf"}, relativeFilePath: file => file.name,
    uploadedFileInputs: [primaryFile], SUPPORTED_RECORDING_EXTENSIONS: new Set(["edf"]), recordingExtension: () => "edf",
    newReviewWorkspace, reviewFolderKey, sessionTabs: [{id: "active", directoryRecordingId: "first.edf"}], activeSessionId: "active",
    sessionSnapshotsRef: {current: snapshots}, annotationsRef: {current: [manual]}, candidatesRef: {current: []}, activeCandidate: null,
    recordingLabelsImportedRef: {current: true}, matlabExportIdentityFromInterpretation: () => ({}), sourceInterpretation: null,
    timebase: 20, gain: 1, montage: "recorded", filters: {}, traceDisplayMode: "clamped", cursorTime: 107, cursorLocked: true,
    selectedChannels: [0,1], focusedChannel: 1, channelSelectionActive: true, selectedAnnotationId: null, selection: null,
    snapMode: "none", spectrogramOpen: false, spectrogramChannels: [0,1], spectrogramAnchor: 107, anatomicalGroups: true,
    expandedChannels: false, waveformVerticalViewport: null, spectrogramFrequencyRange: {min: 0,max: 50}, controlBindings: {},
    hiddenLabelTypes: new Set(), labelKeywords: "sz", labelsVisible: true, queueAcrossSessions: true,
    enabledEphysLabelIds: new Set(["ictal"]), leftPanelOpen: true, rightPanelOpen: true, rightPanelView: "labels", bottomTracksOpen: true,
    labelLibrary: {aliases: [],labels: []}, customTools: [], localStorage: {getItem: () => null},
    recordingSourcePath, serializeRecordingLabels, csvLabelName: () => "Ictal", reviewWorkspaceNames,
    downloadBlob: (name,blob) => downloads.push({name,blob}), setReviewer: id => state.reviewer = id,
    setReviewerProfileId() {}, setShowProjectSave() {}, setToast: text => messages.push(text), notifyTutorialAction() {},
    sourceRef: {current: {}}, EDFSource: class {}, completeExportLabels: () => {throw Error("Unexpected reread");},
  };
  const action = new Function(...Object.keys(env), `${compiled}\nreturn action;`)(...Object.values(env));
  return {action, downloads, errors, state, messages};
}
test("one signature downloads exactly CSV and JSON, retaining other opened sessions and precise placement", async () => {
  const h = harness();
  await h.action(" reviewer-01 ");
  assert.equal(h.downloads.length,2, h.errors.join("\n"));
  assert.deepEqual(h.downloads.map(item => item.name), ["reviewer-REVIEWER-01_review-001_annotations.csv", "reviewer-REVIEWER-01_review-001_workspace.json"]);
  const csv = parseRecordingLabelsCsv(await h.downloads[0].blob.text());
  assert.equal(csv.recordings.length,2);
  assert.equal(csv.recordings[0].annotations[0].reviewer,"REVIEWER-01");
  assert.equal(csv.recordings[1].annotations[0].recordingLabel.label,"Seizure");
  const json = parseReviewWorkspace(await h.downloads[1].blob.text());
  assert.equal(json.position,"first.edf");
  assert.equal(json.recordings[json.position].view.viewStart,100);
  assert.deepEqual(json.recordings[json.position].view.cursor, {time:107,locked:true});
  assert.deepEqual(json.recordings[json.position].view.spectrogramChannels,[0,1]);
  assert.equal(json.recordings["second.edf"].review.annotations.length,1);
  assert.equal(json.settings.recordingReferences.length,2);
});
test("an invalid reviewing signature downloads nothing", async () => {
  const h = harness(); await h.action("../bad");
  assert.equal(h.downloads.length,0); assert.match(h.errors.at(-1),/signature/);
});
