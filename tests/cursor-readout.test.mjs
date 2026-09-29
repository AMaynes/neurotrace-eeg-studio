import assert from "node:assert/strict";
import test from "node:test";
import { readCursorReadout } from "../app/cursor-readout.ts";

function exact(values, overrides = {}) {
  return {
    data: [Float32Array.from(values)], envelopes: [null],
    sampleRates: [4], sourceSampleRates: [4], startSecs: [0], units: ["µV"],
    ...overrides,
  };
}

function overview(overrides = {}) {
  return exact([25, -3], {
    sampleRates: [1],
    envelopes: [{
      minima: new Float32Array([0, -5]), maxima: new Float32Array([100, -1]),
      gaps: new Uint8Array(2), startSec: 0, bucketDurationSec: 1,
    }],
    ...overrides,
  });
}

test("an overview impulse reports its actual extrema and interval, never the averaged sample", () => {
  // The source [0, 100, 0, 0] averages to 25; 25 is not a source sample.
  assert.deepEqual(readCursorReadout(overview(), 0, .25), {
    kind: "range", minimum: 0, maximum: 100, unit: "µV", startSec: 0, endSec: 1, bucketIndex: 0,
  });
  assert.equal("value" in readCursorReadout(overview(), 0, .25), false);
  assert.equal("sourceSampleIndex" in readCursorReadout(overview(), 0, .25), false);
});

test("exact reads use the sample's real timestamp and source index, not cursor coordinates", () => {
  const display = exact([11, 22, 33], { sampleRates: [200], sourceSampleRates: [200], startSecs: [3.005] });
  const readout = readCursorReadout(display, 0, 3.011);
  assert.equal(readout.kind, "sample");
  assert.equal(readout.value, 22);
  assert.ok(Math.abs(readout.sampleTimeSec - 3.01) < 1e-12);
  assert.equal(readout.displaySampleIndex, 1);
  assert.equal(readout.sourceSampleIndex, 602);
});

test("processed sample indices distinguish the display grid from the source grid", () => {
  const processed = exact([.25, .75], { sampleRates: [100], sourceSampleRates: [200], startSecs: [.005] });
  assert.deepEqual(readCursorReadout(processed, 0, .015), {
    kind: "sample", value: .75, unit: "µV", sampleTimeSec: .015, displaySampleIndex: 1, sourceSampleIndex: 3,
  });
  const unaligned = exact([5, 6], { sampleRates: [128], sourceSampleRates: [200] });
  assert.equal(readCursorReadout(unaligned, 0, 1 / 128).sourceSampleIndex, null);
  assert.equal(readCursorReadout(exact([1], { sourceSampleRates: [] }), 0, 0).sourceSampleIndex, null);
});

test("missing, invalid, and outside exact coordinates never copy zero or an edge sample", () => {
  const display = exact([10, Number.NaN, 30], { startSecs: [2] });
  for (const time of [1.999, 2.7, 2.75, 10]) {
    assert.equal(readCursorReadout(display, 0, time).kind, "unavailable");
  }
  assert.equal(readCursorReadout(display, 0, 2.25).reason, "missing-data");
  assert.equal(readCursorReadout(display, 0, 2).value, 10);
  assert.equal(readCursorReadout(display, 0, 2.5).value, 30);
  assert.equal(readCursorReadout(exact([0]), 0, 0).value, 0, "a real zero remains valid");
  for (const [row, time] of [[-1, 2], [0.5, 2], [0, NaN], [0, Infinity], [0, -1]]) {
    assert.equal(readCursorReadout(display, row, time).reason, "invalid-position");
  }
  assert.equal(readCursorReadout(display, 4, 2).reason, "no-data");
  assert.equal(readCursorReadout(exact([]), 0, 0).reason, "no-data");
  assert.equal(readCursorReadout(exact([1], { sampleRates: [0] }), 0, 0).reason, "invalid-timing");
  assert.equal(readCursorReadout(exact([1], { startSecs: [] }), 0, 0).reason, "invalid-timing");
});

test("envelope boundaries are half-open and respect fractional-grid roundoff", () => {
  const display = overview({ envelopes: [{
    minima: new Float32Array([0, -5]), maxima: new Float32Array([100, -1]), gaps: new Uint8Array(2),
    startSec: .2, bucketDurationSec: .1,
  }] });
  assert.equal(readCursorReadout(display, 0, .2).bucketIndex, 0);
  assert.equal(readCursorReadout(display, 0, .299).bucketIndex, 0);
  assert.equal(readCursorReadout(display, 0, .3).bucketIndex, 1);
  assert.equal(readCursorReadout(display, 0, .199).reason, "outside-data");
  assert.equal(readCursorReadout(display, 0, .4).reason, "outside-data");
});

test("overview gaps or unread intervals remain unavailable despite finite representative values", () => {
  const display = overview();
  display.envelopes[0].gaps[0] = 1;
  assert.equal(readCursorReadout(display, 0, .2).reason, "missing-data");
  display.envelopes[0].gaps[0] = 0;
  display.envelopes[0].minima[0] = NaN;
  assert.equal(readCursorReadout(display, 0, .2).reason, "missing-data");
  assert.equal(readCursorReadout(overview({ unreadAfterSec: 1 }), 0, 1.2).reason, "missing-data");
  assert.equal(readCursorReadout(overview({ unreadAfterSec: .75 }), 0, .5).endSec, .75);
});

test("replacing data, channels, or montage recalculates the readout without saved amplitude state", () => {
  const display = exact([2, 3]);
  assert.equal(readCursorReadout(display, 0, 0).value, 2);
  const newDisplay = exact([-20, -30], { units: ["counts"] });
  assert.equal(readCursorReadout(newDisplay, 0, 0).value, -20);
  assert.equal(readCursorReadout(newDisplay, 0, 0).unit, "counts");
  assert.equal(readCursorReadout(overview(), 0, 0).kind, "range");
  assert.equal(readCursorReadout(exact([]), 0, 0).kind, "unavailable");
});
