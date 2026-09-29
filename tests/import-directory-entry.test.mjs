/** Execute the real welcome/import JSX: choose a format, then a file or directory picker. */
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
let workspace;
function attribute(node, name) {
  const item = node.openingElement.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.getText(syntax) === name);
  return item?.initializer && ts.isStringLiteral(item.initializer) ? item.initializer.text : null;
}
function collect(node) {
  if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
  if (ts.isJsxElement(node)) {
    if (node.openingElement.tagName.getText(syntax) === "main") workspace = node;
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
function jsxHandler(node, name, env) {
  const attribute = node.openingElement.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.getText(syntax) === name);
  assert.ok(attribute?.initializer && ts.isJsxExpression(attribute.initializer), `find actual ${name} JSX callback`);
  return evaluate(`const actualHandler = ${attribute.initializer.expression.getText(syntax)};`, "actualHandler", env);
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
function pickerButtons(ui) {
  const choices = [];
  const isAction = (node) => node.type === "button" && node.props.onClick;
  const realButtons = elements(ui.render(), isAction);
  const realOpen = ui.env.openImportPicker;
  ui.env.openImportPicker = (mode) => choices.push(mode);
  const found = new Map();
  for (const [index, node] of elements(ui.render(), isAction).entries()) {
    // Only inspect the dedicated picker actions; avoid firing format cards or close/submit actions.
    if (!node.props.onClick.toString().includes("openImportPicker")) continue;
    const before = choices.length;
    node.props.onClick();
    assert.equal(choices.length, before + 1);
    found.set(choices.at(-1), realButtons[index]);
  }
  ui.env.openImportPicker = realOpen;
  return found;
}
function state(env, key, initial) {
  env[key] = initial;
  env[`set${key[0].toUpperCase()}${key.slice(1)}`] = (value) => { env[key] = typeof value === "function" ? value(env[key]) : value; };
}
function harness(options = {}) {
  const actions = [];
  const env = {
    useCallback: (callback) => callback,
    pendingDat: null, importBusy: false, importBusyRef: { current: false },
    guidedImportReady: false,
    directoryConfirmationRef: { current: null },
    guidedFilesInputRef: { current: null },
    guidedDirectoryInputRef: { current: null },
    fileDragDepthRef: { current: 0 },
    handleDroppedRecordingFiles: (...args) => actions.push(["dropped", ...args]),
    stageDetectedImport: (event) => actions.push(["detected", event]),
    submitGuidedImport: () => actions.push(["submit"]),
  };
  for (const [key, value] of Object.entries({ showImport: false, importChoice: null, importPickerKind: null, fileDragActive: false,
    stagedDirectoryPlan: null, uploadError: null })) state(env, key, value);
  Object.assign(env, options);
  env.setShowImportOpen = (open) => { env.showImport = open; };
  env.setShowImport = (open) => handler("setShowImport", env)(open);
  env.chooseImportType = (format) => handler("chooseImportType", env)(format);
  env.openImportPicker = (mode) => handler("openImportPicker", env)(mode);
  return {
    env, actions,
    render: () => evaluate(`const render = () => (${dialog.getText(syntax)});`, "render()", env),
    welcome: () => evaluate(`const render = () => (${welcomeButton.getText(syntax)});`, "render()", env),
  };
}

test("welcome requires a recording type before exposing file or folder selection", () => {
  const ui = harness();
  ui.welcome().props.onClick();
  assert.equal(ui.env.showImport, true);
  assert.equal(ui.env.importChoice, null);
  const tree = ui.render();
  assert.equal(elements(tree, (node) => node.props?.["aria-label"] === "Recording import mode").length, 0);
  assert.equal(declarations.has("chooseImportMode"), false);
  for (const label of ["EDF / EDF+", "MAT", "MAT + DAT", "NeuroTrace"]) {
    assert.equal(formatButton(tree, label).props.disabled, false);
    assert.equal(formatButton(tree, label).props["aria-pressed"], false, "no format is selected initially");
  }
  assert.equal(pickerButtons(ui).size, 0, "file and folder actions are revealed only after selecting a type");
  const obsoleteActions = new Set(["Single recording", "Recording directory"]);
  assert.equal(elements(tree, (node) => node.type === "button" && (obsoleteActions.has(node.props["aria-label"]) || obsoleteActions.has(text(node).trim()))).length, 0);
  assert.equal(elements(tree, (node) => node.props?.className === "import-requirements").length, 0);
});

test("file and folder actions share neutral styling and highlight green only on enabled hover or keyboard focus", async () => {
  const choices = pickerButtons(harness({ importChoice: "edf" }));
  const files = choices.get("files");
  const folder = choices.get("directory");
  assert.equal(files.props.className, folder.props.className, "neither picker choice is permanently highlighted");
  for (const action of [files, folder]) {
    assert.doesNotMatch(action.props.className, /\bprimary\b/);
    assert.equal(action.props["aria-pressed"], undefined, "picker actions are not persistent selected states");
  }
  const css = await readFile(new URL("../app/directory-sessions.css", import.meta.url), "utf8");
  const highlight = css.match(/\.recording-import-actions\s+\.button:not\(:disabled\):is\(:hover,\s*:focus-visible\)\s*\{([^}]+)\}/)?.[1];
  assert.ok(highlight, "both enabled choices share their hover and keyboard-focus highlight rule");
  assert.match(highlight, /background:\s*var\(--mint\)/);
  assert.match(highlight, /border-color:\s*var\(--mint\)/);
  assert.match(highlight, /color:\s*#[0-9a-f]{3,8}\b/i, "green highlight uses explicit contrasting text");
  assert.match(highlight, /box-shadow:/);
});

test("the import dialog has separate hidden file and recursive-directory pickers wired to auto-detection", () => {
  const ui = harness();
  const tree = ui.render();
  const pickers = elements(tree, (node) => node.type === "input" && node.props.type === "file");
  assert.equal(pickers.length, 2);
  assert.ok(pickers.every((input) => input.props.multiple && input.props.hidden));
  const files = pickers.find((input) => input.props.ref === ui.env.guidedFilesInputRef);
  const folder = pickers.find((input) => input !== files);
  assert.ok(files, "ordinary file input uses its own ref");
  assert.equal(files.props.webkitdirectory, undefined);
  const directoryElement = {};
  folder.props.ref(directoryElement);
  assert.equal(ui.env.guidedDirectoryInputRef.current, directoryElement);
  assert.equal(directoryElement.webkitdirectory, true, "folder chooser selects the folder itself recursively");
  const fileEvent = { target: { files: [{ name: "one.edf" }] } };
  const directoryEvent = { target: { files: [{ name: "nested.edf" }], webkitdirectory: true } };
  files.props.onChange(fileEvent);
  folder.props.onChange(directoryEvent);
  assert.deepEqual(ui.actions, [["detected", fileEvent], ["detected", directoryEvent]]);
  assert.doesNotThrow(() => folder.props.ref(null), "directory input can unmount cleanly");
  assert.equal(ui.env.guidedDirectoryInputRef.current, null);
});

for (const [format, label, accept] of [["edf", "EDF / EDF+", ".edf"], ["mat", "MAT", ".mat"], ["mat-dat", "MAT + DAT", ".mat,.dat"], ["neurotrace", "NeuroTrace", ".neurotrace"]]) {
  test(`${label} card selects its format without opening Explorer and reveals both picker choices`, () => {
    const ui = harness();
    const unexpectedPicker = { click: () => assert.fail("choosing a format must not skip the file/folder choice") };
    ui.env.guidedFilesInputRef.current = unexpectedPicker;
    ui.env.guidedDirectoryInputRef.current = unexpectedPicker;
    formatButton(ui.render(), label).props.onClick();
    assert.equal(ui.env.importChoice, format);
    const after = ui.render();
    assert.equal(formatButton(after, label).props["aria-pressed"], true);
    assert.equal(elements(after, (node) => node.type === "button" && node.props["aria-pressed"] === true).length, 1);
    assert.deepEqual(new Set(pickerButtons(ui).keys()), new Set(["files", "directory"]));
    assert.equal(elements(after, (node) => node.props?.className === "import-requirements").length, 0);
  });

  for (const mode of ["files", "directory"]) {
    test(`${label} ${mode} action opens only its native picker synchronously`, () => {
      const ui = harness({ importChoice: format });
      let calls = 0;
      const input = { accept: "old-filter", multiple: false, value: "old-selection", click: () => {
        assert.equal(ui.env.importPickerKind, mode, "drop mode is updated by the explicit picker action before Explorer opens");
        assert.equal(input.accept, mode === "files" ? accept : "", "file filter or unrestricted directory filter is applied before activation");
        assert.equal(input.multiple, true);
        assert.equal(input.value, "", "reset the input so the same selection can be chosen again");
        calls += 1;
      } };
      const otherInput = { click: () => assert.fail("do not open the other picker") };
      ui.env.guidedFilesInputRef.current = mode === "files" ? input : otherInput;
      ui.env.guidedDirectoryInputRef.current = mode === "directory" ? input : otherInput;
      const choices = pickerButtons(ui);
      assert.equal(choices.get(mode).props.disabled, false);
      const result = choices.get(mode).props.onClick();
      assert.equal(calls, 1, "native picker opens within the button click's user gesture");
      assert.equal(result instanceof Promise, false, "no async boundary before native picker activation");
    });
  }
}

for (const [format, label] of [["edf", /EDF/], ["mat", /MAT/], ["mat-dat", /MAT\s*\+\s*DAT/], ["neurotrace", /NeuroTrace/]]) {
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

test("busy import disables format cards, both inputs, and file/folder actions", () => {
  const ui = harness({ importBusy: true, importBusyRef: { current: true } });
  ui.env.guidedFilesInputRef.current = { click: () => assert.fail("busy import must not open a competing picker") };
  ui.env.guidedDirectoryInputRef.current = ui.env.guidedFilesInputRef.current;
  const tree = ui.render();
  for (const label of ["EDF / EDF+", "MAT", "MAT + DAT", "NeuroTrace"]) {
    const card = formatButton(tree, label);
    assert.equal(card.props.disabled, true);
    card.props.onClick();
  }
  assert.ok(elements(tree, (node) => node.type === "input" && node.props.type === "file").every((input) => input.props.disabled));
  assert.equal(ui.env.importChoice, null);
  ui.env.importChoice = "edf";
  for (const mode of ["files", "directory"]) {
    assert.equal(pickerButtons(ui).get(mode).props.disabled, true);
    assert.doesNotThrow(() => ui.env.openImportPicker(mode));
  }
});

test("home drop instructions describe files and reserve folder drops for the explicit folder choice", () => {
  const ui = harness();
  assert.match(text(ui.welcome()), /drop[^.]*files/i);
  assert.doesNotMatch(text(ui.welcome()), /drop[^.]*folder/i);
  assert.doesNotMatch(text(ui.render()), /drop files or a folder anywhere/i);
});

function dropEvent(types = ["Files"]) {
  const calls = { prevented: 0, stopped: 0 };
  return { calls, dataTransfer: { types },
    preventDefault: () => { calls.prevented += 1; }, stopPropagation: () => { calls.stopped += 1; } };
}

test("workspace drops never opt into directory traversal, even after choosing Folder in the dialog", () => {
  for (const importPickerKind of [null, "files", "directory"]) {
    const ui = harness({ importChoice: "edf", importPickerKind });
    const event = dropEvent();
    jsxHandler(workspace, "onDrop", ui.env)(event);
    assert.equal(event.calls.prevented, 1);
    assert.equal(ui.actions.length, 1);
    assert.equal(ui.actions[0][0], "dropped");
    assert.equal(ui.actions[0][1], event.dataTransfer);
    assert.equal(ui.actions[0][2] ?? false, false, "only the dedicated dialog is a folder drop target");
  }
});

test("dialog drops allow folders only after both a type and Folder are selected", () => {
  for (const [importChoice, importPickerKind, pendingDat, allowed] of [
    [null, null, null, false], ["edf", null, null, false], ["edf", "files", null, false],
    ["edf", "directory", null, true], ["mat-dat", "directory", null, true],
    [null, "directory", null, false], ["mat-dat", "directory", { name: "signal.dat" }, false],
  ]) {
    const ui = harness({ importChoice, importPickerKind, pendingDat });
    const event = dropEvent();
    jsxHandler(dialog, "onDrop", ui.env)(event);
    assert.equal(event.calls.prevented, 1);
    assert.equal(event.calls.stopped, 1, "a dialog drop cannot also reach the workspace importer");
    assert.deepEqual(ui.actions, [["dropped", event.dataTransfer, allowed]]);
  }
});

test("file drop handlers ignore label and text drags and do not start competing imports", () => {
  for (const surface of [workspace, dialog]) {
    const ui = harness({ importChoice: "edf", importPickerKind: "directory" });
    const labelEvent = dropEvent(["application/neurotrace-label", "text/plain"]);
    jsxHandler(surface, "onDrop", ui.env)(labelEvent);
    assert.deepEqual(labelEvent.calls, { prevented: 0, stopped: 0 });
    assert.deepEqual(ui.actions, []);
    ui.env.importBusyRef.current = true;
    jsxHandler(surface, "onDrop", ui.env)(dropEvent());
    assert.deepEqual(ui.actions, []);
  }
});

test("Folder activation gates dialog drops until Files, a different type, or dialog close resets it", () => {
  const ui = harness({ importChoice: "edf", showImport: true });
  const input = { click: () => {} };
  ui.env.guidedFilesInputRef.current = input;
  ui.env.guidedDirectoryInputRef.current = input;
  const allowsFolderDrop = () => {
    ui.actions.length = 0;
    jsxHandler(dialog, "onDrop", ui.env)(dropEvent());
    return ui.actions[0]?.[2];
  };
  ui.env.openImportPicker("directory");
  assert.equal(ui.env.importPickerKind, "directory");
  assert.equal(allowsFolderDrop(), true);
  ui.env.openImportPicker("files");
  assert.equal(ui.env.importPickerKind, "files");
  assert.equal(allowsFolderDrop(), false);
  ui.env.openImportPicker("directory");
  ui.env.chooseImportType("mat");
  assert.equal(ui.env.importPickerKind, null);
  assert.equal(allowsFolderDrop(), false);
  ui.env.openImportPicker("directory");
  button(ui.render(), "Close").props.onClick();
  assert.equal(ui.env.showImport, false);
  assert.equal(ui.env.importPickerKind, null);
  ui.welcome().props.onClick();
  assert.equal(ui.env.showImport, true);
  assert.equal(allowsFolderDrop(), false, "reopening the dialog cannot inherit previous folder-drop permission");
});

test("a missing native picker cannot enable folder dropping", () => {
  const ui = harness({ importChoice: "edf" });
  ui.env.openImportPicker("directory");
  assert.equal(ui.env.importPickerKind, null);
});

test("backdrop and Escape close paths reset the explicit folder-drop choice", () => {
  const backdrop = dialog.parent;
  const ui = harness({ showImport: true, importChoice: "edf", importPickerKind: "directory" });
  const target = {};
  jsxHandler(backdrop, "onMouseDown", ui.env)({ target, currentTarget: target });
  assert.equal(ui.env.showImport, false);
  assert.equal(ui.env.importPickerKind, null);

  let escapeBranch;
  function findEscape(node) {
    if (ts.isIfStatement(node) && node.expression.getText(syntax) === "showImport && !importBusy") escapeBranch = node;
    ts.forEachChild(node, findEscape);
  }
  findEscape(syntax);
  assert.ok(escapeBranch, "the modal Escape chain includes the recording importer");
  ui.env.showImport = true;
  ui.env.importPickerKind = "directory";
  evaluate(`if (${escapeBranch.expression.getText(syntax)}) ${escapeBranch.thenStatement.getText(syntax)}`, "undefined", ui.env);
  assert.equal(ui.env.showImport, false);
  assert.equal(ui.env.importPickerKind, null);
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

test("changing format and cancelling either picker preserves the staged collection and its Load action", () => {
  for (const mode of ["files", "directory"]) {
    const plan = { format: "edf", recordings: [{ id: "one", relativePath: "root/one.edf" }], supportingFiles: [] };
    const error = { title: "Earlier warning", message: "Preserve until another selection is accepted", files: [] };
    const ui = harness({ importChoice: "edf", stagedDirectoryPlan: plan, uploadError: error });
    let opened = 0;
    ui.env.guidedFilesInputRef.current = { click: () => { opened += 1; } };
    ui.env.guidedDirectoryInputRef.current = ui.env.guidedFilesInputRef.current;
    formatButton(ui.render(), "MAT").props.onClick();
    assert.equal(opened, 0);
    ui.env.openImportPicker(mode);
    assert.equal(opened, 1);
    const cancelled = { target: { files: [], value: "", webkitdirectory: mode === "directory" } };
    handler("stageDetectedImport", { handleSelectedRecordingFiles: () => assert.fail("cancel must not route") })(cancelled);
    assert.equal(ui.env.stagedDirectoryPlan, plan);
    assert.equal(ui.env.uploadError, error);
    const node = declarations.get("guidedImportReady");
    ui.env.guidedImportReady = evaluate(`const result = ${node.initializer.getText(syntax)};`, "result", ui.env);
    assert.equal(button(ui.render(), "Load 1 sessions").props.disabled, false);
  }
});

test("format selection works before inputs mount and picker actions safely ignore missing refs", () => {
  const ui = harness();
  assert.doesNotThrow(() => formatButton(ui.render(), "MAT + DAT").props.onClick());
  assert.equal(ui.env.importChoice, "mat-dat");
  for (const mode of ["files", "directory"]) assert.doesNotThrow(() => ui.env.openImportPicker(mode));
});

test("programmatic file/folder actions cannot bypass choosing a recording type", () => {
  const ui = harness();
  ui.env.guidedFilesInputRef.current = { click: () => assert.fail("choose a format before activating a picker") };
  ui.env.guidedDirectoryInputRef.current = ui.env.guidedFilesInputRef.current;
  for (const mode of ["files", "directory"]) ui.env.openImportPicker(mode);
  assert.equal(ui.env.importChoice, null);
});
