import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { displayedTraceCenter, normalizeTraceCenters, recenteredTraceCenters, sameTraceCenters, traceCenterKey } from "../app/trace-centering.ts";
import { orderElectrodeDisplayRows } from "../app/channel-layout.ts";
import { clippingExcessIntensity, traceClippingRange } from "../app/waveform-geometry.ts";

function window(overrides = {}) {
  return {
    baselineSettingsKey: "recorded", data: [Float32Array.of(480, 500, 520)], labels: ["A1"],
    sourceIndices: [[0]], primarySourceIndices: [0], units: ["µV"], traceBaselines: [0],
    startSecs: [10], sampleRates: [1], sourceSampleRates: [1], envelopes: [null], ...overrides,
  };
}

test("Recenter uses visible samples, not offscreen padding, spikes, gain, or zero", () => {
  const display = window({ data: [Float32Array.of(-9000, -9000, -9000, 480, 500, 520, 9000)], startSecs: [7] });
  const before = structuredClone(display);
  const centers = recenteredTraceCenters(display, {}, 10, 3);
  assert.equal(displayedTraceCenter(display, 0, centers), 500);
  assert.deepEqual(display, before);
  const panned = window({ data: [Float32Array.of(1000, 2000, 3000)], startSecs: [30] });
  assert.equal(displayedTraceCenter(panned, 0, centers), 500, "panning does not recalculate the center");
  assert.equal(displayedTraceCenter(panned, 0, recenteredTraceCenters(panned, centers, 30, 3)), 2000, "another click explicitly recenters");
});

test("exact sample timing uses each row's own start/rate and excludes the right edge", () => {
  const display = window({ data: [Float64Array.of(10, 20, 30, 40, 999)], startSecs: [10.25], sampleRates: [2] });
  const centers = recenteredTraceCenters(display, {}, 10.5, 1.75);
  assert.equal(displayedTraceCenter(display, 0, centers), 30);
  assert.strictEqual(recenteredTraceCenters(display, centers, 100, 1), centers);
});

test("all-missing traces retain their centers; mixed gaps and non-finite values are ignored", () => {
  const original = { [traceCenterKey("recorded", "A1", [0], "µV")]: 99 };
  for (const samples of [[], [NaN, Infinity, -Infinity]]) {
    const display = window({ data: [Float32Array.from(samples)] });
    assert.strictEqual(recenteredTraceCenters(display, original, 10, 3), original);
  }
  const mixed = window({ data: [Float32Array.of(NaN, 480, Infinity, 500, 520)] });
  assert.equal(displayedTraceCenter(mixed, 0, recenteredTraceCenters(mixed, original, 10, 5)), 500);
});

test("overviews use visible representative means and exclude buckets with gaps, preserving extrema", () => {
  const display = window({ data: [Float32Array.of(-9000, 480, 500, 520, 9000)],
    envelopes: [{ startSec: 8, bucketDurationSec: 2, gaps: Uint8Array.of(0, 0, 1, 0, 0),
      minima: Float32Array.of(-9100, 400, 400, 400, 8000), maxima: Float32Array.of(-8900, 600, 600, 600, 10000) }] });
  const before = structuredClone(display);
  const centers = recenteredTraceCenters(display, {}, 11, 5);
  assert.equal(displayedTraceCenter(display, 0, centers), 500);
  assert.deepEqual(display, before);
  const missing = window({ envelopes: [{ startSec: 10, bucketDurationSec: 1, gaps: Uint8Array.of(1, 1, 1) }] });
  assert.deepEqual(recenteredTraceCenters(missing, {}, 10, 3), {});
});

