/** The actual canvas helper must warn whenever its visible row clamp changes a sample. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { visitWaveformPeakSamples } from "../app/waveform-peak-path.ts";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(["confineTraceYValueToRow", "traceYOverflowsRow", "drawContinuousTrace"]);
const declarations = ast.statements.filter((node) =>
  (ts.isFunctionDeclaration(node) && names.has(node.name?.text))
  || (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
    declaration.name.getText(ast) === "TRACE_ROW_EDGE_INSET_PX")));
assert.equal(declarations.length, 4);
const helpers = ts.transpileModule(declarations.map((node) => node.getText(ast)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { confine, overflows, draw } = new Function("visitWaveformPeakSamples", `${helpers}
  return { confine: confineTraceYValueToRow, overflows: traceYOverflowsRow, draw: drawContinuousTrace };
`)(visitWaveformPeakSamples);

function render({ values, extrema, gaps, clamped = true, rowTop = 10, rowHeight = 60, baseline = 0, scale = 1 }) {
  const points = [];
  const context = {
    beginPath() {}, stroke() {},
    moveTo(x, y) { points.push({ command: "move", x, y }); },
    lineTo(x, y) { points.push({ command: "line", x, y }); },
  };
  const overflow = draw(context, values, 0, 1, extrema ? .5 : 0, 0, values.length, 400,
    rowTop + rowHeight / 2, rowTop, rowHeight, baseline, scale, clamped, 0, 2000, gaps, extrema);
  return { overflow, points };
}

test("overflow uses the same inset limits as drawing, including compact rows and exact boundaries", () => {
  for (const rowHeight of [1, 6, 8, 60]) {
    const rowTop = 10, edgeInset = Math.min(4, rowHeight / 2);
    const top = rowTop + edgeInset, bottom = rowTop + rowHeight - edgeInset;
    for (const y of [top, bottom, (top + bottom) / 2]) {
      assert.equal(confine(y, rowTop, rowHeight), y);
      assert.equal(overflows(y, rowTop, rowHeight), false, "touching the clamp without alteration is not overflow");
    }
    for (const y of [top - 1e-7, bottom + 1e-7, rowTop - 100, rowTop + rowHeight + 100]) {
      assert.notEqual(confine(y, rowTop, rowHeight), y);
      assert.equal(overflows(y, rowTop, rowHeight), true, "every altered coordinate requires a warning");
    }
  }
});

test("raw and overview paths flag both inset-only excursions without changing their continuous geometry", () => {
  const exact = render({ values: [0, 27, -27, 0] });
  assert.equal(exact.overflow, true);
  assert.deepEqual(exact.points.map((point) => point.y), [40, 14, 66, 40]);
  assert.deepEqual(exact.points.map((point) => point.command), ["move", "line", "line", "line"]);
  for (const value of [-27, 27]) {
    const overview = render({ values: [0], extrema: { minima: [Math.min(0, value)], maxima: [Math.max(0, value)] }, gaps: [0] });
    assert.equal(overview.overflow, true, "bucket extrema, not its mean, determine the warning");
    assert.deepEqual(overview.points.map((point) => point.x), [200, 200]);
    assert.deepEqual(overview.points.map((point) => point.y), value < 0 ? [66, 40] : [40, 14]);
  }
});

test("raw and overview samples exactly on either visible limit do not produce false clipping warnings", () => {
  assert.equal(render({ values: [-26, 0, 26] }).overflow, false);
  assert.equal(render({ values: [0], extrema: { minima: [-26], maxima: [26] }, gaps: [0] }).overflow, false);
});

test("the observed EDF peak within the old row boundary now warns in both paths", () => {
  const maximum = 126.00772094726562;
  const settings = { rowTop: 300, baseline: -0.07534904778003693, scale: .216 };
  const rawY = 330 - (maximum - settings.baseline) * settings.scale;
  assert.ok(rawY > 300 && rawY < 304, "reproduces clipping inside the old overflow threshold");
  const exact = render({ ...settings, values: [maximum] });
  const overview = render({ ...settings, values: [0], extrema: { minima: [0], maxima: [maximum] }, gaps: [0] });
  assert.equal(exact.overflow, true);
  assert.equal(overview.overflow, true);
  assert.equal(exact.points[0].y, 304);
  assert.equal(overview.points[1].y, 304);
});

test("Overlap mode and missing samples never acquire row-clipping arrows", () => {
  const exact = render({ values: [0, 27, -27, 0], clamped: false });
  assert.equal(exact.overflow, false);
  assert.deepEqual(exact.points.map((point) => point.y), [40, 13, 67, 40]);
  assert.equal(render({ values: [0], extrema: { minima: [-10000], maxima: [10000] }, gaps: [0], clamped: false }).overflow, false);
  assert.equal(render({ values: [NaN, Infinity, -Infinity] }).overflow, false);
  assert.equal(render({ values: [0], extrema: { minima: [-10000], maxima: [10000] }, gaps: [1] }).overflow, false);
});
