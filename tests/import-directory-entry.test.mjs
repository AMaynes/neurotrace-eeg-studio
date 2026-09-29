/** Execute the real welcome/import JSX: a format card must open the picker in the same gesture. */
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
function formatButton(tree, label) {
  const group = elements(tree, (node) => node.props?.["aria-label"] === "Recording formats")[0];
  assert.ok(group, "recording format actions are visible");
  const found = elements(group, (node) => node.type === "button" && elements(node, (child) => child.type === "strong" && text(child) === label).length)[0];
  assert.ok(found, `find ${label} format card`);
  return found;
}
function state(env, key, initial) {
  env[key] = initial;
  env[`set${key[0].toUpperCase()}${key.slice(1)}`] = (value) => { env[key] = typeof value === "function" ? value(env[key]) : value; };
}
function harness(options = {}) {
  const actions = [];
  const env = {
    pendingDat: null, importBusy: false, importBusyRef: { current: false },
    guidedImportReady: false,
    directoryConfirmationRef: { current: null },
    guidedFilesInputRef: { current: null },
    stageDetectedImport: (event) => actions.push(["detected", event]),
    submitGuidedImport: () => actions.push(["submit"]),
  };
  for (const [key, value] of Object.entries({ showImport: false, importChoice: null,
    stagedDirectoryPlan: null, uploadError: null })) state(env, key, value);
  Object.assign(env, options);
  env.chooseImportType = (format) => handler("chooseImportType", env)(format);
  return {
    env, actions,
    render: () => evaluate(`const render = () => (${dialog.getText(syntax)});`, "render()", env),
    welcome: () => evaluate(`const render = () => (${welcomeButton.getText(syntax)});`, "render()", env),
  };
}

test("welcome exposes format cards directly without browse buttons, mode switches, or extra file rows", () => {
  const ui = harness();
  ui.welcome().props.onClick();
  assert.equal(ui.env.showImport, true);
  assert.equal(ui.env.importChoice, null);
  const tree = ui.render();
  assert.equal(elements(tree, (node) => node.props?.["aria-label"] === "Recording import mode").length, 0);
  assert.equal(declarations.has("chooseImportMode"), false);
  for (const label of ["EDF / EDF+", "MAT", "MAT + DAT", "NeuroTrace"]) {
    assert.equal(formatButton(tree, label).props.disabled, false);
    assert.equal(formatButton(tree, label).props["aria-pressed"], undefined, "formats are picker actions, not mode toggles");
  }
  const obsoleteActions = new Set(["Choose files", "Choose folder", "Single recording", "Recording directory"]);
  assert.equal(elements(tree, (node) => node.type === "button" && (obsoleteActions.has(node.props["aria-label"]) || obsoleteActions.has(text(node).trim()))).length, 0);
  assert.equal(elements(tree, (node) => node.props?.className === "import-requirements").length, 0);
});

test("the import dialog has one ordinary multi-file picker wired to auto-detection", () => {
  const ui = harness();
  const tree = ui.render();
  const pickers = elements(tree, (node) => node.type === "input" && node.props.type === "file");
  assert.equal(pickers.length, 1);
  assert.equal(pickers[0].props.multiple, true);
  assert.equal(pickers[0].props.hidden, true);
  assert.equal(pickers[0].props.ref, ui.env.guidedFilesInputRef);
  assert.equal(pickers[0].props.webkitdirectory, undefined);
  const fileEvent = { target: { files: [{ name: "one.edf" }] } };
  pickers[0].props.onChange(fileEvent);
  assert.deepEqual(ui.actions, [["detected", fileEvent]]);
});

for (const [label, accept] of [["EDF / EDF+", ".edf"], ["MAT", ".mat"], ["MAT + DAT", ".mat,.dat"], ["NeuroTrace", ".neurotrace"]]) {
  test(`${label} card synchronously opens a multi-file picker with the matching file filter`, () => {
    const ui = harness();
    let calls = 0;
    const input = { accept: "old-filter", multiple: false, value: "old-selection", click: () => {
      assert.equal(input.accept, accept, "filter is set before native picker activation");
      assert.equal(input.multiple, true);
      assert.equal(input.value, "", "reset the input so the same files can be selected again");
      calls += 1;
    } };
    ui.env.guidedFilesInputRef.current = input;
    const result = formatButton(ui.render(), label).props.onClick();
    assert.equal(calls, 1, "picker opens immediately in the card click's user gesture");
    assert.equal(result instanceof Promise, false, "no deferred render or async boundary before opening");
    const after = ui.render();
    assert.equal(elements(after, (node) => node.type === "input" && node.props.type === "file").length, 1);
    assert.equal(elements(after, (node) => node.props?.className === "import-requirements").length, 0);
    assert.doesNotMatch(text(after), /Open recording|Open project/, "a format click does not add another selection or submit step");
  });
}

