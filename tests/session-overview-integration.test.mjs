import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { RecordingOverviewCache } from "../app/recording-overview.ts";
import { buildSessionOverview } from "../app/session-overview.ts";

// Execute the actual page's memo, publication callback, and navigator JSX. This
// keeps data-flow regressions covered without mounting the unrelated workspace.
const pageText = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const page = ts.createSourceFile("page.tsx", pageText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const require = createRequire(import.meta.url);

function nodesWhere(predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(page);
  return matches;
}

function variable(name) {
  const matches = nodesWhere((node) => ts.isVariableDeclaration(node) && node.name.getText(page) === name);
  assert.equal(matches.length, 1, `one ${name} declaration in the page`);
  return matches[0];
}

function execute(source, scope) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  return new Function(...Object.keys(scope), "require", "exports", `${compiled}\nreturn result;`)(...Object.values(scope), require, {});
}

function expression(node, scope) {
  return execute(`const result = (${node.getText(page)});`, scope);
}

function fixture(ranges, { durationSec = ranges[0].length, complete = true, labels, recommended } = {}) {
  const channelLabels = labels ?? ranges.map((_, index) => `EEG${index + 1}`);
  const source = {
    meta: {
      id: "same-name", name: "same.edf", durationSec, channelCount: ranges.length,
      channelLabels, channelUnits: ranges.map(() => "µV"), sampleRates: ranges.map(() => 200),
      recommendedDisplayChannels: recommended,
    },
    getWindow() { assert.fail("navigator must not request raw signal data"); },
    getEnvelopeWindow() { assert.fail("navigator must not request envelope scans"); },
  };
  const window = {
    startSec: 0, durationSec: ranges[0].length, bucketDurationSec: 1,
    channelIndices: ranges.map((_, index) => index), channelLabels,
    channelUnits: source.meta.channelUnits, sampleRates: ranges.map(() => 1), channelStartSecs: ranges.map(() => 0),
    data: ranges.map((values) => Float32Array.from(values, ([min, max]) => (min + max) / 2)),
    minima: ranges.map((values) => Float32Array.from(values, ([min]) => min)),
    maxima: ranges.map((values) => Float32Array.from(values, ([, max]) => max)),
    gaps: ranges.map((values) => new Uint8Array(values.length)),
  };
  return { source, window, entry: { window, totalDurationSec: durationSec, complete, byteLength: 0 } };
}

function memoHarness(data) {
  let previousDeps;
  let previousValue;
  let builds = 0;
  const noRenderAccess = new Proxy({}, { get() { assert.fail("render must not access mutable source/cache refs"); } });
  const scope = {
    activeRecordingOverview: data.entry,
    hasRecording: true,
    meta: data.source.meta,
    selectedChannels: new Set(data.window.channelIndices),
    verifyingSource: false,
    sourceRef: noRenderAccess,
    recordingOverviewCacheRef: noRenderAccess,
    buildSessionOverview: (...args) => { builds += 1; return buildSessionOverview(...args); },
    useMemo(callback, deps) {
      if (!previousDeps || !deps.every((dep, index) => Object.is(dep, previousDeps[index]))) {
        previousDeps = deps;
        previousValue = callback();
      }
      return previousValue;
    },
  };
  return {
    scope,
    render: () => expression(variable("sessionOverview").initializer, scope),
    get builds() { return builds; },
  };
}

function elements(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props?.children, predicate)];
}

const overviewJsx = nodesWhere((node) => ts.isJsxElement(node)
  && node.openingElement.attributes.properties.some((prop) => ts.isJsxAttribute(prop)
    && prop.name.getText(page) === "className" && prop.initializer?.getText(page) === '"overview-block"'));
assert.equal(overviewJsx.length, 1, "one full-session navigator");

function renderOverview(sessionOverview, durationSec) {
  const jumps = [];
  const actions = [];
  const tree = expression(overviewJsx[0], {
    sessionOverview, meta: { durationSec }, viewStart: 0, timebase: durationSec / 4,
    formatDisplayChannelLabel: (label) => label, formatClock: (seconds) => `${seconds}s`,
    overviewRef: { current: null }, jumpTo: (seconds) => jumps.push(seconds),
    notifyTutorialAction: (action) => actions.push(action), labelsVisible: false, annotations: [],
    overviewLeft: 0, overviewWidth: 25,
  });
  return {
    tree, jumps, actions,
    bins: elements(tree, (node) => node.type === "i" && node.props.className?.startsWith("overview-bin ")),
    statuses: elements(tree, (node) => node.props.className === "overview-status"),
    track: elements(tree, (node) => node.props.className === "overview-track")[0],
  };
}

