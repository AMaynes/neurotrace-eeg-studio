import assert from "node:assert/strict";
import test from "node:test";
import { recordingOverviewDisplayPolicy } from "../app/overview-display-policy.ts";

const hourRecording = {
  recordingDurationSec: 3600,
  overviewBucketDurationSec: 3600 / 2048,
  viewDurationSec: 60,
  waveformWidthPx: 1600,
  sourceSampleRates: [1000],
  filtersEnabled: false,
  montage: "referential",
};

test("minute windows show a coarse preview instead of waiting for full-resolution bins", () => {
  for (const minutes of [1, 5, 15, 28]) {
    assert.equal(recordingOverviewDisplayPolicy({
      ...hourRecording, viewDurationSec: minutes * 60,
    }), "preview", `${minutes}-minute views need a preview followed by finer data`);
  }
  for (const minutes of [30, 60]) {
    assert.equal(recordingOverviewDisplayPolicy({
      ...hourRecording, viewDurationSec: minutes * 60,
    }), "final", `${minutes}-minute views already fit the retained resolution`);
  }
});

test("hour windows in day-long recordings also use previews until refined", () => {
  assert.equal(recordingOverviewDisplayPolicy({
    ...hourRecording,
    recordingDurationSec: 86400,
    overviewBucketDurationSec: 86400 / 2048,
    viewDurationSec: 3600,
  }), "preview");
});

test("close-up views are not replaced by a coarse recording overview", () => {
  for (const viewDurationSec of [0.1, 1, 20, 59.999]) {
    assert.equal(recordingOverviewDisplayPolicy({ ...hourRecording, viewDurationSec }), "none");
  }
  assert.equal(recordingOverviewDisplayPolicy({
    ...hourRecording, viewDurationSec: 20, overviewBucketDurationSec: 0.01,
  }), "final", "a genuinely fine enough retained index remains reusable");
});

test("sparse channels retain source samples instead of using any overview", () => {
  assert.equal(recordingOverviewDisplayPolicy({
    ...hourRecording, sourceSampleRates: [1, 10],
  }), "none");
  assert.equal(recordingOverviewDisplayPolicy({
    ...hourRecording, sourceSampleRates: [40],
  }), "none", "exactly 1.5 samples per pixel remains a source-sample view");
  assert.equal(recordingOverviewDisplayPolicy({
    ...hourRecording, sourceSampleRates: [1, 1000],
  }), "preview", "a dense enabled channel can benefit even when another is sparse");
});

test("whole-file views keep the compact index even on wide screens", () => {
  assert.equal(recordingOverviewDisplayPolicy({
    ...hourRecording,
    recordingDurationSec: 120,
    overviewBucketDurationSec: 120 / 2048,
    viewDurationSec: 120,
    waveformWidthPx: 3840,
  }), "final");
  assert.equal(recordingOverviewDisplayPolicy({
    ...hourRecording,
    recordingDurationSec: 1,
    overviewBucketDurationSec: 1 / 10,
    viewDurationSec: 1,
    sourceSampleRates: [10],
  }), "none", "short sparse recordings do not invent envelope detail");
});

test("filtered and derived signals never use an unfiltered reference overview", () => {
  assert.equal(recordingOverviewDisplayPolicy({ ...hourRecording, filtersEnabled: true }), "none");
  for (const montage of ["bipolar", "average", "unknown"]) {
    assert.equal(recordingOverviewDisplayPolicy({ ...hourRecording, montage }), "none");
  }
});

test("resolution tolerance and preview boundary are stable", () => {
  assert.equal(recordingOverviewDisplayPolicy({
    ...hourRecording, overviewBucketDurationSec: 60 / 1600 * 1.05,
  }), "final");
  assert.equal(recordingOverviewDisplayPolicy({
    ...hourRecording, overviewBucketDurationSec: 60 / 1600 * 1.051,
  }), "preview");
  assert.equal(recordingOverviewDisplayPolicy({
    ...hourRecording, viewDurationSec: 59.999,
  }), "none");
});

test("unmounted canvases and invalid metadata decline optional previews", () => {
  assert.equal(recordingOverviewDisplayPolicy({ ...hourRecording, waveformWidthPx: 63 }), "none");
  for (const sourceSampleRates of [[], [0], [-1], [Number.NaN], [Infinity]]) {
    assert.equal(recordingOverviewDisplayPolicy({ ...hourRecording, sourceSampleRates }), "none");
  }
  for (const field of ["recordingDurationSec", "overviewBucketDurationSec", "viewDurationSec", "waveformWidthPx"]) {
    for (const value of [0, -1, Number.NaN, Infinity]) {
      assert.equal(recordingOverviewDisplayPolicy({ ...hourRecording, [field]: value }), "none");
    }
  }
  assert.equal(recordingOverviewDisplayPolicy({
    ...hourRecording, overviewBucketDurationSec: 3601,
  }), "none");
});