for (const [format, label] of [["edf", /EDF/], ["mat", /MAT/], ["mat-dat", /MAT\s*\+\s*DAT/]]) {
  test(`detected ${format} collection displays its format and lazy action without manual file rows`, () => {
    const ui = harness({ importChoice: format, guidedImportReady: true,
      stagedDirectoryPlan: { format, recordings: [{ id: "one", relativePath: "root/one" }, { id: "two", relativePath: "root/sub/two" }], supportingFiles: [] } });
    const tree = ui.render();
    assert.match(text(tree), /2\s+sessions found/);
    assert.match(text(tree), label);
    assert.ok(formatButton(tree, "EDF / EDF+"), "the user can replace the collection through a format card");
    assert.equal(elements(tree, (node) => node.props?.className === "import-requirements").length, 0);
    const load = button(tree, "Load 2 sessions");
    assert.equal(load.props.disabled, false);
    load.props.onClick();
    assert.deepEqual(ui.actions, [["submit"]]);
  });
}

test("busy import disables format cards and input and guards programmatic picker activation", () => {
  const ui = harness({ importBusy: true, importBusyRef: { current: true } });
  ui.env.guidedFilesInputRef.current = { click: () => assert.fail("busy import must not open a competing picker") };
  const tree = ui.render();
  for (const label of ["EDF / EDF+", "MAT", "MAT + DAT", "NeuroTrace"]) {
    const card = formatButton(tree, label);
    assert.equal(card.props.disabled, true);
    card.props.onClick();
  }
  assert.ok(elements(tree, (node) => node.type === "input" && node.props.type === "file").every((input) => input.props.disabled));
  assert.equal(ui.env.importChoice, null);
});

test("folder help describes dropping a folder, not selecting one through the ordinary file picker", () => {
  const ui = harness();
  assert.match(text(ui.render()), /drop[^.]*folder/i);
  assert.match(text(ui.welcome()), /drop[^.]*folder/i);
  assert.doesNotMatch(text(ui.render()), /choose[^.]*files or a folder|choose folder|choose a directory/i);
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

test("directory readiness depends on a nonempty detected plan, not the last clicked format card", () => {
  const node = declarations.get("guidedImportReady");
  assert.ok(node);
  const ready = (env) => Boolean(evaluate(`const result = ${node.initializer.getText(syntax)};`, "result", env));
  const plan = { format: "edf", recordings: [{ id: "one" }] };
  assert.equal(ready({ importChoice: "edf", stagedDirectoryPlan: plan }), true);
  assert.equal(ready({ importChoice: "mat", stagedDirectoryPlan: plan }), true);
  assert.equal(ready({ importChoice: "edf", stagedDirectoryPlan: { ...plan, recordings: [] } }), false);
  assert.equal(ready({ importChoice: null, stagedDirectoryPlan: null }), false);
});

test("cancelling a different format picker preserves an existing collection and its Load action", () => {
  const plan = { format: "edf", recordings: [{ id: "one", relativePath: "root/one.edf" }], supportingFiles: [] };
  const error = { title: "Earlier warning", message: "Preserve until another selection is accepted", files: [] };
  const ui = harness({ importChoice: "edf", stagedDirectoryPlan: plan, uploadError: error });
  let opened = 0;
  ui.env.guidedFilesInputRef.current = { click: () => { opened += 1; } };
  formatButton(ui.render(), "MAT").props.onClick();
  assert.equal(opened, 1);
  const cancelled = { target: { files: [], value: "" } };
  handler("stageDetectedImport", { handleSelectedRecordingFiles: () => assert.fail("cancel must not route") })(cancelled);
  assert.equal(ui.env.stagedDirectoryPlan, plan);
  assert.equal(ui.env.uploadError, error);
  const node = declarations.get("guidedImportReady");
  ui.env.guidedImportReady = evaluate(`const result = ${node.initializer.getText(syntax)};`, "result", ui.env);
  assert.equal(button(ui.render(), "Load 1 sessions").props.disabled, false);
});

test("format actions safely do nothing before the shared input is mounted", () => {
  const ui = harness();
  assert.doesNotThrow(() => formatButton(ui.render(), "MAT + DAT").props.onClick());
  assert.equal(ui.env.importChoice, null);
});
