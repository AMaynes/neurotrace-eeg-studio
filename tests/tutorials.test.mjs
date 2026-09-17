/** Exercise the real tutorial component's controls with inert workspace/DOM boundaries. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as catalog from "../app/tutorials.ts";

const componentSource = await readFile(new URL("../app/tutorial-center.tsx", import.meta.url), "utf8");
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("tutorial-center.tsx", componentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = syntax.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "TutorialCenter");
assert.ok(component);
const compiled = ts.transpileModule(component.getText(syntax), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...nodes(tree.props?.children)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  return tree?.props ? text(tree.props.children) : "";
}

function harness(overrides = {}) {
  let hookIndex = 0;
  const slots = [];
  const actions = [];
  const portalHosts = [];
  const focusTargets = [];
  const body = {};
  const surface = { host: body, rect: null, fallback: false, ready: false, dialogName: null, viewport: { width: 1280, height: 720 } };
  const props = {
    open: true, topic: "start", hasRecording: true, canAnnotate: true,
    onClose() { props.open = false; }, onOpen() { props.open = true; },
    onTopicChange(topic) { props.topic = topic; }, onReveal(area) { actions.push(area); },
    ...overrides,
  };
  const scope = {
    ...catalog, require: createRequire(import.meta.url), exports: {},
    useState(initial) {
      const index = hookIndex++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    },
    useRef(initial) {
      const index = hookIndex++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect() {},
    useTourSurface: (_step, active) => active ? surface : null,
    createPortal: (children, host) => { portalHosts.push(host); return children; },
    window: { innerWidth: 1280, innerHeight: 720 },
    requestAnimationFrame: (callback) => { callback(); return 1; },
    document: { body, querySelector: () => ({ focus() {}, scrollIntoView() {} }) },
  };
  const TutorialCenter = new Function(...Object.keys(scope), `${compiled}\nreturn exports.TutorialCenter;`)(...Object.values(scope));
  const api = {
    props, surface, actions, portalHosts, focusTargets, tree: null, coachHeight: 300,
    render() {
      hookIndex = 0;
      portalHosts.length = 0;
      api.tree = TutorialCenter(props);
      const coach = nodes(api.tree).find((node) => node.type === "section" && node.props.className?.startsWith("tutorial-coach"));
      if (coach) coach.props.ref.current = {
        getBoundingClientRect: () => ({ left: 380, top: 340, width: 500, ...coach.props.style, height: api.coachHeight }),
        querySelector: (selector) => ({ focus: () => focusTargets.push(selector) }),
      };
      return api.tree;
    },
    find(predicate) { const result = nodes(api.tree).find(predicate); assert.ok(result, "expected tutorial control exists"); return result; },
    button(name) { return api.find((node) => node.type === "button" && (node.props["aria-label"] === name || text(node) === name)); },
    click(name) { const button = api.button(name); assert.ok(!button.props.disabled, `${name} is enabled`); button.props.onClick(); api.render(); },
    markup() { return renderToStaticMarkup(api.tree); },
    coach() { return api.find((node) => node.type === "section" && node.props.className?.startsWith("tutorial-coach")); },
    resize(width, height) { surface.viewport = { width, height }; scope.window.innerWidth = width; scope.window.innerHeight = height; api.render(); },
  };
  api.render();
  return api;
}

test("every tutorial topic has unique lessons, valid steps, and real workspace anchors", () => {
  const ids = catalog.tutorialLessons.map((lesson) => lesson.id);
  assert.equal(new Set(ids).size, ids.length);
  const anchors = new Set();
  const pageSyntax = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function collect(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(pageSyntax) === "data-tutorial") {
      const collectStrings = (value) => {
        if (ts.isStringLiteral(value)) anchors.add(value.text);
        ts.forEachChild(value, collectStrings);
      };
      if (node.initializer) collectStrings(node.initializer);
    }
    ts.forEachChild(node, collect);
  }
  collect(pageSyntax);
  for (const topic of catalog.tutorialTopics) {
    assert.ok(catalog.tutorialLessons.some((lesson) => lesson.topic === topic.id));
  }
  for (const lesson of catalog.tutorialLessons) {
    assert.ok(lesson.steps.length >= 3);
    for (const step of lesson.steps) {
      assert.ok(anchors.has(step.target), `${lesson.id}: ${step.target} exists`);
      if (step.fallback) assert.ok(anchors.has(step.fallback));
      if (step.readyTarget) assert.ok(anchors.has(step.readyTarget));
      assert.ok(step.instruction && step.unavailable);
    }
  }
});

test("the hub renders accessible topic tabs, step previews, and explicit prerequisites", () => {
  for (const topic of catalog.tutorialTopics) {
    const ui = harness({ topic: topic.id, hasRecording: false, canAnnotate: false });
    const html = ui.markup();
    assert.match(html, /role="dialog" aria-modal="true"/);
    assert.match(html, /role="tablist" aria-label="Tutorial topics"/);
    assert.match(html, new RegExp(`id="tutorial-tab-${topic.id}" role="tab" aria-selected="true"`));
    assert.equal(ui.button("Start walkthrough →").props.disabled, !["start", "save"].includes(topic.id));
    const step = ui.find((node) => node.type === "button" && text(node).startsWith("2"));
    step.props.onClick(); ui.render();
    assert.ok(ui.markup().includes('aria-current="step"'));
  }
  const labeling = harness({ topic: "labels", canAnnotate: false });
  assert.match(labeling.markup(), /Wait for file validation/);
  assert.equal(labeling.button("Start walkthrough →").props.disabled, true);
});

test("walkthroughs advance, go back, complete, and replay without performing workspace actions", () => {
  const ui = harness({ hasRecording: false });
  ui.click("Start walkthrough →");
  assert.equal(ui.props.open, false);
  assert.match(ui.markup(), /STEP 1 OF 4/);
  assert.equal(ui.button("Back").props.disabled, true);
  ui.click("Next →");
  assert.match(ui.markup(), /Choose your format/);
  ui.click("Back");
  assert.match(ui.markup(), /STEP 1 OF 4/);
  for (let index = 0; index < 4; index++) ui.click("Next →");
  assert.match(ui.markup(), /WALKTHROUGH COMPLETE/);
  assert.match(ui.markup(), /not a save or commit/);
  ui.click("All tutorials");
  assert.match(ui.markup(), /1 \/ 11 walkthroughs completed/);
  ui.click("Replay walkthrough →");
  assert.match(ui.markup(), /STEP 1 OF 4/);
  assert.deepEqual(ui.actions, [], "start, next, and back never operate workspace controls");
  ui.click("End walkthrough");
  assert.equal(ui.markup(), "");
});

test("contextual spectrogram help selects its topic and reveals hidden controls only on request", () => {
  const ui = harness({ topic: "spectrogram" });
  assert.match(ui.markup(), /Read the spectrogram/);
  ui.click("Start walkthrough →"); ui.click("Next →");
  assert.match(ui.markup(), /Open Spectrogram in Signal tools/);
  assert.deepEqual(ui.actions, []);
  ui.click("Show this area");
  assert.deepEqual(ui.actions, ["spectrogram"]);
  assert.match(page, /onHelp=\{\(\) => \{ setHelpTopic\("spectrogram"\); setShowHelp\(true\); \}\}/);
  assert.match(page, /onClick=\{onHelp\} aria-label="Open spectrogram tutorials"/);
  assert.doesNotMatch(page, /showSpectrogramHelp|help-sections/);
});

test("the guide stays inside open dialogs and cannot open a competing tutorial modal", () => {
  const ui = harness(); ui.click("Start walkthrough →");
  ui.surface.dialogName = "Load recording";
  ui.surface.host = { querySelector: () => ({ focus() {} }) };
  ui.render();
  assert.match(ui.markup(), /tutorial-coach-embedded/);
  assert.equal(ui.button("All tutorials").props.disabled, true);
  ui.surface.ready = true; ui.render();
  assert.match(ui.markup(), /That area is open/);
  assert.doesNotMatch(ui.markup(), /Close Load recording to continue/);
  ui.surface.ready = false;
  ui.click("Next →");
  assert.match(ui.markup(), /STEP 2 OF 4/);
  ui.click("End walkthrough");
  assert.equal(ui.props.open, false);
});

test("tour Escape is local to the coach so waveform Escape can still clear channel selection", () => {
  const ui = harness({ topic: "spectrogram" }); ui.click("Start walkthrough →");
  let prevented = false;
  ui.find((node) => node.type === "section" && node.props.className?.startsWith("tutorial-coach")).props.onKeyDown({
    key: "Escape", preventDefault() { prevented = true; }, stopPropagation() {},
  });
  ui.render();
  assert.equal(prevented, true);
  assert.equal(ui.markup(), "");
  assert.match(page, /if \(target\?\.closest\("\.tutorial-coach"\)\) return;/);
  assert.match(page, /setChannelSelectionActive\(false\)/);
});

test("topic keyboard navigation wraps and ignores unrelated shortcuts", () => {
  assert.equal(catalog.tutorialTabIndex("ArrowLeft", 0), 5);
  assert.equal(catalog.tutorialTabIndex("ArrowRight", 5), 0);
  assert.equal(catalog.tutorialTabIndex("Home", 4), 0);
  assert.equal(catalog.tutorialTabIndex("End", 0), 5);
  assert.equal(catalog.tutorialTabIndex("Escape", 0), null);
});

test("floating coach prefers a clear corner and remains bounded on narrow or short screens", () => {
  const target = { left: 800, top: 400, width: 350, height: 280 };
  const position = catalog.placeTutorialCoach({ width: 1200, height: 720 }, { width: 360, height: 320 }, target);
  assert.equal(position.left, 12, "avoids the lower-right control");
  for (const viewport of [{ width: 320, height: 480 }, { width: 800, height: 250 }, { width: 1280, height: 720 }]) {
    const result = catalog.placeTutorialCoach(viewport, { width: 360, height: 400 }, null);
    assert.ok(result.left >= 0 && result.top >= 0);
    assert.ok(result.left + result.width <= viewport.width);
    assert.ok(result.top + result.maxHeight <= viewport.height);
  }
});

function pointer(overrides = {}) {
  return {
    pointerId: 1, isPrimary: true, button: 0, clientX: 940, clientY: 400,
    preventDefault() {},
    currentTarget: { focus() {}, setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} },
    ...overrides,
  };
}

test("the header drags the coach and keeps the chosen position across steps and target changes", () => {
  const ui = harness(); ui.click("Start walkthrough →");
  const before = ui.coach().props.style;
  let captured = null;
  const event = pointer();
  event.currentTarget.setPointerCapture = (id) => { captured = id; };
  ui.button("Move walkthrough panel").props.onPointerDown(event); ui.render();
  assert.equal(captured, 1);
  ui.button("Move walkthrough panel").props.onPointerMove(pointer({ clientX: event.clientX - 200, clientY: event.clientY - 150 })); ui.render();
  assert.equal(ui.coach().props.style.left, before.left - 200);
  assert.equal(ui.coach().props.style.top, before.top - 150);
  ui.button("Move walkthrough panel").props.onPointerUp(pointer({ clientX: event.clientX - 200, clientY: event.clientY - 150 })); ui.render();
  const placed = { ...ui.coach().props.style };
  ui.click("Next →");
  ui.surface.rect = { left: placed.left, top: placed.top, width: 400, height: 300 }; ui.render();
  assert.deepEqual(ui.coach().props.style, placed, "new targets do not override the user's placement");
  ui.click("Back");
  assert.deepEqual(ui.coach().props.style, placed);
  assert.deepEqual(ui.actions, []);
});

test("dragging clamps the panel to the viewport, including after the viewport shrinks", () => {
  const ui = harness(); ui.click("Start walkthrough →");
  ui.button("Move walkthrough panel").props.onPointerDown(pointer()); ui.render();
  ui.button("Move walkthrough panel").props.onPointerMove(pointer({ clientX: -1000, clientY: -1000 })); ui.render();
  assert.equal(ui.coach().props.style.left, 12);
  assert.equal(ui.coach().props.style.top, 12);
  ui.button("Move walkthrough panel").props.onPointerMove(pointer({ clientX: 5000, clientY: 5000 })); ui.render();
  assert.equal(ui.coach().props.style.left + ui.coach().props.style.width, 1280 - 12);
  ui.resize(320, 260);
  const style = ui.coach().props.style;
  assert.equal(style.width, 296);
  assert.equal(style.left, 12);
  assert.equal(style.top, 12);
  assert.equal(style.maxHeight, 236);
  assert.deepEqual(catalog.clampTutorialCoachPosition({ left: 900, top: 800, width: 360 }, { width: 800, height: 600 }, 450), { left: 428, top: 138, width: 360 });
});

test("non-primary pointers and canceled drags cannot move the coach or interfere with its buttons", () => {
  const ui = harness(); ui.click("Start walkthrough →");
  for (const overrides of [{ button: 2 }, { isPrimary: false }]) {
    ui.button("Move walkthrough panel").props.onPointerDown(pointer(overrides)); ui.render();
    assert.doesNotMatch(ui.coach().props.className, /tutorial-coach-manual/);
  }
  ui.button("Move walkthrough panel").props.onPointerDown(pointer()); ui.render();
  const initial = ui.coach().props.style;
  ui.button("Move walkthrough panel").props.onPointerMove(pointer({ pointerId: 2, clientX: 0 })); ui.render();
  assert.deepEqual(ui.coach().props.style, initial);
  let released = false;
  const event = pointer(); event.currentTarget.releasePointerCapture = () => { released = true; };
  ui.button("Move walkthrough panel").props.onPointerCancel(event); ui.render();
  ui.button("Move walkthrough panel").props.onPointerMove(pointer({ clientX: 0 })); ui.render();
  assert.equal(released, true);
  assert.deepEqual(ui.coach().props.style, initial);
  ui.click("Next →");
  assert.match(ui.markup(), /STEP 2 OF 4/);
  ui.click("End walkthrough");
  assert.equal(ui.markup(), "");
});

test("keyboard movement and reset work, including when the coach belongs to an open dialog", () => {
  const ui = harness(); ui.click("Start walkthrough →");
  ui.surface.dialogName = "Load recording";
  const backdrop = {};
  ui.surface.host = { querySelector: () => ({ focus() {} }), closest: () => backdrop };
  ui.surface.rect = { left: 360, top: 200, width: 560, height: 320 }; ui.render();
  let prevented = false;
  const key = { key: "ArrowLeft", shiftKey: true, preventDefault() { prevented = true; }, stopPropagation() {} };
  ui.button("Move walkthrough panel").props.onKeyDown(key); ui.render();
  assert.equal(prevented, true);
  assert.match(ui.coach().props.className, /tutorial-coach-embedded.*tutorial-coach-manual/);
  assert.equal(ui.coach().props.style.left, 340);
  assert.equal(ui.coach().props.style.width, 500, "undocking retains the panel width so the drag handle does not jump");
  assert.equal(ui.button("All tutorials").props.disabled, true, "modal focus ownership is unchanged");
  assert.deepEqual(ui.portalHosts, [ui.surface.host, backdrop], "the highlight shares the dialog's stacking context below the coach");
  ui.click("Reset walkthrough position");
  assert.equal(ui.coach().props.style, undefined, "reset restores the normal in-dialog placement");
  assert.equal(ui.focusTargets.at(-1), ".tutorial-drag-handle", "reset does not strand focus on a removed button");
  ui.button("Move walkthrough panel").props.onKeyDown(key); ui.render();
  ui.button("Move walkthrough panel").props.onKeyDown({ ...key, key: "Home" }); ui.render();
  assert.equal(ui.coach().props.style, undefined);
});