test("page navigator renders real indexed ranges from one named selected EEG channel", () => {
  const data = fixture([
    [[0, 1000], [0, 1], [0, 1], [0, 1]],
    [[0, 0], [-2, 3], [-10, 10], [-1, 1]],
  ], { labels: ["ECG", "Fp1"], recommended: [1] });
  const memo = memoHarness(data);
  const result = memo.render();
  assert.equal(result.channelIndex, 1);
  assert.equal(result.channelLabel, "Fp1");
  assert.deepEqual(result.bars.map((bar) => bar.peakToPeak), [0, 5, 20, 2]);
  const ui = renderOverview(result, 4);
  assert.deepEqual(ui.bins.map((node) => node.props.style.height), ["0%", "25%", "100%", "10%"]);
  assert.ok(ui.bins.every((node) => node.props.className === "overview-bin ready"));
  assert.equal(ui.statuses.length, 0);
  assert.match(ui.track.props["aria-label"], /Raw peak-to-peak.*Fp1/);
  assert.equal(ui.track.props.title, result.description);
});

test("panning, cursor, gain, and filter changes reuse the index without rescanning; publication and selection refresh it", () => {
  const data = fixture([[[0, 1], [0, 2]], [[0, 9], [0, 3]]], { labels: ["Fp1", "Fp2"] });
  const memo = memoHarness(data);
  const first = memo.render();
  Object.assign(memo.scope, { viewStart: 123, timebase: 3600, cursorTime: 100, gain: 20, filters: { enabled: true }, recordingOverviewRevision: 8 });
  assert.equal(memo.render(), first);
  assert.equal(memo.builds, 1);
  memo.scope.selectedChannels = new Set([1]);
  assert.equal(memo.render().channelLabel, "Fp2");
  assert.equal(memo.builds, 2);
  const replacement = fixture([[[0, 9], [0, 1]], [[0, 1], [0, 9]]], { labels: ["Fp1", "Fp2"] });
  memo.scope.activeRecordingOverview = replacement.entry;
  assert.deepEqual(memo.render().bars.map((bar) => bar.heightFraction), [1 / 9, 1]);
  memo.scope.meta = { ...memo.scope.meta, channelLabels: ["Fp1", "Renamed Fp2"] };
  assert.equal(memo.render().channelLabel, "Renamed Fp2");
  assert.equal(data.entry.window.channelLabels[1], "Fp2", "label refresh must not mutate published snapshots");
  memo.scope.activeRecordingOverview = undefined;
  memo.scope.verifyingSource = true;
  assert.equal(memo.render().status, "loading");
  memo.scope.verifyingSource = false;
  assert.equal(memo.render().status, "unavailable");
});

test("background overview publications cannot replace another active source or publish after cancellation", () => {
  const first = fixture([[[0, 1], [0, 9]]]);
  const second = fixture([[[0, 9], [0, 1]]]);
  const cache = new RecordingOverviewCache();
  const abortController = new AbortController();
  const entries = [];
  let revision = 0;
  const scope = {
    source: first.source, sourceRef: { current: first.source },
    verificationAbortController: abortController, recordingOverviewCacheRef: { current: cache },
    setActiveRecordingOverview: (entry) => entries.push(entry),
    setRecordingOverviewRevision: (update) => { revision = update(revision); },
  };
  const publish = expression(variable("publishRecordingOverview").initializer, scope);
  publish(first.window, true);
  assert.equal(entries.length, 1);
  assert.equal(entries[0], cache.get(first.source));
  assert.equal(revision, 1);
  scope.sourceRef.current = second.source;
  publish(first.window, true);
  assert.equal(entries.length, 1, "late result for same-name previous source must not change active state");
  assert.equal(cache.get(second.source), undefined);
  scope.sourceRef.current = first.source;
  abortController.abort();
  publish(first.window, true);
  assert.equal(entries.length, 1);
  assert.equal(revision, 1);
});

