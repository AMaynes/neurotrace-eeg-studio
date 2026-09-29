/** Exercise the actual welcome/import JSX so directory entry cannot disappear behind format selection. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
let dialog;
let welcomeButton;
function attribute(node, name) {
  const item = node.openingElement.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.getText(syntax) === name);
  return item?.initializer && ts.isStringLiteral(item.initializer) ? item.initializer.text : null;
}
function collect(node) {
  if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
  if (ts.isJsxElement(node)) {
    if (attribute(node, "id") === "recording-import-dialog") dialog = node;
    if (attribute(node, "className") === "empty-load-prompt") welcomeButton = node;
  }
  ts.forEachChild(node, collect);
}
collect(syntax);
assert.ok(dialog, "find the actual import dialog JSX");
assert.ok(welcomeButton, "find the actual welcome load button JSX");
const require = createRequire(import.meta.url);

function evaluate(code, expression, env) {
  const javascript = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  return new Function("require", "exports", ...Object.keys(env), `${javascript}\nreturn ${expression};`)(require, {}, ...Object.values(env));
}
function elements(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props?.children, predicate)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join(" ");
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  return tree?.props ? text(tree.props.children) : "";
}
function button(tree, name) {
  const found = elements(tree, (node) => node.type === "button" && (node.props["aria-label"] === name || text(node).trim() === name))[0];
  assert.ok(found, `find button ${name}`);
  return found;
}
function state(env, key, initial) {
  env[key] = initial;
  env[`set${key[0].toUpperCase()}${key.slice(1)}`] = (value) => { env[key] = typeof value === "function" ? value(env[key]) : value; };
}
const emptySelection = { edf: null, mat: null, dat: null, neurotrace: null, supportingFiles: [] };
function harness(options = {}) {
  const actions = [];
  const env = {
    pendingDat: null, importBusy: false, importBusyRef: { current: false },
    guidedImportReady: false, EMPTY_GUIDED_IMPORT_SELECTION: emptySelection,
    directoryConfirmationRef: { current: null },
    guidedDirectoryInputRef: { current: null },
    chooseImportType: (format) => actions.push(["format", format]),
    stageGuidedFile: (...args) => actions.push(["file", ...args]),
    stageGuidedDirectory: (event) => actions.push(["directory", event]),
    submitGuidedImport: () => actions.push(["submit"]),
  };
  for (const [key, value] of Object.entries({ showImport: false, importMode: "recording", importChoice: null,
    guidedImportSelection: emptySelection, stagedDirectoryPlan: null, uploadError: null })) state(env, key, value);
  Object.assign(env, options);
  function choose(mode) {
    const node = declarations.get("chooseImportMode");
    assert.ok(node, "find the actual chooseImportMode handler");
    evaluate(`const actualHandler = ${node.initializer.getText(syntax)};`, "actualHandler", env)(mode);
  }
  env.chooseImportMode = choose;
  return {
    env, actions, choose,
    render: () => evaluate(`const render = () => (${dialog.getText(syntax)});`, "render()", env),
    welcome: () => evaluate(`const render = () => (${welcomeButton.getText(syntax)});`, "render()", env),
  };
}

test("main welcome action exposes recording and directory choices before any format is selected", () => {
  const ui = harness();
  ui.welcome().props.onClick();
  assert.equal(ui.env.showImport, true);
  assert.equal(ui.env.importChoice, null);
  const tree = ui.render();
  const single = button(tree, "Single recording");
  const directory = button(tree, "Recording directory");
  assert.equal(single.props["aria-pressed"], true);
  assert.equal(directory.props["aria-pressed"], false);
  const all = elements(tree, () => true);
  const formats = elements(tree, (node) => node.props?.["aria-label"] === "Recording formats")[0];
  assert.ok(formats, "format choices remain visible");
  assert.ok(all.indexOf(directory) < all.indexOf(formats), "directory choice is visible before format cards");
  directory.props.onClick();
  assert.equal(ui.env.importMode, "directory");
});

test("directory mode is explicit before format selection and does not expose individual-file pickers", () => {
  const ui = harness({ importMode: "directory" });
  const tree = ui.render();
  assert.equal(button(tree, "Recording directory").props["aria-pressed"], true);
  const chooser = button(tree, "Choose directory");
  assert.equal(chooser.props.disabled, true, "the same-format rule requires an explicit format first");
  const formats = elements(tree, (node) => node.props?.["aria-label"] === "Recording formats")[0];
  assert.equal(elements(formats, (node) => node.type === "button").length, 3);
  assert.doesNotMatch(text(formats), /NeuroTrace|One portable/);
  assert.match(text(tree), /subfolders/i);
  assert.equal(elements(tree, (node) => node.type === "input" && node.props.type === "file" && node.props.accept).length, 0);
});

for (const format of ["edf", "mat", "mat-dat"]) {
  test(`${format} directory entry keeps an accessible directory picker and no individual-file rows`, () => {
    const ui = harness({ importMode: "directory", importChoice: format });
    const tree = ui.render();
    assert.equal(button(tree, "Choose directory").props.disabled, false);
    const pickers = elements(tree, (node) => node.type === "input" && node.props.type === "file");
    assert.equal(pickers.length, 1);
    assert.equal(pickers[0].props.multiple, true);
    assert.equal(pickers[0].props.accept, undefined);
    const input = { webkitdirectory: false, click: () => ui.actions.push(["picker-open"]) };
    pickers[0].props.ref(input);
    assert.equal(input.webkitdirectory, true);
    assert.equal(ui.env.guidedDirectoryInputRef.current, input);
    button(tree, "Choose directory").props.onClick();
    const event = { target: { files: [] } };
    pickers[0].props.onChange(event);
    assert.deepEqual(ui.actions, [["picker-open"], ["directory", event]], "the keyboard-accessible button opens the directory picker and uses its validated handler");
    assert.equal(elements(tree, (node) => node.props?.className === "import-requirements").length, 0);
  });
}

test("directory mode still renders the discovered session summary and Load action", () => {
  const ui = harness({ importMode: "directory", importChoice: "edf", guidedImportReady: true,
    stagedDirectoryPlan: { format: "edf", recordings: [{ id: "one", relativePath: "root/one.edf" }, { id: "two", relativePath: "root/sub/two.edf" }], supportingFiles: [] } });
  const tree = ui.render();
  assert.match(text(tree), /2\s+sessions found/);
  const load = button(tree, "Load 2 sessions");
  assert.equal(load.props.disabled, false);
  load.props.onClick();
  assert.deepEqual(ui.actions, [["submit"]]);
});

for (const [format, extensions, action] of [
  ["edf", [".edf"], "Open recording"], ["mat", [".mat"], "Open recording"],
  ["mat-dat", [".mat", ".dat"], "Open recording"], ["neurotrace", [".neurotrace"], "Open project"],
]) {
  test(`single ${format} keeps its ordinary file requirements and primary action`, () => {
    const ui = harness({ importChoice: format });
    const tree = ui.render();
    assert.deepEqual(elements(tree, (node) => node.type === "input" && node.props.type === "file").map((input) => input.props.accept), extensions);
    assert.equal(button(tree, action).props.disabled, true);
    assert.equal(elements(tree, (node) => node.type === "button" && node.props["aria-label"] === "Choose directory").length, 0);
  });
}

test("mode switches clear stale files, directory plans, errors, and pending directory confirmation", () => {
  const stale = { old: true };
  const ui = harness({ importChoice: "edf", guidedImportSelection: stale, stagedDirectoryPlan: stale, uploadError: stale,
    directoryConfirmationRef: { current: stale } });
  ui.choose("directory");
  assert.equal(ui.env.importMode, "directory");
  assert.equal(ui.env.importChoice, "edf", "a compatible format remains selected");
  assert.equal(ui.env.guidedImportSelection, emptySelection);
  assert.equal(ui.env.stagedDirectoryPlan, null);
  assert.equal(ui.env.uploadError, null);
  assert.equal(ui.env.directoryConfirmationRef.current, null);
  ui.env.stagedDirectoryPlan = stale;
  ui.choose("recording");
  assert.equal(ui.env.importMode, "recording");
  assert.equal(ui.env.stagedDirectoryPlan, null);
});

test("switching from a project to directory requires a supported recording format", () => {
  const ui = harness({ importChoice: "neurotrace" });
  ui.choose("directory");
  assert.equal(ui.env.importChoice, null);
  assert.equal(button(ui.render(), "Choose directory").props.disabled, true);
});

test("selecting the current mode or changing mode during an import cannot discard pending choices", () => {
  for (const scenario of [{ mode: "recording", busy: false }, { mode: "directory", busy: true }]) {
    const stale = { keep: true };
    const ui = harness({ guidedImportSelection: stale, stagedDirectoryPlan: stale, uploadError: stale,
      directoryConfirmationRef: { current: stale }, importBusyRef: { current: scenario.busy }, importBusy: scenario.busy });
    ui.choose(scenario.mode);
    assert.equal(ui.env.importMode, "recording");
    assert.equal(ui.env.guidedImportSelection, stale);
    assert.equal(ui.env.stagedDirectoryPlan, stale);
    assert.equal(ui.env.uploadError, stale);
    assert.equal(ui.env.directoryConfirmationRef.current, stale);
  }
});

test("busy import disables both mode buttons and the directory chooser", () => {
  const tree = harness({ importMode: "directory", importChoice: "edf", importBusy: true }).render();
  assert.equal(button(tree, "Single recording").props.disabled, true);
  assert.equal(button(tree, "Recording directory").props.disabled, true);
  assert.equal(button(tree, "Choose directory").props.disabled, true);
});

test("directory readiness cannot borrow staged single files, and single recording readiness cannot borrow a directory plan", () => {
  const node = declarations.get("guidedImportReady");
  assert.ok(node, "find actual guided import readiness expression");
  const ready = (env) => evaluate(`const result = ${node.initializer.getText(syntax)};`, "result", env);
  const file = { name: "session.edf" };
  const plan = { format: "edf", recordings: [{ id: "one" }] };
  assert.equal(Boolean(ready({ importMode: "directory", importChoice: "edf", stagedDirectoryPlan: null,
    guidedImportSelection: { ...emptySelection, edf: file } })), false);
  assert.equal(Boolean(ready({ importMode: "recording", importChoice: "edf", stagedDirectoryPlan: plan,
    guidedImportSelection: emptySelection })), false);
  assert.equal(Boolean(ready({ importMode: "directory", importChoice: "edf", stagedDirectoryPlan: plan,
    guidedImportSelection: emptySelection })), true);
  assert.equal(Boolean(ready({ importMode: "directory", importChoice: "mat", stagedDirectoryPlan: plan,
    guidedImportSelection: emptySelection })), false);
});
