import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { buildMontage } from "../app/eeg-core.ts";
import { buildChannelRowLayout } from "../app/channel-layout.ts";
import { centerDisplayWindow } from "../app/trace-centering.ts";

// Execute the real canvas layout effect. Capture the signal geometry passed to
// its renderer so scrolling can only translate rows, never recenter/reprocess.
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let paintEffect;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(syntax) === "useLayoutEffect"
    && node.arguments[0]?.getText(syntax).includes("waveDrawRef.current = draw")) paintEffect = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(syntax);
assert.ok(paintEffect, "real waveform effect must be located");
const effectCode = ts.transpileModule(`const paint = ${paintEffect.getText(syntax)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText + "\nreturn paint();";

function fixture(mode = "referential", source) {
  const labels = ["LA1", "LA2", "LA3", "RA1", "RA2", "RA3"];
  source ??= labels.map((_, index) => Float64Array.from({ length: 300 }, (_, sample) =>
    500 * (index + 1) + 20 * Math.sin(sample * (index + 1) * .1)));
  const montage = buildMontage(source, labels, mode, new Set(), labels.map(() => 100), labels.map(() => 0));
  return centerDisplayWindow({ ...montage, traceBaselines: [], units: montage.labels.map(() => "µV"),
    startSecs: montage.sampleStartSecs, envelopes: montage.labels.map(() => null),
    viewStart: 0, viewDuration: 3, flatlineRegions: [], settingsKey: mode });
}

function harness(display = fixture(), overrides = {}) {
  const traces = [], ribbons = [];
  let clears = 0, finishes = 0;
  const context = new Proxy({
    measureText: () => ({ width: 30 }),
    fillRect() { clears++; },
  }, { get: (target, key) => key in target ? target[key] : () => {} });
  const env = {
    canvasRef: { current: { width: 800, height: 208,
      getBoundingClientRect: () => ({ width: 800, height: 208 }), getContext: () => context } },
    boundedCanvasScale: () => 1, window: { devicePixelRatio: 1 },
    performanceDiagnostics: { beginRender: () => ({ finish() { finishes++; } }), recordCanvasSurface() {}, removeCanvasSurface() {} },
    display, displaySettingsKey: display.settingsKey, viewStart: 0, timebase: 3,
    measuredTimeGridInterval: () => 1, formatTimeGridClock: String,
    activeCandidateTime: null, activeCandidateVisible: false, CHANNEL_RAIL_HEADER_HEIGHT: 28,
    expandedChannels: true, channelRowLayout: buildChannelRowLayout(display.labels, false),
    waveformVerticalViewport: null, waveformScrollRef: { current: { scrollTop: 0 } },
    channelScrollOffsetRef: { current: 120 }, channelSelectionActive: false, focusedChannel: 0,
    labelsVisible: false, annotations: [], traceDisplayMode: "clamped", legacyRawCountDisplay: false,
    gain: 1, LEGACY_RAW_COUNTS_PER_ROW: 15000,
    drawContinuousTrace(_context, values, start, interval, offset, view, duration, width, center, rowTop, rowHeight, baseline, scale, clamped) {
      traces.push({ values: [...values], start, interval, offset, view, duration, width, center, rowTop, rowHeight, baseline, scale, clamped });
      return false;
    },
    drawSampleClippingRibbon(_context, _min, _max, _gaps, _start, _interval, _view, _duration, _width, rowTop, rowHeight, baseline, scale) {
      ribbons.push({ rowTop, rowHeight, baseline, scale });
    },
    envelopeWindowMatchesViewport: () => true,
    clamp: (value, min, max) => Math.min(max, Math.max(min, value)), formatAmplitude: String,
    markOnset: null, waveDrawRef: { current: () => {} }, ...overrides,
  };
  const cleanup = new Function(...Object.keys(env), effectCode)(...Object.values(env));
  return { env, traces, ribbons, cleanup, get clears() { return clears; }, get finishes() { return finishes; },
    redraw(scrollTop) {
      traces.length = 0; ribbons.length = 0;
      if (scrollTop !== undefined) env.waveformScrollRef.current.scrollTop = scrollTop;
      env.waveDrawRef.current();
    } };
}

test("real paint uses live clamped scrollTop, not a stale offset after montage row-count changes", () => {
  const h = harness();
  assert.equal(h.traces[0].rowTop, 28, "stale ref says 120 but browser has already clamped to zero");
  const initial = structuredClone(h.traces);
  h.redraw(60);
  for (const trace of h.traces) {
    const original = initial.find((item) => item.baseline === trace.baseline);
    if (original) assert.deepEqual(trace, { ...original, rowTop: original.rowTop - 60, center: original.center - 60 });
  }
  h.redraw(0);
  assert.deepEqual(h.traces, initial, "scrolling down and back restores identical samples and geometry");
  for (let i = 0; i < h.traces.length; i++) assert.equal(h.ribbons[i].baseline, h.traces[i].baseline);
  h.cleanup();
});

test("paint refuses old montage/filter data, including imperative scroll redraws", () => {
  const h = harness(fixture(), { displaySettingsKey: "bipolar" });
  assert.equal(h.clears, 1); assert.equal(h.finishes, 1); assert.equal(h.traces.length, 0);
  h.redraw(60);
  assert.equal(h.clears, 2); assert.equal(h.finishes, 2); assert.equal(h.traces.length, 0);
  h.cleanup(); h.redraw(0);
  assert.equal(h.clears, 2, "detached layout callbacks cannot repaint stale data");
});

test("recorded → average → bipolar → recorded restores identical signal centers and painting", () => {
  const source = Array.from({ length: 6 }, (_, row) => Float64Array.from({ length: 300 }, (_, sample) =>
    row * 500 + sample / 10 + 20 * Math.sin(sample * .2 + row)));
  const original = structuredClone(source);
  const first = fixture("referential", source), firstPaint = harness(first);
  for (let pass = 0; pass < 3; pass++) {
    for (const mode of ["average", "bipolar"]) {
      const display = fixture(mode, source), mounted = harness(display);
      assert.ok(display.data.length > 0);
      mounted.redraw(120); mounted.redraw(0); mounted.cleanup();
    }
    const restored = fixture("referential", source), painted = harness(restored);
    assert.deepEqual(restored, first);
    assert.deepEqual(painted.traces, firstPaint.traces);
    assert.deepEqual(source, original, "display centering must never mutate original samples");
    painted.cleanup();
  }
  firstPaint.cleanup();
});

test("overview traces and clipping ribbons use the same prepared baseline on every scroll", () => {
  const display = fixture();
  display.envelopes = display.data.map((values) => ({ startSec: 0, bucketDurationSec: .01,
    minima: Float64Array.from(values, (x) => x - 2), maxima: Float64Array.from(values, (x) => x + 2), gaps: new Uint8Array(values.length) }));
  const h = harness(display), initial = structuredClone(h.traces);
  h.redraw(60); h.redraw(0);
  assert.deepEqual(h.traces, initial);
  assert.equal(h.traces[0].offset, .5);
  for (let i = 0; i < h.traces.length; i++) assert.equal(h.ribbons[i].baseline, h.traces[i].baseline);
  h.cleanup();
});