test("every source installation and session restore also installs or clears its matching cached overview", () => {
  const assignments = nodesWhere((node) => ts.isExpressionStatement(node)
    && ts.isBinaryExpression(node.expression) && node.expression.left.getText(page) === "sourceRef.current"
    && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken);
  assert.ok(assignments.length >= 2, "cover loading and snapshot restoration");
  const first = fixture([[[0, 1], [0, 9]]]);
  const second = fixture([[[0, 9], [0, 1]]]);
  const cache = new RecordingOverviewCache();
  assert.equal(cache.put(first.source, first.window, { complete: true }), true);
  for (const assignment of assignments) {
    const statements = assignment.parent.statements;
    const next = statements[statements.indexOf(assignment) + 1];
    assert.match(next.getText(page), /^setActiveRecordingOverview\(/, "source switch must reset overview in the same state update");
    for (const source of [first.source, second.source]) {
      let entry = first.entry;
      const sourceRef = { current: first.source };
      execute(`${assignment.getText(page)}\n${next.getText(page)}\nconst result = undefined;`, {
        source, snapshot: { source }, sourceRef, recordingOverviewCacheRef: { current: cache },
        setActiveRecordingOverview: (value) => { entry = value; },
      });
      assert.equal(sourceRef.current, source);
      assert.equal(entry, cache.get(source), "uncached/new/blank source clears old activity instead of relabeling it");
    }
  }
});

test("navigator uses each real bucket's time bounds, including unequal-width reduced bins", () => {
  const data = fixture([[[0, 1], [2, 3], [-100, 4], [5, 6], [7, 8]]]);
  const result = buildSessionOverview(data.entry, { durationSec: 5, barCount: 2 });
  const ui = renderOverview(result, 5);
  assert.deepEqual(ui.bins.map((node) => [node.props.style.left, node.props.style.width]), [["0%", "40%"], ["40%", "60%"]]);
  assert.match(css, /\.overview-wave \.overview-bin\s*\{[^}]*position:\s*absolute/);
});

test("incomplete and missing overview regions stay visibly unknown while measured flat data stays flat", () => {
  const data = fixture([[[0, 0], [0, 1], [0, 2]]], { durationSec: 8, complete: false });
  const partial = renderOverview(buildSessionOverview(data.entry, { durationSec: 8, barCount: 4 }), 8);
  assert.deepEqual(partial.bins.map((node) => node.props.className), ["overview-bin ready", "overview-bin partial", "overview-bin unread", "overview-bin unread"]);
  assert.deepEqual(partial.bins.map((node) => node.props.style.height), ["100%", "100%", "100%", "100%"]);
  assert.equal(partial.statuses[0].props.children, "Overview 37% · unindexed areas shaded");
  const gapData = fixture([[[0, 0], [0, 100]]]);
  gapData.window.gaps[0][1] = 1;
  const gapped = renderOverview(buildSessionOverview(gapData.entry, { durationSec: 2, barCount: 2 }), 2);
  assert.deepEqual(gapped.bins.map((node) => [node.props.className, node.props.style.height]), [["overview-bin ready", "0%"], ["overview-bin gap", "100%"]]);
  assert.equal(gapped.statuses[0].props.children, "Missing overview data shaded");
  assert.match(css, /\.overview-bin:is\(\.unread, \.gap, \.partial\)\s*\{[^}]*repeating-linear-gradient/);
  assert.match(css, /\.overview-bin\.ready\s*\{[^}]*min-height:\s*1px/);
});

test("an unavailable or building index never fabricates activity and still permits full-session navigation", () => {
  for (const loading of [false, true]) {
    const result = buildSessionOverview(undefined, { durationSec: 21_600, loading });
    const ui = renderOverview(result, 21_600);
    assert.equal(ui.bins.length, 110);
    assert.ok(ui.bins.every((node) => node.props.className === "overview-bin unread" && node.props.style.height === "100%"));
    assert.equal(ui.statuses[0].props.children, loading ? "Building recording overview…" : "Recording overview unavailable");
    ui.track.props.onPointerDown({ clientX: 60, currentTarget: { getBoundingClientRect: () => ({ left: 10, width: 100 }) } });
    assert.deepEqual(ui.jumps, [10_800]);
    assert.deepEqual(ui.actions, ["overview-jumped"]);
  }
});