test("centers follow channel identities through electrode ordering but never cross montage/filter/units", () => {
  const display = window({ labels: ["A10", "A2"], data: [Float32Array.of(10, 10), Float32Array.of(20, 20)],
    sourceIndices: [[9], [1]], primarySourceIndices: [9, 1], units: ["counts", "counts"],
    traceBaselines: [0, 0], startSecs: [10, 10], sampleRates: [1, 1], sourceSampleRates: [1, 1], envelopes: [null, null] });
  const centers = recenteredTraceCenters(display, {}, 10, 2);
  const sorted = orderElectrodeDisplayRows(display);
  assert.deepEqual(sorted.labels, ["A2", "A10"]);
  assert.equal(displayedTraceCenter(sorted, 0, centers), 20);
  assert.equal(displayedTraceCenter(sorted, 1, centers), 10);
  assert.equal(displayedTraceCenter({ ...display, baselineSettingsKey: "bipolar" }, 0, centers), 0);
  assert.equal(displayedTraceCenter({ ...display, baselineSettingsKey: "recorded-with-highpass" }, 0, centers), 0);
  assert.equal(displayedTraceCenter({ ...display, units: ["µV", "µV"] }, 0, centers), 0);
  assert.equal(displayedTraceCenter({ ...display, sourceIndices: [[8], [1]] }, 0, centers), 0);
  assert.equal(displayedTraceCenter(display, 0, {}), 0, "another session has no overrides");
});

test("raw-count and physical-unit centers keep clipping thresholds aligned without changing gain", () => {
  for (const factor of [1, 100]) {
    const display = window({ data: [Float32Array.of(480 * factor, 500 * factor, 520 * factor)] });
    const centers = recenteredTraceCenters(display, {}, 10, 3);
    const scale = 0.216 / factor;
    const range = traceClippingRange(60, displayedTraceCenter(display, 0, centers), scale, 4);
    for (const value of display.data[0]) assert.equal(clippingExcessIntensity(value, value, range.minimum, range.maximum, range.fullIntensityExcess), 0);
    const originalSpan = traceClippingRange(60, 0, scale, 4).maximum * 2;
    assert.ok(Math.abs((range.maximum - range.minimum) - originalSpan) < originalSpan * 1e-12);
  }
});

test("saved centers round-trip, and invalid records cannot introduce non-finite baselines", () => {
  const valid = recenteredTraceCenters(window(), {}, 10, 3);
  assert.deepEqual(normalizeTraceCenters(JSON.parse(JSON.stringify(valid))), valid);
  for (const value of [null, [], 2, "invalid", { nope: 10 }, { [Object.keys(valid)[0]]: Infinity }]) assert.deepEqual(normalizeTraceCenters(value), {});
  assert.ok(sameTraceCenters(valid, structuredClone(valid)));
  assert.ok(sameTraceCenters(undefined, {}));
  assert.ok(!sameTraceCenters(valid, {}));
});

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let readiness;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(syntax) === "canRecenter") readiness = node.initializer.getText(syntax);
  ts.forEachChild(node, visit);
}
visit(syntax);
test("Recenter waits for the current complete view, including pan debounce and overview refinement", () => {
  const ready = (overrides = {}) => {
    const state = { hasRecording: true, displayReadoutReady: true, viewStart: 10, timebase: 3,
      display: { viewStart: 10, data: [Float32Array.of(1)] }, ...overrides };
    return new Function(...Object.keys(state), `return ${readiness};`)(...Object.values(state));
  };
  assert.equal(ready(), true);
  assert.equal(ready({ hasRecording: false }), false);
  assert.equal(ready({ displayReadoutReady: false }), false);
  for (const display of [{ viewStart: 9, data: [1] }, { viewStart: 10, data: [] },
    { viewStart: 10, data: [1], refiningOverview: true }, { viewStart: 10, data: [1], unreadAfterSec: 12 }]) assert.equal(ready({ display }), false);
});

test("Recenter is above Gain; rendering uses the override without restarting signal processing", async () => {
  assert.match(page, /className="gain-control-stack"[\s\S]*?aria-label="Recenter channels"[\s\S]*?onClick=\{recenterChannels\}[\s\S]*?className="gain-control"/);
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.gain-control-stack\s*\{[^}]*flex-direction:\s*column/);
  const draw = page.slice(page.indexOf("const traceOrder"), page.indexOf("const scaleRow"));
  assert.equal([...draw.matchAll(/displayedTraceCenter\(display, channel, traceCenters\)/g)].length, 2, "exact and envelope paths use the same override for trace/ribbon");
  assert.match(page, /setGain\(1\);\s*setTraceCenters\(\{\}\)/);
  assert.match(page, /setTraceCenters\(normalizeTraceCenters\(workspace.traceCenters\)\)/);
});
