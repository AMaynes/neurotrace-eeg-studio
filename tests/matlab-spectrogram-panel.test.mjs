/** Executes production panel request and raster helpers, without a browser/GPU. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map((node) => [node.name.text, node]));
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const rasterSource = ["matlabJet", "rasterizeMatlabSpectrogram"].map((name) => functions.get(name).getText(ast)).join("\n");
const { rasterize, jet } = new Function("clamp", `${transpile(rasterSource)}\nreturn { rasterize: rasterizeMatlabSpectrogram, jet: matlabJet };`)(clamp);
const analysisNote = new Function("formatClock", `${transpile(["spectrogramAnalysisRange", "spectrogramAnalysisNote"]
  .map((name) => functions.get(name).getText(ast)).join("\n"))}\nreturn spectrogramAnalysisNote;`)((seconds) => seconds.toFixed(3));
const panel = functions.get("SpectrogramPanel");
let computeEffect;
const visit = (node) => {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect"
    && node.arguments[0]?.getText(ast).includes("computeMatlabSpectrogramOffThread")) computeEffect = node.arguments[0];
  ts.forEachChild(node, visit);
};
visit(panel);
assert.ok(computeEffect);
const runEffect = (bindings) => new Function(...Object.keys(bindings), `${transpile(`const run = ${computeEffect.getText(ast)};`)}\nreturn run();`)(...Object.values(bindings));

const rgba = (pixels, index) => [...pixels.slice(index * 4, index * 4 + 4)];
const mappedColor = (z, limit) => [...jet(Math.round(clamp((z + limit) / (2 * limit), 0, 1) * 255) / 255), 255];

function spectrum(overrides = {}) {
  return { width: 5, height: 4, dataStart: 10, sampleRate: 1,
    times: Float64Array.from([0, 1, 2, 3, 4]),
    // Deliberately nonuniform interior analysis frequencies.
    frequencies: Float64Array.from([1, 3, 12, 150]),
    zScores: Float64Array.from({ length: 20 }, (_, index) => index - 10),
    colorLimit: 20, ...overrides };
}

test("raster uses MATLAB imagesc uniform endpoint rows, not logarithmic-frequency row heights", () => {
  const source = spectrum();
  const pixels = new Uint8ClampedArray(5 * 4 * 4);
  const halfFrequencyStep = (150 - 1) / 3 / 2;
  rasterize(pixels, 5, 4, source, 9.5, 5, 1 - halfFrequencyStep, 150 + halfFrequencyStep, 20);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) {
    assert.deepEqual(rgba(pixels, y * 5 + x), mappedColor(source.zScores[(3 - y) * 5 + x], 20));
  }
});

test("raster preserves absolute time during pan/crop and never stretches absent data to viewport edges", () => {
  const source = spectrum({ height: 1, frequencies: new Float64Array([1]), zScores: new Float64Array([-2, -1, 0, 1, 2]) });
  const pixels = new Uint8ClampedArray(4 * 4);
  rasterize(pixels, 4, 1, source, 12.5, 4, .5, 1.5, 2);
  assert.deepEqual(rgba(pixels, 0), mappedColor(1, 2));
  assert.deepEqual(rgba(pixels, 1), mappedColor(2, 2));
  assert.deepEqual(rgba(pixels, 2), [7, 18, 22, 255]);
  assert.deepEqual(rgba(pixels, 3), [7, 18, 22, 255]);
  source.zScores[3] = NaN;
  rasterize(pixels, 4, 1, source, 12.5, 4, .5, 1.5, 2);
  assert.deepEqual(rgba(pixels, 0), [7, 18, 22, 255]);
});

test("raster work is bounded by output pixels, not all N by 60 transform values", () => {
  let reads = 0;
  const source = spectrum({ width: 100000, height: 60, sampleRate: 1000,
    times: { 0: 0, 99999: 99.999 }, frequencies: { 0: 1, 59: 150 },
    zScores: new Proxy({}, { get() { reads++; return 0; } }) });
  const width = 320, height = 120;
  rasterize(new Uint8ClampedArray(width * height * 4), width, height, source, 10, 100, 0, 150, 1);
  assert.equal(reads, width * height);
  assert.ok(reads < source.width * source.height / 100);
});

test("an hours-wide view explicitly discloses the local analysis range without stretching its heatmap", () => {
  const source = spectrum({ width: 6001, sampleRate: 200, dataStart: 100,
    times: { 0: 0, 6000: 30 } });
  assert.equal(analysisNote(source, 21604), "Wavelets cover 100.000–130.000 only. Zoom in for detail.");
  assert.equal(analysisNote(source, 30), "");
  assert.match(panel.getText(ast), /ctx\.fillText\(analysisNote,/);
  assert.match(panel.getText(ast), /Analysis: \$\{spectrogramAnalysisRange\(spectrum\)\}/);
});

function harness(overrides = {}) {
  const requests = [], states = [], metrics = [];
  const inputs = [{ data: new Float64Array([1, 2, 3]), dataStart: 5.125, sampleRate: 200 },
    { data: new Float64Array([4, 5, 6]), dataStart: 5.125, sampleRate: 200 }];
  const result = { ...spectrum(), metrics: { computeMs: 4, inputCopyMs: 1 } };
  const bindings = {
    signals: inputs, overview: false, sampleRate: 200, dataStart: 5.125, baselineTime: 5.13,
    performanceDiagnostics: { beginDecode: () => ({ finish: (value) => metrics.push(["finish", value]), cancel: () => metrics.push(["cancel"]), fail: () => metrics.push(["fail"]) }) },
    computeMatlabSpectrogramOffThread: (request, options) => { requests.push({ request, options }); return Promise.resolve(result); },
    setSpectrumState: (state) => states.push(state), isAbortFailure: (error) => error?.name === "AbortError",
    ...overrides,
  };
  return { bindings, requests, states, metrics, inputs, result };
}

test("production panel sends synchronized raw group samples and clicked baseline to the MATLAB worker", async () => {
  const h = harness();
  const cleanup = runEffect(h.bindings);
  await Promise.resolve();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].request, { data: h.inputs.map((input) => input.data), sampleRate: 200, dataStart: 5.125, baselineTime: 5.13 });
  assert.equal(h.requests[0].request.data[0], h.inputs[0].data, "panel does not whiten, filter, or resample input");
  assert.equal(h.states[0].result, h.result);
  assert.equal(h.states[0].baselineTime, 5.13);
  assert.equal(h.metrics[0][0], "finish");
  cleanup();
  assert.equal(h.requests[0].options.signal.aborted, true);
});

test("cancelled panel work cannot publish stale spectrum and incompatible group timing is rejected", async () => {
  let resolve;
  const h = harness({ computeMatlabSpectrogramOffThread: () => new Promise((done) => { resolve = done; }) });
  const cleanup = runEffect(h.bindings);
  cleanup();
  resolve(h.result);
  await Promise.resolve();
  assert.equal(h.states.length, 0);
  const invalid = harness();
  invalid.inputs[1].dataStart += .005;
  runEffect(invalid.bindings);
  await Promise.resolve();
  assert.equal(invalid.requests.length, 0);
  assert.match(invalid.states[0].error, /synchronized raw channels/);
});

test("a late ordinary error from a cancelled worker cannot replace a newer completed spectrum", async () => {
  let rejectOld;
  const published = [];
  const old = harness({
    setSpectrumState: (state) => published.push(state),
    computeMatlabSpectrogramOffThread: () => new Promise((_resolve, reject) => { rejectOld = reject; }),
  });
  const cancelOld = runEffect(old.bindings);
  cancelOld();
  const current = harness({ setSpectrumState: (state) => published.push(state), baselineTime: 5.135 });
  runEffect(current.bindings);
  await Promise.resolve();
  assert.equal(published.length, 1);
  assert.equal(published[0].result, current.result);
  rejectOld(new Error("Worker load failed after the view changed"));
  await Promise.resolve();
  assert.equal(published.length, 1, "the stale error must not erase the new result and leave the panel loading");
  assert.equal(old.metrics.at(-1)[0], "cancel");
});

test("production UI uses symmetric current-result color limits and a cached image, without retired processing controls", () => {
  const source = panel.getText(ast);
  assert.match(source, /spectrum\.colorLimit \* Math\.exp\(colorLimitShift\)/);
  assert.match(source, /spectrumState\.baselineTime === baselineTime/);
  assert.match(source, /createImageData\(imageWidth, imageHeight\)/);
  assert.match(source, /putImageData\(image, 0, 0\)/);
  assert.match(source, /ctx\.drawImage\(raster\.canvas/);
  assert.match(source, /raster\.spectrum !== spectrum \|\| raster\.key !== rasterKey/);
  assert.doesNotMatch(source, /DPSS|Whitening|multitaper|smoothingSeconds|thetaRatio|stableSpectrogramColorLimits|for \(let frame/);
  assert.match(source, /onFrequencyRangeChange\(\{ min: 0, max: 150 \}\)/);
  assert.match(source, /onZoom\(timeRange, nextFrequencyRange\)/);
  assert.match(source, /shortcutAction\(event, controlBindings, \["spectrogram"\]\)/);
  assert.match(source, /aria-label="Spectrogram calculation warnings"/);
  assert.match(source, /spectrum\.warnings\.map/);
  assert.equal((source.match(/clamp\(value [+-] 0\.1, -6, 6\)/g) ?? []).length, 4, "both mouse and keyboard color adjustments remain finite");
});
