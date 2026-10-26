import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { annotationLabelTypeKey, collectLabelTypes, recordingLabelTypeKey } from "../app/label-visibility.ts";

const definitions = [
  { id: "recording-label", name: "Recording label", hidden: true },
  { id: "ictal", name: "Ictal" }, { id: "medication", name: "Medication" },
];
const fileLabel = (id, label) => ({ id, labelId: "recording-label", recordingLabel: { label },
  start: 1, end: 1, track: "instance", geometry: "point", status: "suggestion", confidence: 0 });

test("file label types remain individually filterable and source-event duplicates share a choice", () => {
  const labels = [fileLabel("a", " Stimulation "), fileLabel("b", "stimulation"), fileLabel("c", "Rest")];
  assert.equal(annotationLabelTypeKey(labels[0]), annotationLabelTypeKey(labels[1]));
  assert.notEqual(annotationLabelTypeKey(labels[0]), annotationLabelTypeKey(labels[2]));
  const types = collectLabelTypes(labels, [{ label: "STIMULATION" }], definitions);
  assert.equal(types.find((type) => type.key === recordingLabelTypeKey("Stimulation")).count, 3);
  assert.equal(types.find((type) => type.name === "Rest").count, 1);
  assert.equal(types.filter((type) => type.source === "recording").length, 2);
  assert.ok(types.some((type) => type.key === "annotation:ictal" && type.count === 0));
  assert.ok(!types.some((type) => type.name === "Recording label"));
});

test("reviewed labels follow their displayed annotation type while retaining original file provenance", () => {
  const reviewed = { ...fileLabel("reviewed", "Stimulation"), labelId: "ictal" };
  assert.equal(annotationLabelTypeKey(reviewed), "annotation:ictal");
  const types = collectLabelTypes([reviewed], [], definitions);
  assert.equal(types.find((type) => type.key === "annotation:ictal").count, 1);
  assert.ok(!types.some((type) => type.key === recordingLabelTypeKey("Stimulation")));
  assert.equal(reviewed.recordingLabel.label, "Stimulation");
});

const require = createRequire(import.meta.url);
const component = await readFile(new URL("../app/label-visibility-filter.tsx", import.meta.url), "utf8");
const componentCode = ts.transpileModule(component, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;

function elements(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props?.children, predicate)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  return typeof tree === "string" || typeof tree === "number" ? String(tree) : tree && typeof tree === "object" ? text(tree.props.children) : "";
}
function filterHarness(options) {
  let cursor = 0, closed = 0;
  const state = [], exports = {};
  new Function("require", "exports", componentCode)((name) => {
    if (name === "react") return { useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], (next) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
    } };
    if (name.endsWith(".css")) return {};
    return require(name);
  }, exports);
  const props = { options, hiddenTypes: new Set(), onChange(hidden) { props.hiddenTypes = hidden; }, onClose() { closed++; } };
  return {
    props, get closed() { return closed; },
    render() { cursor = 0; return exports.LabelVisibilityFilter(props); },
    checkbox(tree, name) {
      const label = elements(tree, (node) => node.type === "label" && node.props.children[1].props.children[0] === name)[0];
      assert.ok(label, `checkbox for ${name}`);
      return label.props.children[0];
    },
    button(tree, name) {
      const button = elements(tree, (node) => node.type === "button" && text(node) === name)[0];
      assert.ok(button, `button ${name}`);
      return button;
    },
  };
}

test("filter checkboxes hide one type, preserve others, and support resetting all choices", () => {
  const options = collectLabelTypes([fileLabel("a", "Stimulation"), fileLabel("b", "Rest")], [], definitions);
  const ui = filterHarness(options);
  let tree = ui.render();
  const original = ui.props.hiddenTypes;
  ui.checkbox(tree, "Stimulation").props.onChange({ target: { checked: false } });
  tree = ui.render();
  assert.equal(ui.checkbox(tree, "Stimulation").props.checked, false);
  assert.equal(ui.checkbox(tree, "Rest").props.checked, true);
  assert.equal(original.size, 0, "checkbox updates do not mutate prior preferences");
  ui.button(tree, "Hide all types").props.onClick();
  tree = ui.render();
  assert.ok(elements(tree, (node) => node.type === "input" && node.props.type === "checkbox").every((node) => !node.props.checked));
  ui.button(tree, "Show all types").props.onClick();
  assert.equal(ui.props.hiddenTypes.size, 0);
  ui.button(ui.render(), "Done").props.onClick();
  assert.equal(ui.closed, 1);
});

