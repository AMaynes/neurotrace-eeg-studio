import assert from "node:assert/strict";
import test from "node:test";

import { clusterTimelineDensity } from "../app/timeline-density.ts";

test("caps occupied output independently for every track", () => {
  const annotations = [];
  for (const track of ["context", "windowed", "instance"]) {
    for (let index = 0; index < 100; index += 1) {
      annotations.push({ id: `${track}-${index}`, track, start: index + 0.5, end: index + 0.5 });
    }
  }
  const bins = clusterTimelineDensity(annotations, { start: 0, end: 100 }, 10);
  for (const track of ["context", "windowed", "instance"]) {
    const trackBins = bins.filter((bin) => bin.track === track);
    assert.equal(trackBins.length, 10);
    assert.equal(trackBins.reduce((sum, bin) => sum + bin.count, 0), 100);
  }
});

test("long intervals conservatively cover every intersected fixed bin", () => {
  const bins = clusterTimelineDensity([
    { id: "whole", track: "windowed", start: -5, end: 15 },
  ], { start: 0, end: 10 }, 5);
  assert.deepEqual(bins, [
    { track: "windowed", start: 0, end: 2, count: 1 },
    { track: "windowed", start: 2, end: 4, count: 1 },
    { track: "windowed", start: 4, end: 6, count: 1 },
    { track: "windowed", start: 6, end: 8, count: 1 },
    { track: "windowed", start: 8, end: 10, count: 1 },
  ]);
});

test("uses half-open interval boundaries while retaining visible boundary points", () => {
  const bins = clusterTimelineDensity([
    { id: "left-point", track: "events", start: 0, end: 0 },
    { id: "right-point", track: "events", start: 10, end: 10 },
    { id: "first-interval", track: "events", start: 0, end: 1 },
    { id: "second-interval", track: "events", start: 1, end: 2 },
    { id: "crossing", track: "events", start: 0.9, end: 1.1 },
  ], { start: 0, end: 10 }, 10);

  assert.deepEqual(bins, [
    { track: "events", start: 0, end: 1, count: 3 },
    { track: "events", start: 1, end: 2, count: 2 },
    { track: "events", start: 9, end: 10, count: 1 },
  ]);
});

test("counts unique ids per track and ignores invalid or invisible annotations", () => {
  const bins = clusterTimelineDensity([
    { id: "duplicate", track: "a", start: 2, end: 4 },
    { id: "duplicate", track: "a", start: 2, end: 4 },
    { id: "duplicate", track: "b", start: 2, end: 4 },
    { id: "before", track: "a", start: -2, end: -1 },
    { id: "after", track: "a", start: 11, end: 12 },
    { id: "bad", track: "a", start: Number.NaN, end: 5 },
    { id: "", track: "a", start: 1, end: 2 },
  ], { start: 0, end: 10 }, 2);

  assert.deepEqual(bins, [
    { track: "a", start: 0, end: 5, count: 1 },
    { track: "b", start: 0, end: 5, count: 1 },
  ]);
});

test("normalizes reversed intervals and preserves every visible source coverage", () => {
  const annotations = [
    { id: "point", track: "t", start: 2.25, end: 2.25 },
    { id: "reversed", track: "t", start: 7.2, end: 4.8 },
    { id: "cross", track: "t", start: 8.9, end: 10.5 },
  ];
  const range = { start: 2, end: 10 };
  const bins = clusterTimelineDensity(annotations, range, 8);
  assert.ok(bins.length <= 8);
  for (const bin of bins) {
    assert.ok(bin.start >= range.start && bin.end <= range.end && bin.end > bin.start);
  }

  const covered = (time) => bins.some((bin) => time >= bin.start && time <= bin.end);
  assert.equal(covered(2.25), true);
  for (const time of [4.8, 5.5, 6.5, 7.2, 8.9, 9.5, 10]) assert.equal(covered(time), true);
});

test("returns no bins for invalid ranges or caps", () => {
  const item = [{ id: "x", track: "t", start: 0, end: 1 }];
  assert.deepEqual(clusterTimelineDensity(item, { start: 1, end: 1 }, 10), []);
  assert.deepEqual(clusterTimelineDensity(item, { start: 2, end: 1 }, 10), []);
  assert.deepEqual(clusterTimelineDensity(item, { start: 0, end: 1 }, 0), []);
  assert.deepEqual(clusterTimelineDensity(item, { start: 0, end: Number.NaN }, 10), []);
});
