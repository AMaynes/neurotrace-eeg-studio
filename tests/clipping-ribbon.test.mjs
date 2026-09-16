/** Exercises the real canvas ribbon helper without opening a browser. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import {
  clippingExcessIntensity,
  clippingSeverityColor,
  gaussianClippingHaloIntensity,
  traceClippingRange,
} from "../app/waveform-geometry.ts";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const helperStart = page.indexOf("function drawSampleClippingRibbon(");
const helperEnd = page.indexOf("function expectedEDFRecordBytes(", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart);
const helper = ts.transpileModule(page.slice(helperStart, helperEnd), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const inset = Number(page.match(/const TRACE_ROW_EDGE_INSET_PX\s*=\s*(\d+)/)?.[1]);
assert.ok(Number.isFinite(inset));
const draw = new Function(
  "traceClippingRange", "gaussianClippingHaloIntensity", "clippingSeverityColor", "clippingExcessIntensity",
  "TRACE_ROW_EDGE_INSET_PX", `${helper}\nreturn drawSampleClippingRibbon;`,
)(traceClippingRange, gaussianClippingHaloIntensity, clippingSeverityColor, clippingExcessIntensity, inset);

function render({ minima, maxima = minima, gaps, scale, baseline = 0 }) {
  const rectangles = [];
  const context = {
    fillStyle: "",
    fillRect(x, y, width, height) {
      rectangles.push({ x, y, width, height, color: this.fillStyle });
    },
  };
  draw(context, minima, maxima, gaps, 12, 1, 12, minima.length, 400, 10, 60, baseline, scale);
  return rectangles;
}

test("exact samples and extrema overviews paint equal overflow severity for counts, µV, and other units", () => {
  let expected;
  for (const scale of [.003, .216, 216]) {
    const baseline = -2_000;
    const range = traceClippingRange(60, baseline, scale, inset);
    const value = range.maximum + range.fullIntensityExcess / 2;
    const exact = render({ minima: [value], scale, baseline });
    const overview = render({ minima: [baseline], maxima: [value], gaps: [0], scale, baseline });
    assert.equal(exact.length, 2, "overflow has a halo and a stronger local peak");
    assert.deepEqual(overview, exact);
    assert.equal(exact[1].color, clippingSeverityColor(.5));
    expected ??= exact;
    assert.deepEqual(exact, expected, "unit conversion cannot change the same screen-space overflow");
    assert.deepEqual(render({ minima: [range.minimum, range.maximum], scale, baseline }), []);
  }
});

test("the canvas ribbon responds to gain while staying beneath the channel trace", () => {
  const scale = .216;
  const initialRange = traceClippingRange(60, 0, scale, inset);
  const samples = [initialRange.maximum * .9];
  assert.deepEqual(render({ minima: samples, scale }), []);
  const increasedGain = render({ minima: samples, scale: scale * 2 });
  assert.equal(increasedGain.length, 2);
  for (const rectangle of increasedGain) {
    assert.equal(rectangle.y, 67);
    assert.equal(rectangle.height, 3);
    assert.ok(rectangle.y > 10 + 60 - inset, "a gap separates clamped trace and overflow strip");
  }
});

test("gaps, invalid samples, and all-in-range data leave no false overflow rectangles", () => {
  assert.deepEqual(render({ minima: [0, 1, -1], scale: .216 }), []);
  assert.deepEqual(render({ minima: [30_000], gaps: [1], scale: .003 }), []);
  assert.deepEqual(render({ minima: [Number.NaN, Number.POSITIVE_INFINITY], scale: .003 }), []);
  assert.deepEqual(render({ minima: [0], maxima: [Number.NaN], scale: .003 }), []);
});

test("both exact and overview drawing restrict ribbons to clamped mode and pass the actual gain scale", () => {
  const drawing = page.slice(page.indexOf("const traceOrder"), page.indexOf("const scaleRow"));
  assert.match(drawing, /const confineTracesToRows\s*=\s*traceDisplayMode\s*===\s*"clamped"/);
  assert.match(drawing, /if \(confineTracesToRows\s*&&\s*envelopeWindowMatchesViewport/);
  assert.match(drawing, /if \(confineTracesToRows\)\s*\{\s*drawSampleClippingRibbon/);
  assert.equal([...drawing.matchAll(/drawSampleClippingRibbon\([\s\S]*?baseline,\s*scale,\s*\)/g)].length, 2);
  assert.doesNotMatch(drawing, /showMicrovoltClipping/);
});
