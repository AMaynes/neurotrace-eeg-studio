import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { centerDisplayWindow } from "../app/trace-centering.ts";
import { orderElectrodeDisplayRows } from "../app/channel-layout.ts";
import { clippingExcessIntensity, traceClippingRange } from "../app/waveform-geometry.ts";

function window(overrides = {}) {
  return {
    data: [Float32Array.of(480, 500, 520)], labels: ["A1"], sourceIndices: [[0]],
    primarySourceIndices: [0], units: ["µV"], traceBaselines: [0],
    startSecs: [10], sampleRates: [1], sourceSampleRates: [1], envelopes: [null],
    viewStart: 10, viewDuration: 3, ...overrides,
  };
}

test("automatic centering uses visible samples, not offscreen padding or spikes", () => {
  const display = window({ data: [Float32Array.of(-9000, -9000, -9000, 480, 500, 520, 9000)], startSecs: [7] });
  const before = structuredClone(display);
  const centered = centerDisplayWindow(display);
  assert.equal(centered.traceBaselines[0], 500);
  assert.deepEqual(display, before, "prepared samples and metadata remain immutable");
  const panned = centerDisplayWindow(window({ data: [Float32Array.of(1000, 2000, 3000)], startSecs: [30], viewStart: 30 }));
  assert.equal(panned.traceBaselines[0], 2000, "a new time window gets its own deterministic center");
});

test("exact sample timing uses each row's own start/rate and excludes the right edge", () => {
  const centered = centerDisplayWindow(window({
    data: [Float64Array.of(10, 20, 30, 40, 999)], startSecs: [10.25], sampleRates: [2],
    viewStart: 10.5, viewDuration: 1.75,
  }));
  assert.equal(centered.traceBaselines[0], 30);
  assert.equal(centerDisplayWindow(window({ viewStart: 100, viewDuration: 1 })).traceBaselines[0], 0);
});

test("missing and non-finite samples are neutral while finite islands remain usable", () => {
  for (const samples of [[], [NaN, Infinity, -Infinity]]) {
    assert.equal(centerDisplayWindow(window({ data: [Float32Array.from(samples)] })).traceBaselines[0], 0);
  }
  const mixed = centerDisplayWindow(window({ data: [Float32Array.of(NaN, 480, Infinity, 500, 520)], viewDuration: 5 }));
  assert.equal(mixed.traceBaselines[0], 500);
  assert.equal(centerDisplayWindow(window({ viewStart: undefined, viewDuration: undefined })).traceBaselines[0], 0);
});

test("overviews use visible representative means and exclude buckets marked as gaps", () => {
  const display = window({ data: [Float32Array.of(-9000, 480, 500, 520, 9000)], viewStart: 11, viewDuration: 5,
    envelopes: [{ startSec: 8, bucketDurationSec: 2, gaps: Uint8Array.of(0, 0, 1, 0, 0),
      minima: Float32Array.of(-9100, 400, 400, 400, 8000), maxima: Float32Array.of(-8900, 600, 600, 600, 10000) }] });
  assert.equal(centerDisplayWindow(display).traceBaselines[0], 500);
  const missing = window({ envelopes: [{ startSec: 10, bucketDurationSec: 1, gaps: Uint8Array.of(1, 1, 1) }] });
  assert.equal(centerDisplayWindow(missing).traceBaselines[0], 0);
});

test("centers stay attached to their complete rows through electrode ordering", () => {
  const display = window({ labels: ["A10", "A2"], data: [Float32Array.of(10, 10), Float32Array.of(20, 20)],
    sourceIndices: [[9], [1]], primarySourceIndices: [9, 1], units: ["counts", "counts"],
    traceBaselines: [0, 0], startSecs: [10, 10], sampleRates: [1, 1], sourceSampleRates: [1, 1], envelopes: [null, null],
    viewDuration: 2 });
  const sorted = orderElectrodeDisplayRows(centerDisplayWindow(display));
  assert.deepEqual(sorted.labels, ["A2", "A10"]);
  assert.deepEqual(sorted.traceBaselines, [20, 10]);
  assert.deepEqual(display.traceBaselines, [0, 0]);
});

test("raw-count and physical-unit centers keep clipping thresholds aligned without changing gain", () => {
  for (const factor of [1, 100]) {
    const display = centerDisplayWindow(window({ data: [Float32Array.of(480 * factor, 500 * factor, 520 * factor)] }));
    const scale = 0.216 / factor;
    const range = traceClippingRange(60, display.traceBaselines[0], scale, 4);
    for (const value of display.data[0]) assert.equal(clippingExcessIntensity(value, value, range.minimum, range.maximum, range.fullIntensityExcess), 0);
    const originalSpan = traceClippingRange(60, 0, scale, 4).maximum * 2;
    assert.ok(Math.abs((range.maximum - range.minimum) - originalSpan) < originalSpan * 1e-12);
  }
});

test("the viewer centers every prepared publication and paints from that immutable center", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /const publishDisplay = \(next: DisplayWindow\) => \{[\s\S]*?centerDisplayWindow\(next\)/);
  assert.equal(page.match(/publishDisplay\(nextDisplay\)/g)?.length, 4);
  const draw = page.slice(page.indexOf("const traceOrder"), page.indexOf("const scaleRow"));
  assert.equal(draw.match(/display\.traceBaselines\[channel\]/g)?.length, 2);
  assert.doesNotMatch(page, /traceBaselineCacheRef|setTraceCenters|recenter-button/);
});
