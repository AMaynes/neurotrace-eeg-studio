import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { RawDatSource, aggregateEnvelopeWindow, buildEnvelopePyramid, selectEnvelopePyramidLevel, sliceEnvelopeWindow, prepareClinicalDisplaySignals } from "../app/eeg-core.ts";
import { visitWaveformPeakSamples } from "../app/waveform-peak-path.ts";
import { envelopeWindowMatchesViewport } from "../app/waveform-geometry.ts";

test("zoom preserves both source peak amplitudes and times in dense exact traces", () => {
  const rate = 1024;
  const values = Float32Array.from({ length: rate * 20 }, (_, i) => 12 * Math.sin(i * .13));
  values[10240] = 1000;
  values[10300] = -875;
  for (const duration of [8.3, 8.2, 8.1, 8, 7.9, 7.8, 4, 1, .25]) {
    const start = 10 - duration * .37;
    const first = Math.floor(start * rate);
    const end = Math.ceil((start + duration) * rate);
    const input = values.slice(first, end);
    // The viewer requests source-resolution processing; only geometry is reduced.
    const prepared = prepareClinicalDisplaySignals([input], [rate], input.length, [first]);
    assert.equal(prepared.factors[0], 1);
    const points = [];
    visitWaveformPeakSamples(prepared.data[0], 0, input.length,
      (index) => ((first + index) / rate - start) / duration * 600,
      (index, value) => points.push({ time: (first + index) / rate, value }));
    assert.equal(Math.max(...points.map((point) => point.value)), 1000);
    assert.equal(Math.min(...points.map((point) => point.value)), -875);
    assert.equal(points.find((point) => point.value === 1000).time, 10);
    assert.equal(points.find((point) => point.value === -875).time, 10300 / rate);
    assert.ok(points.length <= 4 * 603, "finite traces need at most four source points per pixel");
  }
});

test("cached overview crops eliminate the reproduced 811-to-711-to-812 zoom oscillation", async () => {
  const rate = 256;
  const bytes = new ArrayBuffer(rate * 20 * 2);
  const view = new DataView(bytes);
  for (let i = 0; i < rate * 20; i += 1) {
    view.setInt16(i * 2, Math.round(1000 * Math.exp(-(((i / rate - 10) / .014) ** 2))), true);
  }
  const source = await RawDatSource.create(new File([bytes], "zoom-fixture.dat"), { sampleRate: rate, channelCount: 1 });
  const envelope = await source.getEnvelopeWindow(0, 20, rate * 20, [0]);
  const levels = buildEnvelopePyramid(envelope, 32);
  const oldPeaks = [];
  for (const duration of [8.3, 8.2, 8.1, 8, 7.9, 7.8, 4, 1, .25]) {
    const start = 10 - duration * .37;
    const columns = Math.max(1, Math.floor(600 * duration / 8.3));
    const legacy = aggregateEnvelopeWindow(envelope, start, duration, columns);
    oldPeaks.push(Math.max(...legacy.data[0]));
    for (const width of [300, 600, 1200]) {
      const level = selectEnvelopePyramidLevel(levels, duration / width);
      const cropped = sliceEnvelopeWindow(level, start, duration);
      assert.equal(Math.max(...cropped.maxima[0]), 1000);
      assert.equal(cropped.bucketDurationSec, level.bucketDurationSec);
      assert.ok(envelopeWindowMatchesViewport(cropped.startSec, cropped.bucketDurationSec, cropped.data[0].length, start, duration));
      const sourceIndex = Math.round((cropped.startSec - level.startSec) / level.bucketDurationSec);
      assert.deepEqual(cropped.data[0], level.data[0].slice(sourceIndex, sourceIndex + cropped.data[0].length));
    }
  }
  assert.ok(Math.max(...oldPeaks) - Math.min(...oldPeaks) > 90, "fixture reproduces the original amplitude jitter");
});

test("peak reduction preserves original order, flatlines, and breaks across missing samples", () => {
  const values = [0, 9, -4, 2, NaN, 6, 6, 6, NaN, -2];
  const points = [];
  visitWaveformPeakSamples(values, 0, values.length, () => 0,
    (index, value, beginsRun) => points.push({ index, value, beginsRun }));
  assert.deepEqual(points.map((point) => point.index), [0, 1, 2, 3, 5, 7, 9]);
  assert.deepEqual(points.filter((point) => point.beginsRun).map((point) => point.index), [0, 5, 9]);
  assert.ok(points.every((point) => values[point.index] === point.value));
  let calls = 0;
  visitWaveformPeakSamples([], 0, 0, () => 0, () => calls++);
  assert.equal(calls, 0);
});

test("viewer wires peak drawing and fixed-grid cropping without pixel-rate processing", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /const visibleEnvelope = sliceEnvelopeWindow\(/);
  assert.doesNotMatch(page, /aggregateEnvelopeWindow\(/);
  assert.match(page, /const processingPixelCount = Math\.max\(1, \.\.\.processingData\.map\(\(channel\) => channel\.length\)\)/);
  assert.match(page, /pixelCount: processingPixelCount/);
  assert.match(page, /visitWaveformPeakSamples\(values/);
  assert.match(page, /emit\(index, extrema\.minima\[index\], false\)/);
  assert.match(page, /emit\(index, extrema\.maxima\[index\], false\)/);
  assert.match(page, /envelope\.gaps,\s*envelope,/);
});

test("the canvas path keeps the same peak heights through zoom and overview transitions", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const source = page.slice(page.indexOf("const TRACE_ROW_EDGE_INSET_PX"), page.indexOf("function drawSampleClippingRibbon"));
  const draw = new Function("visitWaveformPeakSamples", `${ts.transpile(source, { target: ts.ScriptTarget.ES2022 })}\nreturn drawContinuousTrace;`)(visitWaveformPeakSamples);
  const values = new Float32Array(1024);
  values[512] = 500;
  values[532] = -300;
  for (const duration of [3, 2, 1, .5]) {
    for (const confine of [true, false]) {
      const ordinates = [];
      let strokes = 0;
      const context = { beginPath() {}, moveTo(_x, y) { ordinates.push(y); }, lineTo(_x, y) { ordinates.push(y); }, stroke() { strokes++; } };
      const start = 2 - duration * .37;
      draw(context, values, 0, 1 / 256, 0, start, duration, 100, 500, 0, 1000, 0, .2, confine, 0, 1000);
      assert.equal(Math.min(...ordinates), 400);
      assert.equal(Math.max(...ordinates), 560);
      assert.equal(strokes, 1);
      // Even an overview whose representative signal is attenuated must draw
      // its preserved source extrema, not that representative's peak height.
      ordinates.length = 0;
      draw(context, values.map((value) => value * .5), 0, 1 / 256, .5, start, duration, 100, 500, 0, 1000, 0, .2, confine, 0, 1000,
        new Uint8Array(values.length), { minima: values.map((value) => Math.min(0, value)), maxima: values.map((value) => Math.max(0, value)) });
      assert.equal(Math.min(...ordinates), 400);
      assert.equal(Math.max(...ordinates), 560);
    }
  }
});
