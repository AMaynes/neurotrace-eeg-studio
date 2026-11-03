import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { nextPlaybackStep, playbackWindowReady } from "../app/playback.ts";

test("playback scrolls underneath the centered playhead and prefetches before buffer exhaustion", () => {
  const coverage = { viewStart: 0, viewDuration: 25 };
  const step = nextPlaybackStep(10, 20, 100, coverage, 0.033);
  assert.equal(step.timeSec, 10.033); assert.equal(step.viewStartSec, step.timeSec - 10);
  assert.equal(step.buffering, false); assert.equal(step.request, undefined);
  const prefetch = nextPlaybackStep(13, 20, 100, coverage, 0.033);
  assert.equal(prefetch.buffering, false); assert.ok(prefetch.request);
  assert.equal(prefetch.request.durationSec, 25);
  assert.equal(prefetch.request.startSec, prefetch.viewStartSec);
});

test("playback holds time and viewport when data is missing and never catches up in a jump", () => {
  const coverage = { viewStart: 0, viewDuration: 20 };
  const waiting = nextPlaybackStep(10, 20, 100, coverage, 0.033);
  assert.equal(waiting.timeSec, 10); assert.equal(waiting.viewStartSec, 0); assert.equal(waiting.buffering, true);
  const loaded = nextPlaybackStep(10, 20, 100, { viewStart: 0, viewDuration: 25 }, 8);
  assert.equal(loaded.timeSec, 10.1); assert.equal(loaded.buffering, false);
  assert.equal(playbackWindowReady({ ...coverage, unreadAfterSec: 15 }, 0, 20, 100), false);
});

test("playhead stays centered at both file edges, EOF stops, and tiny windows get bounded read-ahead", () => {
  const first = nextPlaybackStep(0, 20, 40, { viewStart: 0, viewDuration: 20 }, 0.033);
  assert.equal(first.viewStartSec, first.timeSec - 10); assert.ok(first.viewStartSec < 0);
  const last = nextPlaybackStep(39.99, 20, 40, { viewStart: 20, viewDuration: 20 }, 0.033);
  assert.equal(last.timeSec, 40); assert.equal(last.viewStartSec, 30); assert.equal(last.finished, true);
  assert.equal(last.request, undefined);
  for (const windowSec of [0.01, 0.1, 1, 20, 900]) {
    const step = nextPlaybackStep(20, windowSec, 1000, undefined, .033);
    assert.equal(step.timeSec, 20); assert.equal(step.buffering, true);
    assert.ok(step.request.durationSec <= windowSec + 5);
    assert.ok(step.request.startSec >= 0);
    assert.ok(step.request.startSec + step.request.durationSec <= 1000);
  }
});

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(syntax) === "useEffect"
    && node.arguments[0]?.getText(syntax).includes("const step = nextPlaybackStep")) effect = node.arguments[0].getText(syntax);
  ts.forEachChild(node, visit);
}
visit(syntax); assert.ok(effect);

test("real playback clock scrolls while prefetching, waits without repeated reads, and resumes smoothly", () => {
  let tick, disposed, now = 0, cursor = 10, requested, playing = true, buffering, view = 0, revisions = 0;
  const source = {}, state = { current: { timeSec: 10, playing: true } }, pending = { current: null };
  const prepared = { current: { settingsKey: "test", viewStart: 0, viewDuration: 20 } };
  const scope = { hasRecording: true, playing: true, meta: { durationSec: 100 }, timebase: 20, nextPlaybackStep,
    playbackBufferRangeRef: { current: null }, displaySettingsKey: "test", playbackDisplayRef: prepared,
    playbackStateRef: state, playbackPendingViewRef: pending, viewStartRef: { current: 0 }, wheelPanTargetRef: { current: 0 }, sourceRef: { current: source },
    setCursorTime(value) { cursor = value; }, setSignalViewStart(value) { requested = value; }, setPlaying(value) { playing = value; },
    setPlaybackBuffering(value) { buffering = value; }, setViewStart(value) { view = value; },
    setPlaybackRequestRevision(update) { revisions = update(revisions); }, performance: { now: () => now },
    window: { setInterval(callback, delay) { tick = callback; assert.equal(delay, 1000 / 30); return 42; }, clearInterval(id) { disposed = id; } } };
  const code = ts.transpileModule(`const start = ${effect};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const stop = new Function(...Object.keys(scope), `${code}; return start();`)(...Object.values(scope));
  const advance = (ms = 33) => { now += ms; tick(); };
  advance(); assert.equal(cursor, 10); assert.equal(view, 0); assert.equal(requested, 0);
  assert.equal(buffering, true); assert.deepEqual(pending.current, { source, startSec: 0, durationSec: 25 });
  for (let i = 0; i < 20; i++) advance();
  assert.equal(cursor, 10); assert.equal(revisions, 1, "a pending read is neither duplicated nor cancelled");
  prepared.current = { ...prepared.current, viewDuration: 25 }; pending.current = null;
  advance(); assert.equal(cursor, 10.033); assert.equal(view, cursor - 10); assert.equal(buffering, false);
  state.current.timeSec = 13; advance(); assert.ok(pending.current); assert.equal(buffering, false);
  assert.ok(cursor > 13); assert.equal(view, cursor - 10, "prefetch does not stop continuous scrolling");
  state.current.timeSec = 99.99; prepared.current = { settingsKey: "test", viewStart: 80, viewDuration: 20 }; pending.current = null;
  advance(); assert.equal(cursor, 100); assert.equal(view, 90); assert.equal(playing, false);
  stop(); assert.equal(disposed, 42);
});

test("restoring an edge-centered view clamps file reads and refreshes a cancelled buffer even at the same offset", () => {
  let declaration;
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(syntax) === 'commitViewStart') declaration = node.getText(syntax);
    ts.forEachChild(node, find);
  }
  find(syntax); assert.ok(declaration);
  const pending = { current: {} }, range = { current: {} }, controller = new AbortController();
  let requested, viewport, revisions = 0;
  const env = { useCallback: fn => fn, playbackPendingViewRef: pending, playbackBufferRangeRef: range,
    displayAbortRef: { current: controller }, clearWheelPanSettle() {}, setPlaybackBuffering() {},
    viewStartRef: { current: 0 }, wheelPanTargetRef: { current: 0 },
    setPlaybackRequestRevision(fn) { revisions = fn(revisions); },
    setViewStart(value) { viewport = value; }, setSignalViewStart(value) { requested = value; } };
  const code = ts.transpileModule(`const ${declaration};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const commit = new Function(...Object.keys(env), `${code}; return commitViewStart;`)(...Object.values(env));
  commit(-10);
  assert.equal(viewport, -10); assert.equal(requested, 0);
  assert.equal(pending.current, null); assert.equal(range.current, null); assert.equal(controller.signal.aborted, true);
  assert.equal(revisions, 1);
  commit(0); assert.equal(revisions, 2, 'a previously aborted read restarts even if its source offset is unchanged');
});
