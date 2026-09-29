/** Execute the real welcome/import JSX and handlers: auto-detection must need no mode setting. */
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
function handler(name, env) {
  const node = declarations.get(name);
  assert.ok(node, `find actual ${name} handler`);
  return evaluate(`const actualHandler = ${node.initializer.getText(syntax)};`, "actualHandler", env);
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
    guidedFilesInputRef: { current: null }, guidedDirectoryInputRef: { current: null },
    chooseImportType: (format) => actions.push(["format", format]),
    stageGuidedFile: (...args) => actions.push(["file", ...args]),
    stageDetectedImport: (event) => actions.push(["detected", event]),
    submitGuidedImport: () => actions.push(["submit"]),
  };
  for (const [key, value] of Object.entries({ showImport: false, importChoice: null,
    guidedImportSelection: emptySelection, stagedDirectoryPlan: null, uploadError: null })) state(env, key, value);
  Object.assign(env, options);
  return {
    env, actions,
    render: () => evaluate(`const render = () => (${dialog.getText(syntax)});`, "render()", env),
    welcome: () => evaluate(`const render = () => (${welcomeButton.getText(syntax)});`, "render()", env),
  };
}

test("welcome exposes enabled file and folder acquisition without choosing a format or mode", () => {
  const ui = harness();
  ui.welcome().props.onClick();
  assert.equal(ui.env.showImport, true);
  assert.equal(ui.env.importChoice, null);
  const tree = ui.render();
  const files = button(tree, "Choose files");
  const folder = button(tree, "Choose folder");
  assert.equal(files.props.disabled, false);
  assert.equal(folder.props.disabled, false);
  assert.equal(files.props["aria-pressed"], undefined, "choosers are actions, not mode switches");
  assert.equal(folder.props["aria-pressed"], undefined);
  assert.equal(elements(tree, (node) => node.props?.["aria-label"] === "Recording import mode").length, 0);
  assert.equal(declarations.has("chooseImportMode"), false);
  const all = elements(tree, () => true);
  const formats = elements(tree, (node) => node.props?.["aria-label"] === "Recording formats")[0];
  assert.ok(formats, "manual format guidance remains available");
  assert.ok(all.indexOf(files) < all.indexOf(formats));
  assert.ok(all.indexOf(folder) < all.indexOf(formats), "folder acquisition precedes optional format guidance");
});

test("file and folder buttons activate their own inputs using the shared auto-detection handler", () => {
  const ui = harness();
  const tree = ui.render();
  const pickers = elements(tree, (node) => node.type === "input" && node.props.type === "file");
  assert.equal(pickers.length, 2);
  const inputs = pickers.map((picker, index) => {
    const input = { webkitdirectory: false, click: () => ui.actions.push(["picker-open", index]) };
    if (typeof picker.props.ref === "function") picker.props.ref(input);
    else picker.props.ref.current = input;
    assert.equal(picker.props.multiple, true);
    return input;
  });
  const fileIndex = inputs.indexOf(ui.env.guidedFilesInputRef.current);
  const folderIndex = inputs.indexOf(ui.env.guidedDirectoryInputRef.current);
  assert.notEqual(fileIndex, folderIndex);
  assert.notEqual(fileIndex, -1);
  assert.notEqual(folderIndex, -1);
  assert.equal(inputs[fileIndex].webkitdirectory, false);
  assert.equal(inputs[folderIndex].webkitdirectory, true);
  button(tree, "Choose files").props.onClick();
  button(tree, "Choose folder").props.onClick();
  const fileEvent = { target: { files: [{ name: "one.edf" }] } };
  const folderEvent = { target: { files: [{ name: "two.edf" }], webkitdirectory: true } };
  pickers[fileIndex].props.onChange(fileEvent);
  pickers[folderIndex].props.onChange(folderEvent);
  assert.deepEqual(ui.actions, [["picker-open", fileIndex], ["picker-open", folderIndex], ["detected", fileEvent], ["detected", folderEvent]]);
});

