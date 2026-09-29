/** Execute the real cursor/readout JSX against exact samples and overview buckets. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { formatClock, formatDisplayChannelLabel } from "../app/eeg-core.ts";
import { readCursorReadout } from "../app/cursor-readout.ts";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map();
const variables = new Map();
const calls = [];
const publishedDisplays = [];
let footer;
let rowRenderer;
function collect(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    variables.set(node.name.text, node);
    if (node.name.text === "nextDisplay" && ts.isObjectLiteralExpression(node.initializer)) publishedDisplays.push(node.initializer);
  }
  if (ts.isCallExpression(node)) {
    calls.push(node);
    if (node.expression.getText(syntax) === "display.labels.map"
      && node.arguments[0]?.getText(syntax).includes("rowReadout")) rowRenderer = node.arguments[0];
  }
  if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some((attribute) =>
    ts.isJsxAttribute(attribute) && attribute.name.getText(syntax) === "className"
    && attribute.initializer && ts.isStringLiteral(attribute.initializer)
    && attribute.initializer.text === "cursor-readout")) footer = node;
  ts.forEachChild(node, collect);
}
collect(syntax);
assert.ok(footer);
assert.ok(rowRenderer);
const require = createRequire(import.meta.url);
function evaluate(code, expression, env = {}) {
  const javascript = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  return new Function("require", "exports", ...Object.keys(env), `${javascript}\nreturn ${expression};`)(require, {}, ...Object.values(env));
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  return tree?.props ? text(tree.props.children) : "";
}
function elements(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props?.children, predicate)];
}
const formatters = evaluate(["formatAmplitude", "formatCursorAmplitude", "formatCursorSample", "sourceRateForDisplayRow", "primarySampleRate"]
  .map((name) => functions.get(name).getText(syntax)).join("\n"),
"({ formatAmplitude, formatCursorAmplitude, formatCursorSample, sourceRateForDisplayRow })", { formatClock });

function display(overrides = {}) {
  return { settingsKey: JSON.stringify(["test-recording", "referential", { enabled: false }, [0]]),
    data: [new Float32Array([25])], labels: ["EEG LA1"], units: ["µV"],
    sampleRates: [1], sourceSampleRates: [4], startSecs: [10],
    sourceIndices: [[0]], primarySourceIndices: [0],
    envelopes: [{ minima: new Float32Array([0]), maxima: new Float32Array([100]),
      gaps: new Uint8Array(1), startSec: 10, bucketDurationSec: 1 }], ...overrides };
}
function harness(overrides = {}) {
  const env = {
    ...formatters, formatClock, formatDisplayChannelLabel, readCursorReadout,
    useMemo: (compute) => compute(), display: display(), focusedChannel: 0, cursorTime: 10.25,
    meta: { id: "test-recording" }, montage: "referential", filters: { enabled: false }, selectedChannels: new Set([0]),
    loadingSignal: false, cursorAmplitude: 999999,
    channelSelectionActive: true, inspectionDragging: false, inspectionRange: null,
    channelRailRowStyle: () => ({}), channelRowLayout: { groupStarts: new Set() },
    setFocusedChannel() {}, setChannelSelectionActive() {}, notifyTutorialAction() {},
    ...overrides,
  };
  for (const name of ["displaySettingsKey", "displayReadoutReady"]) {
    env[name] = evaluate(`const result = ${variables.get(name).initializer.getText(syntax)};`, "result", env);
  }
  env.cursorReadout = evaluate(`const result = ${variables.get("cursorReadout").initializer.getText(syntax)};`, "result", env);
  return {
    env,
    footer: () => evaluate(`const render = () => (${footer.getText(syntax)});`, "render()", env),
    row: () => evaluate(`const render = ${rowRenderer.getText(syntax)};`, "render(display.labels[0], 0)", env),
    info: () => {
      const props = { display: env.display, cursorReadout: env.cursorReadout, cursorTime: env.cursorTime,
        focusedChannel: 0, annotations: [], inspectionRange: null, selection: null, channelSelectionActive: true,
        montage: "referential", viewStart: 10, timebase: 1, hasRecording: true, companionBundle: {},
        meta: { channelLabels: ["LA1"], sampleRates: [4], durationSec: 20, format: "edf" } };
      return evaluate(functions.get("GeneralInfoPanel").getText(syntax), "GeneralInfoPanel(props)", {
        ...formatters, formatClock, formatDisplayChannelLabel, props, UploadedFilesPanel: () => null,
      });
    },
  };
}

test("actual footer labels overview ranges and bucket times without invented samples", () => {
  const ui = harness();
  const rendered = text(ui.footer());
  assert.match(rendered, /Range 0\.00 µV – 100 µV/);
  assert.match(rendered, /Overview 00:00:10\.000–00:00:11\.000 · zoom in for samples/);
  assert.doesNotMatch(rendered, /25\.0 µV|999999|source sample|display sample/);
});

test("actual footer shows the selected exact sample's time and correctly aligned source index", () => {
  const ui = harness({ cursorTime: 3.011, display: display({
    data: [new Float32Array([11, 22, 33])], envelopes: [null],
    sampleRates: [200], sourceSampleRates: [200], startSecs: [3.005],
  }) });
  const rendered = text(ui.footer());
  assert.match(rendered, /22\.0 µV/);
  assert.match(rendered, /source sample 602 · 00:00:03\.010/);
  assert.doesNotMatch(rendered, /Overview|999999/);
  const unaligned = harness({ cursorTime: 1 / 128, display: display({
    data: [new Float32Array([1, 2])], envelopes: [null], sampleRates: [128], sourceSampleRates: [200], startSecs: [0],
  }) });
  assert.match(text(unaligned.footer()), /display sample 1 · 00:00:00\.008/);
  assert.doesNotMatch(text(unaligned.footer()), /source sample/);
});

test("actual inspector agrees with the footer about overview range and interval", () => {
  const ui = harness();
  const rendered = text(ui.info());
  assert.match(rendered, /Overview amplitude rangeRange 0\.00 µV – 100 µV/);
  assert.match(rendered, /Bucket intervalOverview 00:00:10\.000–00:00:11\.000 · zoom in for samples/);
  assert.doesNotMatch(rendered, /25\.0 µV|999999|source sample/);
  const sample = harness({ display: display({ data: [new Float32Array([7])], envelopes: [null] }), cursorTime: 10 });
  assert.match(text(sample.info()), /Pointer amplitude7\.00 µV/);
  assert.match(text(sample.info()), /Samplesource sample 40 · 00:00:10\.000/);
});

test("actual channel rail never presents a bucket average as a measured amplitude", () => {
  const row = harness().row();
  assert.match(text(row), /LA1Overview range/);
  assert.equal(row.props.title, "Range 0.00 µV – 100 µV");
  assert.doesNotMatch(text(row), /25\.0|999999/);
  const exactRow = harness({ cursorTime: 10, display: display({ data: [new Float32Array([7])], envelopes: [null] }) }).row();
  assert.match(text(exactRow), /LA17\.00 µV/);
  const loadingRow = harness({ loadingSignal: true }).row();
  assert.equal(text(loadingRow), "LA1—");
  assert.match(loadingRow.props.title, /unavailable/i);
  assert.doesNotMatch(loadingRow.props.title, /Range|25|100/,
    "loading tooltips must not disclose the previous display's measured values");
});

test("loading, missing data, or replacing the display cannot retain a saved amplitude", () => {
  for (const options of [
    { loadingSignal: true },
    { cursorTime: 30 },
    { display: display({ data: [new Float32Array([NaN])], envelopes: [null] }) },
  ]) {
    const ui = harness(options);
    assert.equal(ui.env.cursorReadout.kind, "unavailable");
    assert.match(text(ui.footer()), /Sample unavailable/);
    assert.match(text(ui.info()), /Sample unavailable/);
    assert.doesNotMatch(text(ui.footer()), /Range|25\.0 µV|999999|source sample/);
  }
  const afterRefresh = harness({ cursorTime: 10, display: display({ data: [new Float32Array([-20])], envelopes: [null] }) });
  assert.match(text(afterRefresh.footer()), /-20\.0 µV/);
  assert.equal(calls.some((call) => call.expression.getText(syntax) === "setCursorAmplitude"), false,
    "session/project restoration must not reinstate an old scalar into a separate cursor-amplitude state");
  const scalar = evaluate(`const value = ${variables.get("cursorAmplitude").initializer.getText(syntax)};`, "value", harness().env);
  assert.equal(scalar, null, "legacy snapshot serializes unavailable/range values as null, never an overview average");
});

test("changing source, montage, filters, or selected channels invalidates values before loading starts", () => {
  for (const options of [
    { meta: { id: "another-recording" } },
    { montage: "bipolar" },
    { filters: { enabled: true, highPassHz: .5, lowPassHz: 70, notchHz: 60, zeroPhase: true } },
    { selectedChannels: new Set([0, 1]) },
  ]) {
    const pending = harness({ ...options, loadingSignal: false });
    assert.equal(pending.env.displayReadoutReady, false, "the previous display cannot use a new settings label");
    assert.match(text(pending.footer()), /Sample unavailable/);
    assert.match(text(pending.info()), /Sample unavailable/);
    assert.equal(text(pending.row()), "LA1—");
    assert.equal(pending.row().props.title, "Signal readout unavailable");
    const refreshed = harness({ ...options, display: display({ settingsKey: pending.env.displaySettingsKey }) });
    assert.equal(refreshed.env.displayReadoutReady, true);
    assert.match(text(refreshed.footer()), /Range 0\.00 µV – 100 µV/);
  }
  const disabledFilterChange = harness({ filters: { enabled: false, highPassHz: 2 } });
  assert.equal(disabledFilterChange.env.displayReadoutReady, true,
    "changing unused filter controls does not falsely invalidate unchanged raw data");
});

test("progressive overview, refined overview, and exact samples all publish their settings identity", () => {
  assert.equal(publishedDisplays.length, 4, "verify MATLAB and legacy display publication paths");
  for (const object of publishedDisplays) {
    const key = object.properties.find((property) => ts.isPropertyAssignment(property)
      && property.name.getText(syntax) === "settingsKey");
    assert.ok(key, "every display carries the settings used to generate its values");
    assert.equal(evaluate(`const result = ${key.initializer.getText(syntax)};`, "result", {
      displaySettingsKey: "settings-at-request-time",
    }), "settings-at-request-time");
  }
});

test("cursor readout dependencies are initialized before first-render evaluation", () => {
  const readoutPosition = variables.get("cursorReadout").pos;
  for (const name of ["display", "focusedChannel", "loadingSignal", "cursorTime"]) {
    const dependency = calls.find((call) => call.parent && ts.isVariableDeclaration(call.parent)
      && ts.isArrayBindingPattern(call.parent.name)
      && call.parent.name.elements.some((element) => ts.isBindingElement(element) && element.name.getText(syntax) === name));
    assert.ok(dependency?.pos < readoutPosition, `${name} state is initialized before the derived readout`);
  }
  assert.ok(variables.get("displaySettingsKey").pos < variables.get("displayReadoutReady").pos);
  assert.ok(variables.get("displayReadoutReady").pos < readoutPosition);
  const empty = harness({ cursorTime: 0, display: display({ data: [], labels: [], units: [], envelopes: [] }) });
  assert.doesNotThrow(() => empty.footer());
  assert.equal(empty.env.cursorReadout.kind, "unavailable");
  assert.equal(elements(empty.footer(), (element) => element.type === "span").length > 0, true);
});
