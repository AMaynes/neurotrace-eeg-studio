import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as shortcuts from "../app/shortcuts.ts";

const { DEFAULT_CONTROLS, SHORTCUTS, SHORTCUT_GROUPS, matchesShortcut, normalizeControlBindings, shortcutAction, shortcutConflict, shortcutFromEvent, shortcutHint, shortcutRestriction, shortcutText } = shortcuts;
const key = (value, extra = {}) => ({ key: value, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });

test("every default binding is documented, portable, collision-free, and round-trips", () => {
  assert.deepEqual(normalizeControlBindings(JSON.parse(JSON.stringify(DEFAULT_CONTROLS))), DEFAULT_CONTROLS);
  assert.equal(new Set(SHORTCUTS.map((item) => item.id)).size, SHORTCUTS.length);
  for (const item of SHORTCUTS) {
    assert.equal(SHORTCUT_GROUPS.filter((group) => group.scopes.includes(item.scope)).length, 1, item.id);
    for (const chord of item.keys) {
      assert.equal(shortcutConflict(DEFAULT_CONTROLS, item.id, chord), null, `${item.id}: ${chord}`);
      assert.equal(shortcutRestriction(chord, item.id), null, chord);
      const parts = chord.split("+"); const base = parts.pop();
      for (const modifier of ["ctrlKey", "metaKey"]) {
        assert.equal(shortcutAction(key(base, { [modifier]: parts.includes("Mod"), shiftKey: parts.includes("Shift"), altKey: parts.includes("Alt") }), DEFAULT_CONTROLS, [item.scope]), item.id);
      }
    }
  }
});

test("event normalization handles symbols, exact modifiers, numpad, composition, and native focus", () => {
  for (const symbol of ["=", "+"]) assert.ok(matchesShortcut(key(symbol, { ctrlKey: true, shiftKey: symbol === "+" }), DEFAULT_CONTROLS, "zoomIn"));
  assert.ok(matchesShortcut(key("+", { metaKey: true, code: "NumpadAdd" }), DEFAULT_CONTROLS, "zoomIn"));
  assert.ok(matchesShortcut(key("_", { ctrlKey: true, shiftKey: true }), DEFAULT_CONTROLS, "zoomOut"));
  assert.ok(matchesShortcut(key("?", { shiftKey: true }), DEFAULT_CONTROLS, "help"));
  assert.ok(matchesShortcut(key("Z", { metaKey: true, shiftKey: true }), DEFAULT_CONTROLS, "redo"));
  assert.equal(shortcutFromEvent(key(" ")), "Space");
  assert.equal(shortcutFromEvent(key("ø", { altKey: true, code: "KeyO" })), "Alt+o");
  for (const event of [key("Tab"), key("Shift"), key("Dead"), key("z", { isComposing: true }), key("z", { getModifierState: () => true }), key("z", { ctrlKey: true, metaKey: true })]) assert.equal(shortcutFromEvent(event), null);
  assert.equal(matchesShortcut(key("u", { altKey: true }), DEFAULT_CONTROLS, "undo"), false);
  assert.equal(matchesShortcut(key("s", { shiftKey: true }), DEFAULT_CONTROLS, "commit"), false);
});

test("old seven-letter preferences migrate without losing Ctrl/Cmd history or silently colliding", () => {
  const restored = normalizeControlBindings({ undo: "X", redo: "X", commit: "z", ictalOnset: "b" });
  assert.deepEqual(restored.undo, ["Mod+z", "x"]);
  assert.deepEqual(restored.redo, ["Mod+Shift+z", "Shift+x"]);
  assert.deepEqual(restored.commit, ["z"]);
  assert.deepEqual(restored.spectrogramZoom, ["z"], "non-overlapping focus contexts may share a key");
  assert.deepEqual(restored.spectrogramBrowse, ["b"]);
  const corrupt = normalizeControlBindings({ undo: ["q", "q", "Tab", "Mod+q", "Mod+Mod+j"], commit: ["q"], help: [], clear: 42, bogus: ["b"] });
  assert.deepEqual(corrupt.undo, ["q"]);
  assert.deepEqual(corrupt.commit, []);
  assert.deepEqual(corrupt.help, [], "intentionally disabled bindings survive");
  assert.deepEqual(corrupt.clear, ["Escape"]);
  assert.equal("bogus" in corrupt, false);
  assert.deepEqual(normalizeControlBindings(null), DEFAULT_CONTROLS);
  assert.deepEqual(normalizeControlBindings(["z"]), DEFAULT_CONTROLS);
});

