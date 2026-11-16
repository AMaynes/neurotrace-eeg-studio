import assert from "node:assert/strict";
import test from "node:test";
import { planDirectoryImport } from "../app/directory-import.ts";
import { isReviewCsv, loadDirectoryReviewCsvs } from "../app/directory-review-resume.ts";
import {
  canOpenReviewRecording, newReviewWorkspace, normalizeReviewerId, parseReviewWorkspace,
  reviewFolderKey, reviewWorkspaceNames, writeReviewWorkspacePair,
} from "../app/review-workspace.ts";
import { serializeMatlabAnnotations } from "../app/matlab-annotations-csv.ts";

function recording(path, size = 16) {
  const file = new File([new Uint8Array(size)], path.split("/").at(-1));
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

test("workspace identity uses the full folder and locks earlier recordings across filters", async () => {
  const files = ["01.edf", "02.edf", "03.edf"].map((name) => recording(`test/${name}`));
  const plan = planDirectoryImport(files, "edf");
  const filtered = { ...plan, recordings: plan.recordings.slice(1), unfilteredRecordings: plan.recordings };
  const key = await reviewFolderKey(plan);
  assert.equal(await reviewFolderKey(filtered), key);
  assert.notEqual(await reviewFolderKey(planDirectoryImport([files[0], recording("test/02.edf", 32), files[2]], "edf")), key);
  const review = newReviewWorkspace(key, normalizeReviewerId(" r-017 "), 4, true);
  assert.equal(review.reviewerId, "R-017");
  assert.equal(normalizeReviewerId("../r017"), "");
  review.furthestIndex = 1;
  assert.equal(canOpenReviewRecording(review, filtered, plan.recordings[0].id), false);
  assert.equal(canOpenReviewRecording(review, filtered, plan.recordings[1].id), true);
  assert.equal(canOpenReviewRecording(review, filtered, plan.recordings[2].id), true);
});

test("workspace JSON round-trips view, drafts, decisions and the label library", () => {
  const workspace = newReviewWorkspace("1".repeat(64), "R017", 4, false);
  workspace.position = "test/01.edf";
  workspace.recordings[workspace.position] = {
    visitedAt: workspace.updatedAt, completedAt: workspace.updatedAt, csvRows: [],
    review: { annotations: [{ labelId: "dictionary-label", geometry: "point", start: 31.25 }], candidates: [{ status: "skipped" }] },
    view: { viewStart: 18.125, timebase: 13.5, cursor: { time: 31.25, locked: true } },
  };
  workspace.library.aliases.push({ key: "recording:stim", alias: "Stimulus", description: "Sync marker" });
  workspace.library.labels.push({ id: "one", name: "Check", code: "CK", description: "Review marker" });
  assert.deepEqual(parseReviewWorkspace(JSON.stringify(workspace)), workspace);
  assert.throws(() => parseReviewWorkspace(JSON.stringify({ ...workspace, reviewerId: "../R017" })), /incomplete/);
  workspace.recordings[workspace.position].csvRows.push(null);
  assert.throws(() => parseReviewWorkspace(JSON.stringify(workspace)), /saved recording/);
});

function memoryDirectory() {
  const files = new Map();
  let failingExtension = "";
  return { files, failWritesTo: (extension) => { failingExtension = extension; }, async getFileHandle(name, { create } = {}) {
    if (!files.has(name)) {
      if (!create) throw new DOMException("Missing file", "NotFoundError");
      files.set(name, new File([], name));
    }
    return {
      getFile: async () => files.get(name),
      createWritable: async () => {
        let content;
        return { async write(blob) {
          if (failingExtension && name.endsWith(failingExtension)) throw new Error("Disk write interrupted");
          content = blob;
        }, async close() { files.set(name, new File([content], name)); }, async abort() {} };
      },
    };
  } };
}

test("the same pass updates exactly two standard files and can retry after a CSV write fails", async () => {
  const review = newReviewWorkspace("1".repeat(64), "R017", 4, true);
  const directory = memoryDirectory();
  const csv = serializeMatlabAnnotations([]);
  const names = reviewWorkspaceNames(review);
  assert.deepEqual(names, {
    workspace: "reviewer-R017_review-004_workspace.json", annotations: "reviewer-R017_review-004_annotations.csv",
  });
  directory.failWritesTo(".csv");
  await assert.rejects(writeReviewWorkspacePair(directory, review, csv), /interrupted/);
  assert.equal(parseReviewWorkspace(await directory.files.get(names.workspace).text()).instanceId, review.instanceId);
  directory.failWritesTo("");
  await writeReviewWorkspacePair(directory, review, csv);
  assert.equal(directory.files.size, 2);
  assert.equal(await directory.files.get(names.annotations).text(), csv);
  await assert.rejects(writeReviewWorkspacePair(directory, newReviewWorkspace(review.folderKey, review.reviewerId, 4, true), csv), /different or newer/);
  await assert.rejects(writeReviewWorkspacePair(directory, { ...review, updatedAt: "2000-01-01T00:00:00Z" }, csv), /different or newer/);
});

test("reviewer-scoped CSVs never restore into an unmanaged directory", async () => {
  const csv = new File([serializeMatlabAnnotations([])], "reviewer-R017_review-004_annotations.csv");
  assert.equal(isReviewCsv(csv), false);
  const plan = planDirectoryImport([recording("test/01.edf"), csv], "edf");
  const cache = await loadDirectoryReviewCsvs(plan, [csv]);
  assert.equal(cache.files.size, 0);
  assert.equal(cache.byRecording.size, 0);
});


test("an interrupted first JSON write leaves the pair retryable", async () => {
  const review = newReviewWorkspace("1".repeat(64), "R017", 4, true);
  const directory = memoryDirectory();
  const names = reviewWorkspaceNames(review);
  directory.failWritesTo(".json");
  await assert.rejects(writeReviewWorkspacePair(directory, review, "labels"), /interrupted/);
  assert.equal(directory.files.get(names.workspace).size, 0);
  assert.equal(directory.files.has(names.annotations), false);
  directory.failWritesTo("");
  await writeReviewWorkspacePair(directory, review, "labels");
  assert.equal(directory.files.size, 2);
  assert.equal(await directory.files.get(names.annotations).text(), "labels");
});
