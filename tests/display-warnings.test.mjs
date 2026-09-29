import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { buildMontage } from "../app/eeg-core.ts";

const pageText = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const page = ts.createSourceFile("page.tsx", pageText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const require = createRequire(import.meta.url);
let warningNode;
function visit(node) {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(page) === "details"
    && node.openingElement.attributes.properties.some((prop) => ts.isJsxAttribute(prop)
      && prop.name.getText(page) === "className" && prop.initializer?.getText(page) === '"display-warnings"')) {
    assert.equal(warningNode, undefined, "one compact warning disclosure");
    warningNode = node;
  }
  ts.forEachChild(node, visit);
}
visit(page);
assert.ok(warningNode, "render display limitations even when waveform data is present");
let warningExpression = warningNode;
while (!ts.isJsxExpression(warningExpression)) warningExpression = warningExpression.parent;
const compiled = ts.transpileModule(`const result = (${warningExpression.expression.getText(page)});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const render = new Function("display", "require", "exports", `${compiled}\nreturn result;`);

function elements(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props?.children, predicate)];
}

function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (tree && typeof tree === "object") return text(tree.props?.children);
  return tree == null || typeof tree === "boolean" ? "" : String(tree);
}

const signals = (labels) => labels.map((_, index) => Float32Array.of(index, index + 1));

test("a partial scalp montage visibly reports omitted pairs while its usable traces remain available", () => {
  const allChannelLabels = ["Fp1", "F7", "T7", "P7", "O1"];
  const selected = allChannelLabels.slice(0, 2);
  const display = buildMontage(signals(selected), selected, "bipolar", new Set(), undefined, undefined,
    { allChannelLabels, sourceChannelIndices: [0, 1] });
  assert.deepEqual(display.labels, ["Fp1-F7"]);
  assert.ok(display.warnings.length > 1);
  const ui = render(display, require, {});
  assert.equal(ui.type, "details");
  assert.equal(ui.props.open, undefined, "many warnings start compact instead of displacing the plot");
  const summary = elements(ui, (node) => node.type === "summary")[0];
  assert.match(text(summary), new RegExp(`${display.warnings.length} display warnings`));
  assert.ok(text(summary).includes(display.warnings[0]), "first limitation is visible without expanding");
  assert.equal(summary.props.title, display.warnings[0]);
  assert.deepEqual(elements(ui, (node) => node.type === "li").map(text), display.warnings);
  assert.match(text(ui), /source channels is not selected/);
});

test("anatomical recorded-reference fallback is explicit even though signals are displayed", () => {
  const labels = ["LA1", "LB1"];
  const display = buildMontage(signals(labels), labels, "bipolar");
  assert.deepEqual(display.labels, labels);
  const ui = render(display, require, {});
  const summary = elements(ui, (node) => node.type === "summary")[0];
  assert.match(text(summary), /1 display warning/);
  assert.match(text(summary), /No MATLAB-style bipolar pairs were available; showing the recorded reference/);
  const status = elements(summary, (node) => node.props.role === "status")[0];
  assert.equal(status.props["aria-live"], "polite");
  assert.equal(status.props["aria-atomic"], "true");
  assert.equal(elements(ui, (node) => node.type === "ul")[0].props["aria-label"], "Display warning details");
});

test("valid views have no warning bar and empty views retain their existing dedicated error", () => {
  assert.equal(render({ data: [Float32Array.of(1)], warnings: [] }, require, {}), false);
  assert.equal(render({ data: [], warnings: ["No compatible channels"] }, require, {}), false);
  assert.match(pageText, /!display\.data\.length && !loadingSignal && <div className="no-channels" role="status"/);
});

test("native disclosure sits outside the waveform area, has keyboard focus, and caps expanded height", () => {
  assert.ok(ts.isJsxFragment(warningExpression.parent), "warning row is a plot sibling, not an overlay");
  const siblings = warningExpression.parent.children;
  const nextElement = siblings.slice(siblings.indexOf(warningExpression) + 1).find((node) => ts.isJsxElement(node));
  assert.ok(nextElement.openingElement.attributes.properties.some((prop) => ts.isJsxAttribute(prop)
    && prop.name.getText(page) === "className" && prop.initializer?.getText(page).includes("signal-and-tracks")));
  const rowCss = /\.display-warnings\s*\{([^}]+)\}/.exec(css)?.[1];
  assert.ok(rowCss);
  assert.doesNotMatch(rowCss, /position:\s*(?:absolute|fixed)/);
  assert.match(rowCss, /flex:\s*0 0 auto/);
  assert.match(css, /\.display-warnings summary:focus-visible\s*\{[^}]*outline:/);
  assert.match(css, /\.display-warnings ul\s*\{[^}]*max-height:\s*100px;[^}]*overflow-y:\s*auto/);
});