test("conflicts account for focus, history precedence, and input editing", () => {
  assert.equal(shortcutConflict(DEFAULT_CONTROLS, "commit", "Mod+z"), "Undo label edit or zoom");
  assert.equal(shortcutConflict(DEFAULT_CONTROLS, "spectrogramZoom", "Mod+z"), "Undo label edit or zoom");
  assert.equal(shortcutConflict(DEFAULT_CONTROLS, "commit", "Enter"), "Commit / accept with waveform focused");
  assert.equal(shortcutConflict(DEFAULT_CONTROLS, "commit", "b"), null);
  assert.equal(shortcutConflict(DEFAULT_CONTROLS, "spectrogramZoom", "s"), null);
  assert.ok(shortcutRestriction("Mod+c", "commit"));
  assert.ok(shortcutRestriction("ArrowLeft", "windowApply"));
  assert.ok(shortcutRestriction("1", "windowApply"));
  assert.equal(shortcutRestriction("Alt+Enter", "windowApply"), null);
});

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function descendants(node) { const result = [node]; ts.forEachChild(node, (child) => { result.push(...descendants(child)); }); return result; }
const nodes = descendants(syntax);
function compileHandler(expression, scope) {
  const code = ts.transpileModule(`const handler = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  return new Function(...Object.keys(scope), `${code}; return handler;`)(...Object.values(scope));
}
function localHandler(scopeName, scope) {
  const attr = nodes.find((node) => ts.isJsxAttribute(node) && node.name.getText(syntax) === "onKeyDown" && node.getText(syntax).includes(`"${scopeName}"`));
  assert.ok(attr, `${scopeName} handler exists`);
  return compileHandler(attr.initializer.expression.getText(syntax), { ...shortcuts, controlBindings: DEFAULT_CONTROLS, ...scope });
}
function globalHarness(overrides = {}) {
  const calls = [];
  const canvas = { closest: () => null };
  const scope = {
    ...shortcuts, controlBindings: DEFAULT_CONTROLS, canvasRef: { current: canvas }, hasRecording: true,
    showEphysLabelPicker: false, showHelp: false, showSettings: false, showChannels: false, showImport: false,
    showProjectSave: false, showSessionMap: false, showPatientInfo: false, showAnnotationEditor: false,
    queueDetailEntry: null, confirmCommit: [], cursorLocked: false, cursorTime: 10, markOnset: null,
    selectedAnnotationIds: new Set(), selectedAnnotation: null, activeCandidateItem: null,
    dragAnnotationRef: {}, pendingAnnotationDragRef: {}, annotationSelectionRef: {},
    instanceQueueEntries: [], activeQueueIndex: 0, timebase: 10, LABEL_BY_ID: new Map([["ictal", { id: "ictal" }]]),
  };
  for (const name of ["undo", "redo", "zoomTimeWindow", "moveSelectedAnnotations", "commitSelected", "placePaletteLabel", "setViewStartSafe", "notifyTutorialAction", "setToast", "setShowSettings", "setShowHelp", "setAnnotationDragPreview", "setAnnotationSelectionBox", "setSelectedAnnotationId", "setSelectedAnnotationIds", "setSelection", "setInspectionRange", "setMarkOnset", "setCursorLocked", "setChannelSelectionActive", "setDragGhost", "setShowSessionContextPicker", "setActiveTool", "setBoxZoomActive"]) scope[name] = (...args) => calls.push([name, ...args]);
  Object.assign(scope, overrides);
  const expression = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(syntax) === "onKey").initializer.getText(syntax);
  const handler = compileHandler(expression, scope);
  return { calls, scope, press(value, options = {}) { const event = key(value, { target: canvas, ...options }); handler(event); return event; } };
}

test("real global handler uses remapped zoom, history, pan, commit, delete, labels and clear", () => {
  const controlBindings = { ...DEFAULT_CONTROLS, zoomIn: ["Alt+j"], undo: ["Mod+j"], redo: ["Mod+Shift+j"], panRightFast: ["f"], commit: ["x"], "label:ictal": ["k"], clear: ["F2"] };
  const ui = globalHarness({ controlBindings });
  ui.press("j", { altKey: true }); ui.press("j", { metaKey: true }); ui.press("J", { ctrlKey: true, shiftKey: true });
  ui.press("f"); ui.press("x"); ui.press("k");
  assert.deepEqual(ui.calls.slice(0, 3).map(([name]) => name), ["zoomTimeWindow", "undo", "redo"]);
  assert.equal(ui.calls.find(([name]) => name === "setViewStartSafe")[1](30), 40);
  assert.ok(ui.calls.some(([name]) => name === "commitSelected"));
  assert.ok(ui.calls.some(([name, label]) => name === "placePaletteLabel" && label.id === "ictal"));
  ui.calls.length = 0;
  ui.press("z", { ctrlKey: true }); ui.press("s"); ui.press("1"); ui.press("Escape");
  assert.deepEqual(ui.calls, [], "old keys are no longer live");
  ui.press("F2");
  assert.ok(ui.calls.some(([name, value]) => name === "setChannelSelectionActive" && value === false));
  const modal = globalHarness({ controlBindings, showSettings: true }); modal.press("F2");
  assert.deepEqual(modal.calls, [["setShowSettings", false]]);
  const selected = globalHarness({ controlBindings: { ...controlBindings, delete: ["d"] }, selectedAnnotationIds: new Set(["a", "b"]), deleteSelectedAnnotations: () => selected.calls.push(["delete"]) });
  selected.press("f"); selected.press("d");
  assert.deepEqual(selected.calls, [["moveSelectedAnnotations", 1, true], ["delete"]]);
  selected.calls.length = 0; selected.press("Delete"); assert.deepEqual(selected.calls, []);
});

test("global dispatch respects native fields, local scopes, recorder, modifiers, and waveform-only commit", () => {
  const ui = globalHarness();
  const input = { closest: (selector) => selector.includes("input,") ? {} : null };
  assert.equal(ui.press("z", { ctrlKey: true, target: input }).prevented, undefined);
  assert.equal(ui.press("Enter", { target: input }).prevented, undefined);
  assert.equal(ui.press("Enter", { target: { closest: () => null } }).prevented, undefined);
  assert.equal(ui.press("s", { ctrlKey: true }).prevented, undefined);
  assert.equal(ui.press("s", { isComposing: true }).prevented, undefined);
  assert.equal(ui.press("ArrowLeft", { target: { closest: (selector) => selector === "[data-shortcut-scope]" ? {} : null } }).prevented, undefined);
  assert.equal(ui.press("Escape", { target: { closest: (selector) => selector === "[data-shortcut-recorder]" ? {} : null } }).prevented, undefined);
  assert.deepEqual(ui.calls, []);
  ui.press("Enter"); assert.deepEqual(ui.calls, [["commitSelected"]]);
  const modal = globalHarness({ showHelp: true, controlBindings: { ...DEFAULT_CONTROLS, zoomIn: ["j"], topicNext: ["j"] } });
  assert.equal(modal.press("j", { target: { closest: (selector) => selector === "[data-shortcut-scope]" ? {} : null } }).prevented, undefined, "a viewer binding cannot steal a tutorial tab key inside its dialog");
});

test("all local handlers honor customized bindings without requiring the original modifiers", () => {
  const changes = [];
  const spectrogram = localHandler("spectrogram", { controlBindings: { ...DEFAULT_CONTROLS, spectrogramZoom: ["Alt+x"], spectrogramColorUp: ["c"] }, setTool: (v) => changes.push(v), setZoomBox() {}, setColorLimitShift: (fn) => changes.push(fn(0)), notifyTutorialAction() {} });
  spectrogram(key("x", { altKey: true })); spectrogram(key("c")); spectrogram(key("z"));
  assert.deepEqual(changes, ["box-zoom", -0.1]);
  let size = 150;
  localHandler("queueResize", { controlBindings: { ...DEFAULT_CONTROLS, queueGrow: ["j"] }, clamp: (v) => v, setSessionLabelsHeight: (fn) => { size = fn(size); } })(key("j"));
  assert.equal(size, 160);
  localHandler("spectrogramResize", { controlBindings: { ...DEFAULT_CONTROLS, spectrogramGrow: ["k"] }, clamp: (v) => v, setSpectrogramHeight: (fn) => { size = fn(size); }, MIN_SPECTROGRAM_HEIGHT: 100, panelRef: {}, availableSpectrogramHeight: () => 500 })(key("k"));
  assert.equal(size, 180);
  let applied = 0;
  localHandler("windowApply", { controlBindings: { ...DEFAULT_CONTROLS, windowApply: ["Alt+Enter"] }, syncWindowDraft: () => applied++ })(key("Enter", { altKey: true }));
  assert.equal(applied, 1);
  let session;
  const tabs = localHandler("sessionTabs", { controlBindings: { ...DEFAULT_CONTROLS, sessionNext: ["j"] }, sessionTabs: [{ id: "a" }, { id: "b" }], activeSessionId: "a", importBusy: false, switchSession: (id) => { session = id; }, window: { requestAnimationFrame() {} } });
  tabs(key("j")); assert.equal(session, "b");
});

test("tutorial instructions and hints reflect remaps and disabled bindings", () => {
  const bindings = { ...DEFAULT_CONTROLS, clear: ["Alt+x"], undo: [] };
  assert.equal(shortcutText("Clear: {shortcut:clear}; undo: {shortcut:undo}", bindings), "Clear: Alt + X; undo: Not assigned");
  assert.equal(shortcutHint(bindings, "redo"), "Ctrl/⌘ + Shift + Z or Shift + U");
});

const settingsSource = await readFile(new URL("../app/shortcut-settings.tsx", import.meta.url), "utf8");
const settingsSyntax = ts.createSourceFile("shortcut-settings.tsx", settingsSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const settingsFunction = settingsSyntax.statements.find((node) => ts.isFunctionDeclaration(node));
function elements(tree) { if (Array.isArray(tree)) return tree.flatMap(elements); return tree?.props ? [tree, ...elements(tree.props.children)] : []; }
function settingsHarness() {
  let index = 0; const state = []; const props = { bindings: structuredClone(DEFAULT_CONTROLS), onChange(next) { props.bindings = next; } };
  const code = ts.transpileModule(settingsFunction.getText(settingsSyntax), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
  const scope = { ...shortcuts, exports: {}, require: createRequire(import.meta.url), useState(initial) { const slot = index++; if (!(slot in state)) state[slot] = initial; return [state[slot], (value) => { state[slot] = value; }]; } };
  const render = new Function(...Object.keys(scope), `${code}; return exports.ShortcutSettings;`)(...Object.values(scope));
  const ui = { props, nodes: [], render() { index = 0; ui.nodes = elements(render(props)); }, button(label) { const found = ui.nodes.find((node) => node.type === "button" && (node.props["aria-label"] === label || node.props.children === label)); assert.ok(found, label); return found; }, click(label) { ui.button(label).props.onClick(); ui.render(); }, status() { return ui.nodes.find((node) => node.props.role === "status").props.children; } };
  ui.render(); return ui;
}

test("Controls lists all bindings and supports capture, conflicts, cancellation, removal, reset, and search", () => {
  const ui = settingsHarness();
  for (const item of SHORTCUTS) assert.ok(ui.button(`Add ${item.label} shortcut`));
  const changeUndo = "Change Undo label edit or zoom shortcut Ctrl/⌘ + Z";
  ui.click(changeUndo);
  ui.button(changeUndo).props.onKeyDown(key("s")); ui.render();
  assert.match(ui.status(), /Already assigned/);
  assert.deepEqual(ui.props.bindings.undo, DEFAULT_CONTROLS.undo);
  ui.button(changeUndo).props.onKeyDown(key("j", { ctrlKey: true })); ui.render();
  assert.deepEqual(ui.props.bindings.undo, ["Mod+j", "u"]);
  const clear = "Change Clear selection / close dialog / end walkthrough shortcut Escape";
  ui.click(clear); ui.button(clear).props.onKeyDown(key("Escape")); ui.render();
  assert.match(ui.status(), /saved/);
  const add = "Add Browse tool shortcut";
  ui.click(add); const tab = key("Tab"); ui.button(add).props.onKeyDown(tab); ui.button(add).props.onBlur(); ui.render();
  assert.equal(tab.prevented, undefined);
  assert.deepEqual(ui.props.bindings.spectrogramBrowse, ["b"]);
  ui.click("Remove B from Browse tool"); assert.deepEqual(ui.props.bindings.spectrogramBrowse, []);
  ui.click("Restore defaults"); assert.deepEqual(ui.props.bindings, DEFAULT_CONTROLS);
  ui.nodes.find((node) => node.type === "input").props.onChange({ target: { value: "spectrogram" } }); ui.render();
  assert.ok(ui.nodes.some((node) => node.props["aria-label"] === "Add Browse tool shortcut"));
  assert.ok(!ui.nodes.some((node) => node.props["aria-label"] === "Add Set ictal onset shortcut"));
});