for (const [format, label] of [["edf", /EDF/], ["mat", /MAT/], ["mat-dat", /MAT\s*\+\s*DAT/]]) {
  test(`detected ${format} collection displays its format and lazy action without manual file rows`, () => {
    const ui = harness({ importChoice: format, guidedImportReady: true,
      stagedDirectoryPlan: { format, recordings: [{ id: "one", relativePath: "root/one" }, { id: "two", relativePath: "root/sub/two" }], supportingFiles: [] } });
    const tree = ui.render();
    assert.match(text(tree), /2\s+sessions found/);
    assert.match(text(tree), label);
    assert.equal(elements(tree, (node) => node.props?.["aria-label"] === "Recording formats").length, 0);
    assert.equal(elements(tree, (node) => node.props?.className === "import-requirements").length, 0);
    assert.equal(button(tree, "Choose files").props.disabled, false);
    assert.equal(button(tree, "Choose folder").props.disabled, false);
    const load = button(tree, "Load 2 sessions");
    assert.equal(load.props.disabled, false);
    load.props.onClick();
    assert.deepEqual(ui.actions, [["submit"]]);
  });
}

for (const [format, extensions, action] of [
  ["edf", [".edf"], "Open recording"], ["mat", [".mat"], "Open recording"],
  ["mat-dat", [".mat", ".dat"], "Open recording"], ["neurotrace", [".neurotrace"], "Open project"],
]) {
  test(`optional ${format} guidance retains file requirements and its primary action`, () => {
    const tree = harness({ importChoice: format }).render();
    const requirements = elements(tree, (node) => node.props?.className === "import-requirements")[0];
    assert.ok(requirements);
    assert.deepEqual(elements(requirements, (node) => node.type === "input" && node.props.type === "file").map((input) => input.props.accept), extensions);
    assert.equal(button(tree, action).props.disabled, true);
    assert.equal(button(tree, "Choose files").props.disabled, false);
    assert.equal(button(tree, "Choose folder").props.disabled, false);
  });
}

test("busy import disables acquisition buttons and inputs", () => {
  const tree = harness({ importBusy: true }).render();
  assert.equal(button(tree, "Choose files").props.disabled, true);
  assert.equal(button(tree, "Choose folder").props.disabled, true);
  assert.ok(elements(tree, (node) => node.type === "input" && node.props.type === "file").every((input) => input.props.disabled));
});

test("actual input handler snapshots files and folder provenance before clearing the chooser", async () => {
  for (const fromDirectory of [false, true]) {
    const files = [{ name: "one.edf" }, { name: "two.edf" }];
    const routed = [];
    const target = { files, webkitdirectory: fromDirectory, value: "chosen-path" };
    await handler("stageDetectedImport", { handleSelectedRecordingFiles: (selected, isDirectory) => {
      assert.equal(target.value, "");
      assert.notEqual(selected, files, "snapshot the live chooser list");
      routed.push([selected, isDirectory]);
    } })({ target });
    assert.equal(target.value, "");
    assert.deepEqual(routed, [[files, fromDirectory]]);
  }
});

test("cancelled chooser does not invoke classification or discard staged selections", async () => {
  const target = { files: [], value: "old-input-value", webkitdirectory: true };
  await handler("stageDetectedImport", { handleSelectedRecordingFiles: () => assert.fail("cancelled chooser must not route") })({ target });
  assert.equal(target.value, "");
});

test("readiness follows detected plans or required manual files without a mode variable", () => {
  const node = declarations.get("guidedImportReady");
  assert.ok(node);
  const ready = (env) => Boolean(evaluate(`const result = ${node.initializer.getText(syntax)};`, "result", env));
  const file = { name: "session.edf" };
  const plan = { format: "edf", recordings: [{ id: "one" }] };
  assert.equal(ready({ importChoice: "edf", stagedDirectoryPlan: plan, guidedImportSelection: emptySelection }), true);
  assert.equal(ready({ importChoice: "mat", stagedDirectoryPlan: plan, guidedImportSelection: emptySelection }), false);
  assert.equal(ready({ importChoice: "edf", stagedDirectoryPlan: { ...plan, recordings: [] }, guidedImportSelection: emptySelection }), false);
  assert.equal(ready({ importChoice: null, stagedDirectoryPlan: null, guidedImportSelection: emptySelection }), false);
  assert.equal(ready({ importChoice: "edf", stagedDirectoryPlan: null, guidedImportSelection: { ...emptySelection, edf: file } }), true);
  assert.equal(ready({ importChoice: "mat-dat", stagedDirectoryPlan: null, guidedImportSelection: { ...emptySelection, mat: file } }), false);
  assert.equal(ready({ importChoice: "mat-dat", stagedDirectoryPlan: null, guidedImportSelection: { ...emptySelection, mat: file, dat: file } }), true);
});