test("type search is case-insensitive and large lists render only 100 choices at a time", () => {
  const options = Array.from({ length: 230 }, (_, index) => ({ key: `recording:${index}`, name: `Marker ${index}`, source: "recording", count: 1 }));
  const ui = filterHarness(options);
  let tree = ui.render();
  assert.equal(elements(tree, (node) => node.type === "input" && node.props.type === "checkbox").length, 100);
  ui.button(tree, "Show more types (130 remaining)").props.onClick();
  tree = ui.render();
  assert.equal(elements(tree, (node) => node.type === "input" && node.props.type === "checkbox").length, 200);
  elements(tree, (node) => node.props?.["aria-label"] === "Find label types")[0].props.onChange({ target: { value: "  MARKER 229  " } });
  tree = ui.render();
  assert.equal(elements(tree, (node) => node.type === "input" && node.props.type === "checkbox").length, 1);
  assert.equal(ui.checkbox(tree, "Marker 229").props.checked, true);
});

// Exercise the actual page projections so queue navigation and timed views
// cannot accidentally use the unfiltered data or renumber source entries.
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
  ts.forEachChild(node, visit);
}
visit(syntax);
function pageValues(names, scope) {
  const compiled = ts.transpileModule(names.map((name) => `const ${declarations.get(name).getText(syntax)};`).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(scope), `${compiled}\nreturn {${names.join(",")}};`)(...Object.values(scope));
}

test("hidden types disappear from timed views, session labels and queues while saved data and queue indices remain intact", () => {
  const annotations = Object.freeze([
    Object.freeze(fileLabel("stim", "Stimulation")), Object.freeze(fileLabel("rest", "Rest")),
    Object.freeze({ id: "context", labelId: "medication", start: 0, end: 10, track: "context", geometry: "session", confidence: 0 }),
  ]);
  const candidates = Object.freeze([{ id: "source", label: "Stimulation", time: 1, status: "queued", confidence: 0 }]);
  const before = JSON.stringify({ annotations, candidates });
  const scope = { annotations, candidates, hiddenLabelTypes: new Set([recordingLabelTypeKey("Stimulation"), "annotation:medication"]),
    annotationLabelTypeKey, recordingLabelTypeKey, useMemo: (callback) => callback(),
    annotationGeometry: (item) => item.geometry, annotationLabel: (item) => ({ name: item.recordingLabel?.label ?? item.labelId }),
    clamp: (value, min, max) => Math.min(max, Math.max(min, value)), queueSearch: "",
    labelsVisible: true, annotationDragPreview: null, meta: { durationSec: 10 }, viewStart: 0, timebase: 10,
    annotationOverlapsWindow: (item, start, end) => item.start <= end && item.end >= start,
  };
  const result = pageValues(["displayAnnotations", "instanceQueueEntries", "filteredQueueEntries", "sessionContextAnnotations", "renderAnnotations", "visibleAnnotations", "bottomAnnotations"], scope);
  assert.deepEqual(result.displayAnnotations.map((item) => item.id), ["rest"]);
  assert.deepEqual(result.sessionContextAnnotations, []);
  assert.deepEqual(result.renderAnnotations.map((item) => item.id), ["rest"]);
  assert.deepEqual(result.bottomAnnotations.map((item) => item.id), ["rest"]);
  assert.equal(result.instanceQueueEntries.length, 3, "source indices refer to the complete queue");
  assert.equal(result.filteredQueueEntries.length, 1);
  const match = result.filteredQueueEntries[0];
  assert.equal(result.instanceQueueEntries[match.index].id, "rest");
  assert.equal(JSON.stringify({ annotations, candidates }), before);
  const restored = pageValues(["displayAnnotations", "instanceQueueEntries", "filteredQueueEntries"], { ...scope, hiddenLabelTypes: new Set() });
  assert.equal(restored.displayAnnotations.length, 3);
  assert.equal(restored.filteredQueueEntries.length, 3);
});

test("changing a type filter clears annotation selection without editing annotations", () => {
  const state = {};
  const scope = { annotationSelectionRef: { current: { selectedIds: new Set(["hidden"]) } } };
  for (const name of ["setHiddenLabelTypes", "setSelectedAnnotationId", "setSelectedAnnotationIds", "setAnnotationSelectionBox", "setAnnotationDragPreview", "setQueueLimit"]) {
    scope[name] = (value) => { state[name] = value; };
  }
  const { changeHiddenLabelTypes } = pageValues(["changeHiddenLabelTypes"], scope);
  changeHiddenLabelTypes(new Set(["annotation:ictal"]));
  assert.equal(state.setSelectedAnnotationId, null);
  assert.equal(state.setSelectedAnnotationIds.size, 0);
  assert.equal(state.setAnnotationSelectionBox, null);
  assert.equal(scope.annotationSelectionRef.current, null);
});
