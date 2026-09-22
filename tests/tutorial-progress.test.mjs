import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { subscribeTutorialActions } from "../app/tutorial-events.ts";

// Run the real pure policy and measurement hook, substituting only browser/React boundaries.
const progressSource = await readFile(new URL("../app/tutorial-progress.ts", import.meta.url), "utf8");
const progressSyntax = ts.createSourceFile("tutorial-progress.ts", progressSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const policy = progressSyntax.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "tutorialMilestoneActions");
const compiledPolicy = ts.transpileModule(policy.getText(progressSyntax), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
new Function("exports", compiledPolicy)(exports);
const { tutorialMilestoneActions } = exports;

const initial = {
  scope: "one", stateKey: "initial", recording: null, importOpen: false, importFormat: null, filesReady: false,
  channelsOpen: false, montage: "referential", gain: 1, clamp: "clamped", filtersOpen: false,
  boxZoom: false, spectrogramOpen: false, labelsPanelOpen: true, labelPickerOpen: false,
  sessionLabelPickerOpen: false, labelsVisible: true, saveOpen: false, saveOptions: {},
};

test("milestones ignore initial render, unchanged data, and session restoration", () => {
  assert.deepEqual(tutorialMilestoneActions(null, initial), []);
  assert.deepEqual(tutorialMilestoneActions(initial, { ...initial }), []);
  assert.deepEqual(tutorialMilestoneActions(initial, { ...initial, scope: "two", recording: "file", gain: 2, importOpen: true }), []);
  assert.deepEqual(tutorialMilestoneActions(initial, { ...initial, recording: "file", gain: 2, montage: "average" }), ["recording-opened"]);
  assert.deepEqual(tutorialMilestoneActions(initial, { ...initial, stateKey: "recovered", gain: 2, montage: "average" }), []);
});

test("file milestones require a format, all required files, or a successfully installed recording", () => {
  assert.deepEqual(tutorialMilestoneActions(initial, { ...initial, importOpen: true }), ["import-opened"]);
  assert.deepEqual(tutorialMilestoneActions(initial, { ...initial, importFormat: "mat-dat" }), ["import-format-chosen"]);
  assert.deepEqual(tutorialMilestoneActions(initial, { ...initial, filesReady: true }), ["import-files-ready"]);
  assert.deepEqual(tutorialMilestoneActions({ ...initial, filesReady: true }, initial), [], "canceling/replacing files is not completion");
  assert.deepEqual(tutorialMilestoneActions(initial, { ...initial, recording: "loaded" }), ["recording-opened"]);
  assert.deepEqual(tutorialMilestoneActions({ ...initial, recording: "loaded" }, initial), [], "removing a recording is not a successful load");
});

test("view and modal milestones distinguish desired open/close and zoom direction", () => {
  for (const [key, value, action] of [
    ["channelsOpen", true, "channels-opened"], ["boxZoom", true, "waveform-zoom-enabled"],
    ["spectrogramOpen", true, "spectrogram-opened"], ["filtersOpen", true, "filters-opened"],
    ["gain", 1.25, "gain-changed"], ["montage", "average", "montage-changed"],
    ["clamp", "overlap", "clamp-changed"], ["labelsVisible", false, "labels-toggled"],
    ["saveOpen", true, "save-opened"], ["saveOptions", { recording: true }, "save-options-changed"],
  ]) assert.deepEqual(tutorialMilestoneActions(initial, { ...initial, [key]: value }), [action]);
  assert.deepEqual(tutorialMilestoneActions({ ...initial, boxZoom: true }, initial), ["waveform-zoom-disabled"]);
  assert.deepEqual(tutorialMilestoneActions({ ...initial, channelsOpen: true }, initial), ["channels-closed"]);
  assert.deepEqual(tutorialMilestoneActions({ ...initial, labelPickerOpen: true }, initial), ["label-picker-closed"]);
  assert.deepEqual(tutorialMilestoneActions({ ...initial, saveOpen: true }, initial), [], "closing Save does not mean a project was saved");
});

test("a subscription consumes one matching action and cleanup blocks all later events", () => {
  const target = new EventTarget(); let completed = 0;
  const emit = (action) => target.dispatchEvent(new CustomEvent("neurotrace:tutorial-action", { detail: action }));
  const stop = subscribeTutorialActions(["project-saved"], () => completed++, target);
  emit("save-opened"); emit("save-options-changed"); assert.equal(completed, 0);
  emit("project-saved"); emit("project-saved"); assert.equal(completed, 1);
  stop(); emit("project-saved"); assert.equal(completed, 1);
  const cancel = subscribeTutorialActions(["import-files-ready"], () => completed++, target);
  cancel(); emit("import-files-ready"); assert.equal(completed, 1);
});

const centerSource = await readFile(new URL("../app/tutorial-center.tsx", import.meta.url), "utf8");
const centerSyntax = ts.createSourceFile("tutorial-center.tsx", centerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const measurement = centerSyntax.statements.filter((node) => ts.isFunctionDeclaration(node) && ["visibleTargetRect", "sameSurface", "useTourSurface"].includes(node.name?.text));
const compiledMeasurement = ts.transpileModule(measurement.map((node) => node.getText(centerSyntax)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function measurementHarness() {
  let current = null; let cleanup; let scheduled = 0;
  const frames = new Map();
  const rect = { left: 100, top: 80, width: 200, height: 100 };
  const body = { parentElement: null, getBoundingClientRect: () => ({ left: 0, top: 0, right: 1280, bottom: 720 }) };
  const target = { parentElement: body, getClientRects: () => [rect], getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }) };
  const doc = Object.assign(new EventTarget(), { body, querySelectorAll: () => [], querySelector: () => target });
  const win = Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 720 });
  const observers = [];
  const scope = {
    document: doc, window: win,
    getComputedStyle: () => ({ visibility: "visible", overflowX: "visible", overflowY: "visible" }),
    useState: () => [current, (next) => { current = typeof next === "function" ? next(current) : next; }],
    useEffect: (effect) => { cleanup = effect(); },
    ResizeObserver: class { constructor() { observers.push(this); } observe() {} unobserve() {} disconnect() { this.disconnected = true; } },
    MutationObserver: class { constructor() { observers.push(this); } observe() {} disconnect() { this.disconnected = true; } },
    requestAnimationFrame: (callback) => { const id = ++scheduled; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  const hook = new Function(...Object.keys(scope), `${compiledMeasurement}\nreturn useTourSurface;`)(...Object.values(scope));
  hook({ target: "import" }, true);
  const flush = () => { const tasks = [...frames.values()]; frames.clear(); tasks.forEach((task) => task()); };
  return { rect, doc, frames, observers, flush, cleanup: () => cleanup(), surface: () => current };
}

test("the actual measurement hook realigns after animations and cancellations, not pulse iterations", () => {
  const ui = measurementHarness(); ui.flush();
  assert.equal(ui.surface().rect.top, 80);
  ui.rect.top = 64; // Transform changes do not trigger ResizeObserver.
  ui.doc.dispatchEvent(new Event("animationend"));
  assert.equal(ui.frames.size, 1);
  ui.flush(); assert.equal(ui.surface().rect.top, 64);
  ui.rect.left = 120;
  ui.doc.dispatchEvent(new Event("animationcancel")); ui.flush();
  assert.equal(ui.surface().rect.left, 120);
  ui.doc.dispatchEvent(new Event("animationiteration"));
  assert.equal(ui.frames.size, 0, "slow pulsing does not schedule continuous measurements");
  ui.doc.dispatchEvent(new Event("transitionend"));
  ui.cleanup();
  assert.equal(ui.frames.size, 0);
  assert.ok(ui.observers.every((observer) => observer.disconnected));
  ui.doc.dispatchEvent(new Event("animationend"));
  assert.equal(ui.frames.size, 0, "unmounted tutorials leave no animation listener behind");
});

test("attention uses a slow opacity pulse with a reduced-motion opt-out and no pointer interception", async () => {
  const css = await readFile(new URL("../app/tutorial-center.css", import.meta.url), "utf8");
  assert.match(css, /tutorial-attention 2\.8s ease-in-out infinite/);
  assert.match(css, /prefers-reduced-motion: reduce[^}]+\.tutorial-spotlight[^}]+animation: none/);
  assert.match(css, /\.tutorial-spotlight[^}]+pointer-events: none/);
});
