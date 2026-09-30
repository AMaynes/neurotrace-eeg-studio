/** Execute the page's real handlers/effect with patient-free files and state spies. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { inspectMatRecording, RawDatSource } from "../app/eeg-core.ts";
import { mergeSelectedFiles, relativeFilePath } from "../app/bids-companions.ts";
import { DirectoryImportError, directoryRecordingFiles, planDirectoryImport } from "../app/directory-import.ts";
import { classifyRecordingSelection, collectDroppedRecordingFiles } from "../app/import-selection.ts";
import { adjacentDirectoryRecording } from "../app/directory-tab-layout.ts";
import { MatDatImportError, pendingFilesForSelection, resolveMatDatImport } from "../app/mat-import.ts";
import { legacyMatFile, standaloneMatFile } from "./fixtures/legacy-mat.mjs";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
let queueEffect;
function collect(node) {
  if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
    declarations.set(node.name.text, node);
  }
  if (ts.isCallExpression(node) && node.expression.getText(syntax) === "useEffect"
    && node.arguments[0]?.getText(syntax).includes("const request = queuedDirectoryOpen;")) {
    queueEffect = node.arguments[0].getText(syntax);
  }
  ts.forEachChild(node, collect);
}
collect(syntax);
assert.ok(queueEffect, "find the actual queued directory import effect");

function declaration(name) {
  const node = declarations.get(name);
  assert.ok(node, `find actual page declaration ${name}`);
  return ts.isFunctionDeclaration(node) ? node.getText(syntax) : `const ${node.getText(syntax)};`;
}
function executable(code, result, env) {
  const javascript = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(...Object.keys(env), `${javascript}\nreturn ${result};`)(...Object.values(env));
}
function handler(name, env, helpers = []) {
  return executable([...helpers, name].map(declaration).join("\n"), name, env);
}
function state(env, key, initial) {
  env[key] = initial;
  env[`set${key[0].toUpperCase()}${key.slice(1)}`] = (value) => {
    env[key] = typeof value === "function" ? value(env[key]) : value;
  };
}
function fileAt(path, bytes = new Uint8Array(256)) {
  const file = new File([bytes], path.split("/").at(-1));
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}
function unreadableFile(path) {
  const file = fileAt(path);
  for (const method of ["arrayBuffer", "text", "slice", "stream"]) {
    file[method] = () => assert.fail(`directory discovery must not read ${method} waveform bytes`);
  }
  return file;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

function stageHarness(format = null) {
  const calls = [];
  const env = { importBusyRef: { current: false }, DirectoryImportError, classifyRecordingSelection,
    directoryConfirmationRef: { current: { stale: true } },
    handleUploadedFiles: async (files) => { calls.push(files); } };
  state(env, "importChoice", format);
  state(env, "stagedDirectoryPlan", { stale: true });
  state(env, "uploadError", { stale: true });
  state(env, "pendingDat", { stale: true });
  state(env, "showImport", false);
  return {
    env, calls,
    async stage(files, fromDirectory = true) {
      await handler("handleSelectedRecordingFiles", env)(files, fromDirectory);
    },
  };
}

test("directory selection auto-detects format and every nested session without opening recording bytes", async () => {
  const h = stageHarness();
  const files = [unreadableFile("root/sub/session10.edf"), unreadableFile("root/session2.edf"), unreadableFile("root/events.tsv")];
  await h.stage(files);
  assert.equal(h.env.stagedDirectoryPlan.recordings.length, 2);
  assert.deepEqual(new Set(h.env.stagedDirectoryPlan.recordings.map((item) => item.primary)), new Set(files.slice(0, 2)));
  assert.deepEqual(h.env.stagedDirectoryPlan.supportingFiles, [files[2]]);
  assert.equal(h.env.uploadError, null);
  assert.equal(h.env.importChoice, "edf");
  assert.equal(h.env.pendingDat, null);
  assert.equal(h.env.directoryConfirmationRef.current, null);
  assert.equal(h.env.showImport, true);
  assert.deepEqual(h.calls, [], "scanning remains lazy");
});

test("mixed-directory rejection clears stale staged plans", async () => {
  const h = stageHarness();
  await h.stage([unreadableFile("root/a.edf"), unreadableFile("root/b.mat")]);
  assert.equal(h.env.stagedDirectoryPlan, null);
  assert.match(h.env.uploadError.message, /mixed|one recording format|same[- ]format/i);
  assert.ok(h.env.uploadError.files.includes("root/b.mat"));
  assert.equal(h.env.showImport, true);
  assert.deepEqual(h.calls, []);
});

test("detected directory format overrides stale manual format choices", async () => {
  const h = stageHarness("neurotrace");
  await h.stage([unreadableFile("root/session.mat"), unreadableFile("root/session.dat")]);
  assert.equal(h.env.importChoice, "mat-dat");
  assert.equal(h.env.stagedDirectoryPlan.format, "mat-dat");
  assert.equal(h.env.uploadError, null);
  assert.deepEqual(h.calls, []);
});

test("single files route to the existing importer while clearing stale directory plans", async () => {
  const h = stageHarness("mat-dat");
  const files = [new File([new Uint8Array(256)], "session.edf")];
  await h.stage(files, false);
  assert.deepEqual(h.calls, [files]);
  assert.equal(h.env.stagedDirectoryPlan, null);
  assert.equal(h.env.directoryConfirmationRef.current, null);
  assert.equal(h.env.uploadError, null);
});

test("selecting multiple loose recordings also stages a lazy auto-detected collection", async () => {
  const h = stageHarness();
  const files = [new File([new Uint8Array(256)], "a.edf"), new File([new Uint8Array(256)], "b.edf")];
  await h.stage(files, false);
  assert.equal(h.env.stagedDirectoryPlan.recordings.length, 2);
  assert.equal(h.env.importChoice, "edf");
  assert.deepEqual(h.calls, []);
});

test("busy imports and cancelled loose-file selections cannot discard a staged selection", async () => {
  for (const busy of [false, true]) {
    const h = stageHarness();
    h.env.importBusyRef.current = busy;
    h.env.classifyRecordingSelection = () => assert.fail("guard must run before classification");
    const before = [h.env.stagedDirectoryPlan, h.env.uploadError, h.env.directoryConfirmationRef.current];
    await h.stage(busy ? [unreadableFile("root/a.edf")] : [], false);
    assert.deepEqual([h.env.stagedDirectoryPlan, h.env.uploadError, h.env.directoryConfirmationRef.current], before);
    assert.deepEqual(h.calls, []);
  }
});

test("ordinary import failures remain actionable without leaving a stale directory plan", async () => {
  const h = stageHarness();
  h.env.handleUploadedFiles = async () => { throw new Error("Unreadable recording fixture"); };
  await h.stage([new File([new Uint8Array(256)], "session.edf")], false);
  assert.equal(h.env.stagedDirectoryPlan, null);
  assert.equal(h.env.uploadError.message, "Unreadable recording fixture");
  assert.equal(h.env.showImport, true);
});

test("classification failures bound displayed paths instead of dumping an entire large directory", async () => {
  const h = stageHarness();
  const paths = Array.from({ length: 100 }, (_, index) => `root/unsupported-${index}.mat`);
  h.env.classifyRecordingSelection = () => { throw new DirectoryImportError("MIXED_FORMATS", "Mixed recording formats", paths); };
  await h.stage([unreadableFile("root/source.edf")]);
  assert.equal(h.env.stagedDirectoryPlan, null);
  assert.equal(h.env.uploadError.message, "Mixed recording formats");
  assert.deepEqual(h.env.uploadError.files, paths.slice(0, 8));
  assert.deepEqual(h.calls, []);
});

test("drop routing holds its busy guard through asynchronous discovery and releases it before import", async () => {
  for (const allowDirectories of [false, true]) {
    const h = stageHarness();
    state(h.env, "importBusy", false);
    const transfer = {};
    const files = [unreadableFile("root/source.edf")];
    let finish;
    const routed = [];
    h.env.collectDroppedRecordingFiles = (value, options) => {
      assert.equal(value, transfer);
      assert.deepEqual(options, { allowDirectories });
      assert.equal(h.env.importBusy, true);
      assert.equal(h.env.importBusyRef.current, true);
      return new Promise((resolve) => { finish = resolve; });
    };
    h.env.handleSelectedRecordingFiles = async (...args) => {
      assert.equal(h.env.importBusy, false);
      assert.equal(h.env.importBusyRef.current, false);
      routed.push(args);
    };
    const drop = handler("handleDroppedRecordingFiles", h.env);
    const pending = drop(transfer, allowDirectories);
    await drop({ competingDrop: true }, allowDirectories);
    assert.deepEqual(routed, []);
    finish({ files, directory: true });
    await pending;
    assert.deepEqual(routed, [[files, true]]);
  }
});

function transferWithEntries(entries) {
  return { files: [], items: entries.map((entry) => ({ kind: "file", webkitGetAsEntry: () => entry, getAsFile: () => null })) };
}
function droppedFileEntry(file, onRead = () => {}) {
  return { name: file.name, isFile: true, isDirectory: false, file: (resolve) => { onRead(); resolve(file); } };
}
function droppedDirectoryEntry(name, children, onRead = () => {}) {
  return { name, isFile: false, isDirectory: true, createReader: () => {
    onRead();
    let delivered = false;
    return { readEntries: (resolve) => { resolve(delivered ? [] : children); delivered = true; } };
  } };
}

test("ordinary workspace drops still route a single recording or matched MAT/DAT pair without directory opt-in", async () => {
  for (const files of [
    [new File([new Uint8Array(256)], "signal.edf")],
    [legacyMatFile({ name: "signal.mat" }), new File([new Uint8Array(256)], "signal.dat")],
  ]) {
    const h = stageHarness();
    state(h.env, "importBusy", false);
    h.env.collectDroppedRecordingFiles = collectDroppedRecordingFiles;
    h.env.handleSelectedRecordingFiles = handler("handleSelectedRecordingFiles", h.env);
    await handler("handleDroppedRecordingFiles", h.env)(transferWithEntries(files.map((file) => droppedFileEntry(file))));
    assert.deepEqual(h.calls, [files]);
    assert.equal(h.env.uploadError, null);
    assert.equal(h.env.importBusyRef.current, false);
  }
});

test("workspace folder drops reject the entire selection before directory traversal or partial file reads", async () => {
  const h = stageHarness();
  state(h.env, "importBusy", false);
  h.env.collectDroppedRecordingFiles = collectDroppedRecordingFiles;
  h.env.handleSelectedRecordingFiles = () => assert.fail("a rejected folder must not import even the loose files beside it");
  const read = () => assert.fail("the folder opt-in gate must run before any dropped entry is read");
  const transfer = transferWithEntries([
    droppedFileEntry(new File([new Uint8Array(256)], "loose.edf"), read),
    droppedDirectoryEntry("recordings", [], read),
  ]);
  await handler("handleDroppedRecordingFiles", h.env)(transfer);
  assert.equal(h.env.stagedDirectoryPlan, null);
  assert.match(h.env.uploadError.message, /folder|director/i);
  assert.equal(h.env.showImport, true);
  assert.equal(h.env.importBusyRef.current, false);
  assert.deepEqual(h.calls, []);
});

test("explicit dialog folder opt-in collects nested recordings lazily without reading waveform bytes", async () => {
  const h = stageHarness();
  state(h.env, "importBusy", false);
  h.env.collectDroppedRecordingFiles = collectDroppedRecordingFiles;
  h.env.handleSelectedRecordingFiles = handler("handleSelectedRecordingFiles", h.env);
  const file = new File([new Uint8Array(256)], "signal.edf");
  for (const method of ["arrayBuffer", "text", "slice", "stream"]) file[method] = () => assert.fail("folder discovery must not decode or copy signals");
  const transfer = transferWithEntries([droppedDirectoryEntry("recordings", [droppedDirectoryEntry("day1", [droppedFileEntry(file)])])]);
  await handler("handleDroppedRecordingFiles", h.env)(transfer, true);
  assert.equal(h.env.stagedDirectoryPlan.recordings.length, 1);
  assert.equal(h.env.stagedDirectoryPlan.recordings[0].primary, file);
  assert.equal(file.webkitRelativePath, "recordings/day1/signal.edf");
  assert.equal(h.env.uploadError, null);
  assert.deepEqual(h.calls, [], "folder ingestion only creates the session list");
});

test("failed drop discovery clears stale selections and reports an error without importing partial files", async () => {
  const h = stageHarness();
  state(h.env, "importBusy", false);
  h.env.collectDroppedRecordingFiles = async () => { throw new Error("Unreadable directory entry"); };
  h.env.handleSelectedRecordingFiles = () => assert.fail("failed traversal cannot import a partial collection");
  await handler("handleDroppedRecordingFiles", h.env)({});
  assert.equal(h.env.stagedDirectoryPlan, null);
  assert.equal(h.env.uploadError.message, "Unreadable directory entry");
  assert.equal(h.env.showImport, true);
  assert.equal(h.env.importBusy, false);
  assert.equal(h.env.importBusyRef.current, false);
});

test("loading a directory installs only the catalogue, preserving lazy recording imports", async () => {
  const plan = planDirectoryImport([unreadableFile("root/a.edf"), unreadableFile("root/b.edf")], "edf");
  const tabs = new Map([["stale-recording", { sessionId: "old" }]]);
  const previous = { sessions: tabs, statuses: { "stale-recording": { state: "loaded" } } };
  const env = {
    // A later MAT picker can be cancelled while this EDF collection stays ready.
    guidedImportReady: true, importChoice: "mat", stagedDirectoryPlan: plan,
    importBusyRef: { current: false }, queuedDirectoryOpenRef: { current: null },
    directoryCatalogIdRef: { current: "old" }, directorySessionTabsRef: { current: tabs },
    directoryCatalogWorkspacesRef: { current: new Map([["old", previous]]) },
    directoryConfirmationRef: { current: { stale: true } }, makeId: () => "new-directory",
    handleUploadedFiles: () => assert.fail("cataloguing must not import any recording"),
  };
  for (const [key, value] of Object.entries({ directoryStatuses: { stale: true }, directoryCatalog: null,
    directoryCatalogs: [{ id: "old", plan }], showImport: true, showDirectorySessions: false, toast: "", stagedDirectoryPlan: plan })) state(env, key, value);
  await handler("submitGuidedImport", env)();
  assert.equal(env.directoryCatalog.plan, plan);
  assert.equal(env.directoryCatalog.id, "new-directory");
  assert.equal(env.directoryCatalogIdRef.current, "new-directory");
  assert.equal(tabs.size, 1, "previous directory mappings remain available");
  assert.equal(env.directorySessionTabsRef.current.size, 0);
  assert.equal(env.directoryCatalogWorkspacesRef.current.get("old"), previous);
  assert.deepEqual(env.directoryCatalogs.map((catalog) => catalog.id), ["old", "new-directory"]);
  assert.equal(env.directoryConfirmationRef.current, null);
  assert.deepEqual(env.directoryStatuses, {});
  assert.equal(env.stagedDirectoryPlan, null);
  assert.equal(env.showImport, false);
  assert.equal(env.showDirectorySessions, true);
});

test("collection submit cannot run without a staged plan or while another import is busy", async () => {
  const plan = planDirectoryImport([unreadableFile("root/a.edf")], "edf");
  for (const [stagedDirectoryPlan, busy] of [[null, false], [plan, true]]) {
    await handler("submitGuidedImport", {
      guidedImportReady: true, stagedDirectoryPlan, importBusyRef: { current: busy },
      makeId: () => assert.fail("guarded submit must not allocate or replace a collection"),
    })();
  }
});

test("selecting a MAT and DAT together routes one session through the existing file importer", async () => {
  const mat = legacyMatFile();
  const dat = new File([new Uint8Array(256)], "synthetic.dat");
  const h = stageHarness();
  await h.stage([mat, dat], false);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(new Set(h.calls[0]), new Set([mat, dat]));
  assert.equal(h.env.stagedDirectoryPlan, null);
});

function openHarness({ hasRecording = true } = {}) {
  const plan = planDirectoryImport([unreadableFile("root/a.edf"), unreadableFile("root/b.edf"), unreadableFile("root/dataset_description.json")], "edf");
  const prior = { primaryFile: unreadableFile("prior.edf"), hasRecording, annotations: [{ id: "saved-review" }] };
  const calls = { stored: 0, applied: [], switched: [] };
  const env = {
    directoryCatalog: { id: "catalog", plan }, importBusyRef: { current: false }, queuedDirectoryOpenRef: { current: null },
    directorySessionTabsRef: { current: new Map() }, sessionSnapshotsRef: { current: new Map([["prior-tab", prior]]) },
    directoryCatalogIdRef: { current: "catalog" }, directoryConfirmationRef: { current: null },
    directoryCatalogWorkspacesRef: { current: new Map() }, useCallback: (callback) => callback,
    primaryFile: prior.primaryFile, hasRecording, demoSource: {}, directoryRecordingFiles,
    makeId: () => "new-tab", shortFileName: (name) => name,
    blankSessionSnapshot: (_source, id) => ({ id, primaryFile: null, hasRecording: false, annotations: [] }),
    storeActiveSession() { calls.stored += 1; env.sessionSnapshotsRef.current.set(env.activeSessionId, prior); },
    applySessionSnapshot: (snapshot) => calls.applied.push(snapshot),
    switchSession: (id) => calls.switched.push(id),
  };
  state(env, "sessionTabs", [{ id: "prior-tab", hasRecording }]);
  state(env, "activeSessionId", "prior-tab");
  state(env, "queuedDirectoryOpen", null);
  state(env, "directoryCatalogs", [env.directoryCatalog]);
  state(env, "directoryCatalog", env.directoryCatalog);
  state(env, "directoryStatuses", {});
  state(env, "showImport", false);
  state(env, "toast", "");
  state(env, "showDirectorySessions", true);
  env.directoryCatalogWorkspacesRef.current.set("catalog", { sessions: env.directorySessionTabsRef.current, statuses: env.directoryStatuses });
  env.groupDirectorySessionTabs = handler("groupDirectorySessionTabs", {});
  env.detachDirectorySession = handler("detachDirectorySession", env);
  env.completeDirectoryReplacement = handler("completeDirectoryReplacement", env);
  return { env, prior, plan, calls, open: (recording = plan.recordings[0]) => handler("openDirectoryRecording", env)(recording) };
}

test("opening from a directory preserves the current recording and queues import into a separate blank tab", () => {
  const h = openHarness();
  h.open();
  assert.equal(h.calls.stored, 1);
  assert.equal(h.env.sessionSnapshotsRef.current.get("prior-tab"), h.prior);
  assert.deepEqual(h.prior.annotations, [{ id: "saved-review" }]);
  assert.equal(h.env.sessionTabs.length, 2);
  assert.equal(h.env.activeSessionId, "new-tab");
  assert.equal(h.calls.applied[0].hasRecording, false);
  assert.deepEqual(h.env.queuedDirectoryOpen.files, [...h.plan.recordings[0].files, ...h.plan.supportingFiles]);
  assert.equal(h.env.queuedDirectoryOpen.format, "edf");
  assert.equal(h.env.queuedDirectoryOpenRef.current, h.env.queuedDirectoryOpen);
  assert.equal(h.env.queuedDirectoryOpen.sessionId, "new-tab");
  assert.equal(h.env.showDirectorySessions, false);
});

test("opening an already loaded directory recording resumes its tab without replacing or rereading it", () => {
  const h = openHarness();
  h.env.sessionTabs.push({ id: "loaded-tab", hasRecording: true });
  h.env.directorySessionTabsRef.current.set(h.plan.recordings[0].id, { sessionId: "loaded-tab", files: h.plan.recordings[0].files });
  const loaded = { primaryFile: h.plan.recordings[0].primary, hasRecording: true, annotations: [{ id: "keep" }] };
  h.env.sessionSnapshotsRef.current.set("loaded-tab", loaded);
  h.open();
  assert.deepEqual(h.calls.switched, ["loaded-tab"]);
  assert.equal(h.calls.stored, 0);
  assert.equal(h.calls.applied.length, 0);
  assert.equal(h.env.queuedDirectoryOpen, null);
  assert.equal(h.env.sessionSnapshotsRef.current.get("loaded-tab"), loaded);
});

test("directory opening reuses an empty active tab and prevents repeated or busy opens", () => {
  const h = openHarness({ hasRecording: false });
  h.open();
  assert.equal(h.env.sessionTabs.length, 1);
  assert.equal(h.env.sessionTabs[0].directoryId, "catalog", "a reused blank tab gains directory ownership");
  assert.equal(h.env.queuedDirectoryOpen.sessionId, "prior-tab");
  const firstRequest = h.env.queuedDirectoryOpen;
  h.open(h.plan.recordings[1]);
  assert.equal(h.env.queuedDirectoryOpen, firstRequest, "double clicks cannot race imports");
  assert.equal(h.calls.stored, 1);
  const busy = openHarness();
  busy.env.importBusyRef.current = true;
  busy.open();
  assert.equal(busy.calls.stored, 0);
  assert.equal(busy.env.queuedDirectoryOpen, null);
});

test("directory opens keep related tabs contiguous without grouping unrelated sessions", () => {
  const h = openHarness();
  h.open();
  h.env.sessionTabs.push({ id: "standalone", hasRecording: true });
  h.env.hasRecording = true;
  h.env.primaryFile = h.plan.recordings[0].primary;
  h.env.queuedDirectoryOpenRef.current = null;
  h.env.makeId = () => "second-directory-tab";
  h.open(h.plan.recordings[1]);
  assert.deepEqual(h.env.sessionTabs.map((tab) => tab.id), ["prior-tab", "new-tab", "second-directory-tab", "standalone"]);
  assert.deepEqual(h.env.sessionTabs.map((tab) => tab.directoryId), [undefined, "catalog", "catalog", undefined]);
  assert.equal(h.env.activeSessionId, "second-directory-tab");
});

test("different catalogs retain independent mappings and statuses even for identical relative filenames", async () => {
  const h = openHarness();
  h.open();
  h.env.queuedDirectoryOpenRef.current = null;
  handler("updateDirectoryStatus", h.env)({ catalogId: "catalog", recordingId: h.plan.recordings[0].id }, { state: "loaded" });
  const oldWorkspace = h.env.directoryCatalogWorkspacesRef.current.get("catalog");
  const secondPlan = planDirectoryImport([unreadableFile("root/a.edf"), unreadableFile("root/c.edf")], "edf");
  h.env.guidedImportReady = true;
  h.env.makeId = () => "second-catalog";
  state(h.env, "stagedDirectoryPlan", secondPlan);
  await handler("submitGuidedImport", h.env)();
  const newWorkspace = h.env.directoryCatalogWorkspacesRef.current.get("second-catalog");
  assert.equal(oldWorkspace.sessions.get(h.plan.recordings[0].id).sessionId, "new-tab");
  assert.equal(newWorkspace.sessions.size, 0);
  assert.deepEqual(h.env.directoryStatuses, {});
  assert.equal(h.env.sessionTabs.find((tab) => tab.id === "new-tab").directoryId, "catalog");
  newWorkspace.sessions.set(secondPlan.recordings[0].id, { sessionId: "separate-tab", files: secondPlan.recordings[0].files });
  handler("updateDirectoryStatus", h.env)({ catalogId: "second-catalog", recordingId: secondPlan.recordings[0].id }, { state: "error", message: "Independent failure" });
  handler("openDirectoryCatalog", h.env)("catalog");
  assert.equal(h.env.directoryCatalog.plan, h.plan);
  assert.equal(h.env.directorySessionTabsRef.current, oldWorkspace.sessions);
  assert.deepEqual(h.env.directoryStatuses[h.plan.recordings[0].id], { state: "loaded" });
  handler("openDirectoryCatalog", h.env)("second-catalog");
  assert.equal(h.env.directoryCatalog.plan, secondPlan);
  assert.equal(h.env.directorySessionTabsRef.current, newWorkspace.sessions);
  assert.equal(h.env.directoryStatuses[secondPlan.recordings[0].id].state, "error");
  assert.equal(oldWorkspace.sessions.get(h.plan.recordings[0].id).sessionId, "new-tab");
});

test("catalog buttons cannot switch during an import or queued open, and unknown catalogs are ignored", () => {
  for (const guard of ["busy", "queued", "unknown"]) {
    const h = openHarness();
    h.env.showDirectorySessions = false;
    h.env.importBusyRef.current = guard === "busy";
    h.env.queuedDirectoryOpenRef.current = guard === "queued" ? {} : null;
    handler("openDirectoryCatalog", h.env)(guard === "unknown" ? "missing" : "catalog");
    assert.equal(h.env.showDirectorySessions, false);
    assert.equal(h.env.directoryCatalogIdRef.current, "catalog");
  }
});

test("clearing one directory detaches only its tabs and leaves other catalogs reachable", () => {
  const h = openHarness();
  h.open();
  h.env.queuedDirectoryOpenRef.current = null;
  const other = { id: "other-catalog", plan: h.plan };
  const otherWorkspace = { sessions: new Map([["other", { sessionId: "other-tab", files: [] }]]), statuses: { other: { state: "loaded" } } };
  h.env.directoryCatalogs.push(other);
  h.env.directoryCatalogWorkspacesRef.current.set(other.id, otherWorkspace);
  h.env.sessionTabs.push({ id: "other-tab", directoryId: other.id, hasRecording: true });
  const beforeIds = h.env.sessionTabs.map((tab) => tab.id);
  handler("clearDirectoryCatalog", h.env)();
  assert.deepEqual(h.env.sessionTabs.map((tab) => tab.id), beforeIds, "clearing does not close sessions");
  assert.equal(h.env.sessionTabs.find((tab) => tab.id === "new-tab").directoryId, undefined);
  assert.equal(h.env.sessionTabs.find((tab) => tab.id === "other-tab").directoryId, other.id);
  assert.deepEqual(h.env.directoryCatalogs, [other]);
  assert.equal(h.env.directoryCatalogWorkspacesRef.current.has("catalog"), false);
  assert.equal(h.env.directoryCatalogWorkspacesRef.current.get(other.id), otherWorkspace);
  handler("openDirectoryCatalog", h.env)(other.id);
  assert.equal(h.env.directoryCatalog, other);
  assert.equal(h.env.directorySessionTabsRef.current, otherWorkspace.sessions);
});

test("closing an older-directory tab prunes its retained map without removing the catalog", () => {
  const h = openHarness();
  h.open();
  h.env.queuedDirectoryOpenRef.current = null;
  const workspace = h.env.directoryCatalogWorkspacesRef.current.get("catalog");
  workspace.statuses = { [h.plan.recordings[0].id]: { state: "loaded" } };
  h.env.directoryCatalogIdRef.current = "other-catalog";
  h.env.directorySessionTabsRef.current = new Map();
  h.env.activeSessionId = "prior-tab";
  h.env.importBusy = false;
  handler("closeSession", h.env)("new-tab");
  assert.equal(workspace.sessions.size, 0);
  assert.deepEqual(h.env.directoryCatalogWorkspacesRef.current.get("catalog").statuses, {});
  assert.deepEqual(h.env.sessionTabs.map((tab) => tab.id), ["prior-tab"]);
  assert.equal(h.env.directoryCatalogs.length, 1, "empty directory remains available to reopen");
  handler("openDirectoryCatalog", h.env)("catalog");
  h.env.makeId = () => "reopened-tab";
  h.open();
  assert.equal(h.env.activeSessionId, "reopened-tab");
  assert.equal(h.env.directorySessionTabsRef.current.get(h.plan.recordings[0].id).sessionId, "reopened-tab");
});

test("successful standalone replacement detaches old catalog provenance but the original file keeps it", () => {
  const h = openHarness();
  h.open();
  const workspace = h.env.directoryCatalogWorkspacesRef.current.get("catalog");
  h.env.directoryCatalogIdRef.current = "other-catalog";
  h.env.detachDirectorySession("new-tab", h.plan.recordings[0].primary);
  assert.equal(workspace.sessions.size, 1);
  assert.equal(h.env.sessionTabs.find((tab) => tab.id === "new-tab").directoryId, "catalog");
  h.env.detachDirectorySession("new-tab", unreadableFile("standalone.edf"));
  assert.equal(workspace.sessions.size, 0);
  assert.equal(h.env.sessionTabs.find((tab) => tab.id === "new-tab").directoryId, undefined);
  const load = declaration("loadSource");
  assert.ok(load.indexOf("detachDirectorySession(targetSessionId, file)") > load.indexOf("The active session changed"),
    "provenance changes only after source verification and active-session checks succeed");
});

test("retrying a different entry in an empty directory tab removes the old pending association", () => {
  const h = openHarness({ hasRecording: false });
  h.open();
  h.env.queuedDirectoryOpenRef.current = null;
  handler("updateDirectoryStatus", h.env)({ catalogId: "catalog", recordingId: h.plan.recordings[0].id }, { state: "error" });
  h.open(h.plan.recordings[1]);
  assert.equal(h.env.directorySessionTabsRef.current.size, 1);
  assert.equal(h.env.directorySessionTabsRef.current.has(h.plan.recordings[0].id), false);
  assert.equal(h.env.directorySessionTabsRef.current.get(h.plan.recordings[1].id).sessionId, "prior-tab");
  assert.equal(h.env.directoryStatuses[h.plan.recordings[0].id], undefined);
});

test("browsing another directory preserves pending DAT confirmation and routes its eventual status to the owning catalog", () => {
  const h = openHarness();
  const request = { catalogId: "catalog", recordingId: h.plan.recordings[0].id, sessionId: "prior-tab" };
  h.env.directoryConfirmationRef.current = request;
  h.env.directoryCatalogs.push({ id: "other", plan: h.plan });
  h.env.directoryCatalogWorkspacesRef.current.set("other", { sessions: new Map(), statuses: {} });
  handler("openDirectoryCatalog", h.env)("other");
  assert.equal(h.env.directoryConfirmationRef.current, request);
  handler("updateDirectoryStatus", h.env)(request, { state: "loaded" });
  assert.deepEqual(h.env.directoryStatuses, {}, "selected list does not receive another catalog's status");
  assert.deepEqual(h.env.directoryCatalogWorkspacesRef.current.get("catalog").statuses[request.recordingId], { state: "loaded" });
  handler("clearDirectoryCatalog", h.env)();
  assert.equal(h.env.directoryConfirmationRef.current, request, "clearing a different catalog does not orphan pending confirmation");
});

test("clearing directory lists is blocked while an import or queued open is in progress", () => {
  for (const queued of [false, true]) {
    const h = openHarness();
    h.env.importBusyRef.current = !queued;
    h.env.queuedDirectoryOpenRef.current = queued ? {} : null;
    handler("clearDirectoryCatalog", h.env)();
    assert.equal(h.env.directoryCatalogIdRef.current, "catalog");
    assert.equal(h.env.directoryCatalogs.length, 1);
    assert.equal(h.env.directoryCatalogWorkspacesRef.current.has("catalog"), true);
  }
});

test("reopening a loaded project directory entry reuses the embedded recording's tab", () => {
  const h = openHarness();
  const archive = unreadableFile("root/project.neurotrace");
  const embedded = fileAt("signal.edf");
  const recording = { id: "project", label: archive.name, primary: archive, files: [archive] };
  h.env.sessionTabs.push({ id: "project-tab", hasRecording: true });
  h.env.directorySessionTabsRef.current.set(recording.id, { sessionId: "project-tab", files: [archive, embedded] });
  h.env.sessionSnapshotsRef.current.set("project-tab", { primaryFile: embedded, hasRecording: true });
  h.open(recording);
  assert.deepEqual(h.calls.switched, ["project-tab"]);
  assert.equal(h.calls.stored, 0);
  assert.equal(h.env.queuedDirectoryOpen, null, "the archive is not re-read and its review is not replaced");
});

test("queued directory session receives ancestor metadata but never another session folder's companions", () => {
  const h = openHarness();
  const first = unreadableFile("root/session1/a.edf");
  const second = unreadableFile("root/session2/b.edf");
  const shared = unreadableFile("root/dataset_description.json");
  const own = unreadableFile("root/session1/a_events.tsv");
  const other = unreadableFile("root/session2/b_events.tsv");
  const plan = planDirectoryImport([first, second, shared, own, other], "edf");
  h.env.directoryCatalog.plan = plan;
  h.open(plan.recordings.find((recording) => recording.primary === first));
  assert.deepEqual(new Set(h.env.queuedDirectoryOpen.files), new Set([first, shared, own]));
});

function queueHarness({ status = { state: "loaded" }, reject = false } = {}) {
  const request = { sessionId: "target-tab", recordingId: "recording", catalogId: "catalog", format: "mat-dat", files: [fileAt("synthetic.dat")] };
  const calls = [];
  const env = { activeSessionId: "old-tab", queuedDirectoryOpen: request, queuedDirectoryOpenRef: { current: request },
    directoryCatalogIdRef: { current: "catalog" }, directoryConfirmationRef: { current: null },
    directoryCatalogWorkspacesRef: { current: new Map([["catalog", { sessions: new Map(), statuses: {} }]]) },
    useCallback: (callback) => callback, completeDirectoryReplacement: (id) => assert.equal(id, undefined),
    directoryImportRunnerRef: { current: async (...args) => { calls.push(args); if (reject) throw new Error("synthetic failure"); return status; } },
  };
  state(env, "directoryStatuses", {});
  env.setQueuedDirectoryOpen = (value) => { env.queuedDirectoryOpen = value; };
  env.updateDirectoryStatus = handler("updateDirectoryStatus", env);
  return { env, request, calls, effect: () => executable(`const effect = ${queueEffect};`, "effect", env) };
}

function navigationHarness() {
  const h = openHarness();
  const { env, plan, prior, calls } = h;
  prior.primaryFile = plan.recordings[0].primary;
  prior.recoveryStatus = "saved";
  env.primaryFile = prior.primaryFile;
  env.pendingDat = null;
  env.biasLocks = false;
  env.importBusy = false;
  env.adjacentDirectoryRecording = adjacentDirectoryRecording;
  env.sessionTabs[0] = { id: "prior-tab", hasRecording: true, directoryId: "catalog", directoryRecordingId: plan.recordings[0].id };
  env.directorySessionTabsRef.current.set(plan.recordings[0].id, { sessionId: "prior-tab", files: plan.recordings[0].files });
  env.directoryCatalogWorkspacesRef.current.get("catalog").statuses[plan.recordings[0].id] = { state: "loaded" };
  let serial = 0;
  env.makeId = () => `navigation-${++serial}`;
  env.storeActiveSession = () => { calls.stored += 1; };
  env.applySessionSnapshot = (snapshot) => {
    calls.applied.push(snapshot);
    env.primaryFile = snapshot.primaryFile;
    env.hasRecording = snapshot.hasRecording;
  };
  env.switchSession = (id) => {
    const bindings = { ...env };
    delete bindings.switchSession;
    return handler("switchSession", bindings)(id);
  };
  env.openDirectoryRecording = (...args) => {
    const bindings = { ...env };
    delete bindings.openDirectoryRecording;
    return handler("openDirectoryRecording", bindings)(...args);
  };
  return { ...h,
    navigate: (direction, id = "catalog") => handler("navigateDirectoryRecording", env)(id, direction),
    status: (request, status) => handler("updateDirectoryStatus", env)(request, status),
  };
}

test("next replaces only the viewed directory session after a successful load, preserving tab position and reviews", () => {
  const h = navigationHarness();
  h.env.sessionTabs.push({ id: "unrelated", directoryId: "other", hasRecording: true });
  const unrelated = { annotations: [{ id: "other-review" }] };
  h.env.sessionSnapshotsRef.current.set("unrelated", unrelated);
  // A different catalog can be the most recently opened list, without changing
  // which folder owns the actively viewed tab and its arrows.
  h.env.directoryCatalog = { id: "other", plan: h.plan };
  h.env.directoryCatalogIdRef.current = "other";
  h.navigate(1);
  const request = h.env.queuedDirectoryOpen;
  assert.equal(request.replaceSessionId, "prior-tab");
  assert.equal(request.recordingId, h.plan.recordings[1].id);
  assert.equal(h.env.directoryCatalogIdRef.current, "catalog");
  assert.deepEqual(h.env.sessionTabs.map((tab) => tab.id), ["navigation-1", "prior-tab", "unrelated"]);
  assert.equal(h.env.sessionTabs[0].directoryRecordingId, h.plan.recordings[1].id);
  assert.ok(h.calls.stored > 0, "save outgoing review before opening anything");
  assert.equal(h.env.sessionSnapshotsRef.current.get("prior-tab"), h.prior, "keep outgoing session until verified");
  h.status(request, { state: "loaded" });
  assert.deepEqual(h.env.sessionTabs.map((tab) => tab.id), ["navigation-1", "unrelated"]);
  assert.equal(h.env.activeSessionId, "navigation-1");
  assert.equal(h.env.sessionSnapshotsRef.current.has("prior-tab"), false);
  assert.equal(h.env.sessionSnapshotsRef.current.get("unrelated"), unrelated);
  assert.deepEqual(h.prior.annotations, [{ id: "saved-review" }]);
  assert.equal(h.env.directorySessionTabsRef.current.has(h.plan.recordings[0].id), false);
  assert.equal(h.env.directoryStatuses[h.plan.recordings[0].id], undefined);
  assert.deepEqual(h.env.directoryStatuses[request.recordingId], { state: "loaded" });
});

test("previous navigates backwards and endpoints, other folders and standalone tabs cannot navigate", () => {
  const h = navigationHarness();
  h.navigate(-1);
  h.navigate(1, "missing");
  assert.equal(h.env.queuedDirectoryOpen, null);
  assert.equal(h.calls.stored, 0);
  h.env.sessionTabs[0].directoryRecordingId = h.plan.recordings[1].id;
  h.env.primaryFile = h.plan.recordings[1].primary;
  h.prior.primaryFile = h.env.primaryFile;
  h.env.directorySessionTabsRef.current.clear();
  h.env.directorySessionTabsRef.current.set(h.plan.recordings[1].id, { sessionId: "prior-tab", files: h.plan.recordings[1].files });
  h.navigate(1);
  assert.equal(h.env.queuedDirectoryOpen, null, "last file does not wrap");
  h.navigate(-1);
  assert.equal(h.env.queuedDirectoryOpen.recordingId, h.plan.recordings[0].id);
  assert.equal(h.env.queuedDirectoryOpen.replaceSessionId, "prior-tab");
});

test("navigating to an already-open neighbor closes outgoing tab and reuses the neighbor without rereading it", () => {
  const h = navigationHarness();
  const target = h.plan.recordings[1];
  const review = { hasRecording: true, primaryFile: target.primary, annotations: [{ id: "neighbor-review" }] };
  h.env.sessionTabs.push({ id: "neighbor", hasRecording: true, directoryId: "catalog", directoryRecordingId: target.id });
  h.env.sessionSnapshotsRef.current.set("neighbor", review);
  h.env.directorySessionTabsRef.current.set(target.id, { sessionId: "neighbor", files: target.files });
  h.navigate(1);
  assert.equal(h.env.queuedDirectoryOpen, null);
  assert.equal(h.env.activeSessionId, "neighbor");
  assert.deepEqual(h.env.sessionTabs.map((tab) => tab.id), ["neighbor"]);
  assert.equal(h.env.sessionSnapshotsRef.current.get("neighbor"), review);
  assert.equal(h.calls.applied.at(-1), review);
});

test("Bias Locks blocks backward directory actions at the handler while leaving forward navigation available", () => {
  const h = navigationHarness();
  h.env.sessionTabs[0].directoryRecordingId = h.plan.recordings[1].id;
  h.env.primaryFile = h.plan.recordings[1].primary;
  h.prior.primaryFile = h.env.primaryFile;
  h.env.directorySessionTabsRef.current.clear();
  h.env.directorySessionTabsRef.current.set(h.plan.recordings[1].id, { sessionId: "prior-tab", files: h.plan.recordings[1].files });
  h.env.biasLocks = true;
  h.navigate(-1);
  assert.equal(h.env.queuedDirectoryOpen, null);
  assert.equal(h.calls.stored, 0, "the disabled UI is not the only protection");
  assert.equal(h.env.sessionTabs.length, 1);
  h.env.biasLocks = false;
  h.navigate(-1);
  assert.equal(h.env.queuedDirectoryOpen.recordingId, h.plan.recordings[0].id, "disabling restores Previous");

  const forward = navigationHarness();
  forward.env.biasLocks = true;
  forward.navigate(1);
  assert.equal(forward.env.queuedDirectoryOpen.recordingId, forward.plan.recordings[1].id);
});

test("Bias Locks is an accessible enable/disable setting with a browser-local default-off preference", () => {
  assert.match(page, /\[biasLocks, setBiasLocks\] = useState\(false\)/);
  assert.match(page, /setBiasLocks\(localStorage.getItem\("neurotrace:bias-locks"\) === "true"\)/);
  assert.match(page, /role="switch" className="bias-locks-toggle" aria-checked=\{biasLocks\}/);
  assert.match(page, /aria-labelledby="bias-locks-label" aria-describedby="bias-locks-description"/);
  assert.match(page, /onClick=\{\(\) => changeBiasLocks\(!biasLocks\)\}/);
  assert.match(page, /\{biasLocks \? "Enabled" : "Disabled"\}/);
});

test("Settings uses only a plain heading without an introductory slogan", () => {
  const settings = page.slice(page.indexOf('className="modal settings-modal"'), page.indexOf('<ShortcutSettings'));
  assert.match(settings, /<h2>Settings<\/h2>/);
  assert.doesNotMatch(settings, /modal-eyebrow|Make the workspace|Find every application shortcut/);
});

test("Bias Locks toggles persist both values without preventing changes when storage is blocked", () => {
  for (const storageBlocked of [false, true]) {
    const saved = [];
    const env = { localStorage: { setItem: (key, value) => {
      if (storageBlocked) throw new Error("Storage unavailable");
      saved.push([key, value]);
    } } };
    state(env, "biasLocks", false);
    const change = handler("changeBiasLocks", env);
    change(true);
    assert.equal(env.biasLocks, true);
    change(false);
    assert.equal(env.biasLocks, false);
    assert.deepEqual(saved, storageBlocked ? [] : [["neurotrace:bias-locks", "true"], ["neurotrace:bias-locks", "false"]]);
  }
});

test("failed local save blocks next/previous before any session or catalog is changed", () => {
  const h = navigationHarness();
  h.prior.recoveryStatus = "error";
  h.navigate(1);
  assert.equal(h.env.queuedDirectoryOpen, null);
  assert.equal(h.env.sessionTabs.length, 1);
  assert.equal(h.env.activeSessionId, "prior-tab");
  assert.match(h.env.toast, /export.*before changing files/i);
});

test("directory navigation is blocked during loads, queued opens or pending mappings and rejects repeated clicks", () => {
  for (const guard of ["busy", "queued", "mapping", "blank", "other-folder"]) {
    const h = navigationHarness();
    if (guard === "busy") h.env.importBusyRef.current = true;
    if (guard === "queued") h.env.queuedDirectoryOpenRef.current = {};
    if (guard === "mapping") h.env.pendingDat = {};
    if (guard === "blank") h.env.hasRecording = false;
    if (guard === "other-folder") h.env.sessionTabs[0].directoryId = "other";
    h.navigate(1);
    assert.equal(h.env.queuedDirectoryOpen, null, guard);
    assert.equal(h.calls.stored, 0, guard);
  }
  const h = navigationHarness();
  h.navigate(1);
  const request = h.env.queuedDirectoryOpen;
  h.navigate(1);
  assert.equal(h.env.queuedDirectoryOpen, request);
  assert.equal(h.env.sessionTabs.length, 2);
});

test("failed and confirmation-needed replacements keep outgoing review until explicit successful completion", () => {
  for (const state of ["opening", "error", "confirmation"]) {
    const h = navigationHarness();
    h.navigate(1);
    const request = h.env.queuedDirectoryOpen;
    h.status(request, { state });
    assert.equal(h.env.sessionSnapshotsRef.current.get("prior-tab"), h.prior, state);
    assert.ok(h.env.sessionTabs.some((tab) => tab.id === "prior-tab"), state);
    if (state === "confirmation") {
      h.status(request, { state: "loaded" });
      assert.equal(h.env.sessionSnapshotsRef.current.has("prior-tab"), false);
      assert.equal(h.env.sessionTabs.length, 1);
    }
  }
  const h = navigationHarness();
  h.status({ catalogId: "removed", replaceSessionId: "prior-tab" }, { state: "loaded" });
  assert.equal(h.env.sessionTabs.length, 1, "a stale catalog result cannot close a current tab");
});

test("queued import waits for the target render and runs once under StrictMode with the catalogue format", async () => {
  const h = queueHarness();
  h.effect()();
  assert.equal(h.calls.length, 0);
  assert.equal(h.env.queuedDirectoryOpenRef.current, h.request);
  h.env.activeSessionId = "target-tab";
  const effect = h.effect();
  effect();
  effect();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], [h.request.files, "mat-dat"]);
  assert.deepEqual(h.env.directoryStatuses.recording, { state: "opening" });
  await tick();
  assert.deepEqual(h.env.directoryStatuses.recording, { state: "loaded" });
  assert.equal(h.env.queuedDirectoryOpenRef.current, null);
  assert.equal(h.env.queuedDirectoryOpen, null);
});

test("queued imports report confirmation, interrupted imports, and rejected loads instead of claiming success", async () => {
  for (const options of [{ status: { state: "confirmation" } }, { status: null }, { reject: true }]) {
    const h = queueHarness(options);
    h.env.activeSessionId = "target-tab";
    h.effect()();
    await tick();
    if (options.status?.state === "confirmation") {
      assert.equal(h.env.directoryStatuses.recording.state, "confirmation");
      assert.equal(h.env.directoryConfirmationRef.current, h.request);
    } else {
      assert.equal(h.env.directoryStatuses.recording.state, "error");
      assert.equal(h.env.directoryConfirmationRef.current, null);
    }
  }
});

test("a superseded directory request cannot import into or update the replacement catalogue", async () => {
  const h = queueHarness();
  h.env.activeSessionId = "target-tab";
  h.env.directoryCatalogIdRef.current = "new-catalog";
  h.effect()();
  h.env.updateDirectoryStatus(h.request, { state: "loaded" });
  await tick();
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.env.directoryStatuses, {});
});

const importHelpers = ["SUPPORTED_RECORDING_EXTENSIONS", "SIGNAL_ERROR_CODES", "LEGACY_SEIZURE_EVENT_TERMS",
  "recordingExtension", "validateUploadSelection", "choosePrimaryRecording", "uploadErrorFrom", "portablePathParts", "isLegacySeizureCandidate"];
function importHarness(overrides = {}) {
  const loaded = [];
  const contexts = [];
  const env = {
    importBusyRef: { current: false }, hasRecording: false, primaryFile: null,
    relativeFilePath, mergeSelectedFiles, pendingFilesForSelection, MatDatImportError, resolveMatDatImport, inspectMatRecording,
    measureLocalFileDecode: (_file, _label, callback) => callback(), console: { info() {} },
    prepareSourceImportContext: async (source, primary, files) => { contexts.push({ source, primary, files }); return {}; },
    loadSource: async (source, primary, _interpretation, _context, keepSeparateSession) => {
      loaded.push({ source, primary, keepSeparateSession }); return {};
    },
  };
  for (const [key, value] of Object.entries({ showImport: false, uploadError: null, toast: "", importBusy: false,
    uploadedFileInputs: [], pendingImportFiles: [], pendingDat: null, pendingLegacyMatFile: null, pendingLegacyMeta: null,
    legacyExportHints: null, selectedLegacyEventIndices: new Set(), datMapping: null, datChannelNamesText: "" })) state(env, key, value);
  Object.assign(env, overrides);
  return { env, loaded, contexts, run: (files, expected, keepSeparateSession) => handler("importFiles", env, importHelpers)(files, expected, keepSeparateSession) };
}

test("NeuroTrace directory import routes its archive through the project loader as a separate session", async () => {
  const archive = fileAt("root/project.neurotrace");
  const calls = [];
  const status = { state: "loaded" };
  const h = importHarness({ openNeurotraceProject: async (...args) => { calls.push(args); return status; } });
  assert.equal(await h.run([archive], "neurotrace"), status);
  assert.deepEqual(calls, [[archive, true]]);
  assert.equal(h.loaded.length, 0, "the archive itself never reaches a waveform decoder");
  assert.equal(h.env.importBusyRef.current, false, "project loader owns its own busy guard");
});

test("embedded standalone MAT imports preserve the requested project-session isolation", async () => {
  const h = importHarness();
  const mat = standaloneMatFile();
  assert.deepEqual(await h.run([mat], undefined, true), { state: "loaded" });
  assert.equal(h.loaded[0].primary, mat);
  assert.equal(h.loaded[0].keepSeparateSession, true);
});

test("embedded EDF imports preserve the requested project-session isolation", async () => {
  const edf = fileAt("signal.edf");
  const source = { header: { signals: [] }, events: [], meta: { durationSec: 1 } };
  const h = importHarness({
    EDFSource: { create: async () => source },
    prepareSourceImportContext: async () => ({ companionBundle: { files: [] } }),
  });
  assert.deepEqual(await h.run([edf], undefined, true), { state: "loaded" });
  assert.equal(h.loaded[0].source, source);
  assert.equal(h.loaded[0].keepSeparateSession, true);
});

function projectHarness(overrides = {}) {
  const archive = fileAt("root/review.neurotrace");
  const project = { recordingFile: new File([new Uint8Array(256)], "signal.edf"), supportingFiles: [], customToolFiles: [],
    manifest: { title: "Synthetic review", recording: {} } };
  const calls = { imports: [], applied: [] };
  const entry = { sessionId: "project-tab", files: [archive] };
  const env = {
    importBusyRef: { current: false }, hasRecording: false, rawSourceHash: "synthetic-hash", activeSessionId: "project-tab",
    pendingProjectImportRef: { current: null }, projectFileImportRef: { current: false },
    directorySessionTabsRef: { current: new Map([["project", entry]]) },
    readNeurotraceProjectArchive: async (file) => { assert.equal(file, archive); return project; },
    handleUploadedFiles: async (...args) => { calls.imports.push(args); return { state: "loaded" }; },
    applyImportedProjectState: (value) => calls.applied.push(value),
  };
  for (const [key, value] of Object.entries({ importBusy: false, uploadError: null, toast: "", showImport: true })) state(env, key, value);
  Object.assign(env, overrides);
  return { env, project, archive, entry, calls, open: (separate = true) => handler("openNeurotraceProject", env)(archive, separate) };
}

test("project directory loading scopes embedded files to their archive and restores state only after load succeeds", async () => {
  const h = projectHarness();
  h.project.supportingFiles.push(fileAt("signal_events.tsv"));
  assert.deepEqual(await h.open(), { state: "loaded" });
  assert.equal(h.project.recordingFile.webkitRelativePath, "root/review.neurotrace/signal.edf");
  assert.deepEqual(h.entry.files, [h.archive, h.project.recordingFile], "reopen can recognize the embedded source");
  assert.deepEqual(h.calls.imports, [[[h.project.recordingFile, ...h.project.supportingFiles], true]]);
  assert.deepEqual(h.calls.applied, [h.project]);
  assert.equal(h.env.pendingProjectImportRef.current, null);
  assert.equal(h.env.projectFileImportRef.current, false);
  assert.equal(h.env.importBusyRef.current, false);
  assert.equal(h.env.showImport, false);
});

test("project directory loading preserves pending DAT confirmation without applying review state too soon", async () => {
  const status = { state: "confirmation" };
  const h = projectHarness({ handleUploadedFiles: async () => status });
  h.project.recordingFile = new File([new Uint8Array(256)], "signal.dat");
  assert.equal(await h.open(), status);
  assert.equal(h.env.pendingProjectImportRef.current, h.project);
  assert.deepEqual(h.calls.applied, []);
  assert.equal(h.env.projectFileImportRef.current, false);
});

test("a folder project cannot attach a reference-only review onto another open recording", async () => {
  const h = projectHarness({ hasRecording: true });
  h.project.recordingFile = null;
  const result = await h.open();
  assert.equal(result.state, "error");
  assert.match(result.message, /original recording/i);
  assert.deepEqual(h.calls.imports, []);
  assert.deepEqual(h.calls.applied, []);
  assert.equal(h.env.uploadError.title, "Recording was not included");
});

test("ordinary reference-only projects can still restore onto their matching open recording", async () => {
  const h = projectHarness({ hasRecording: true });
  h.project.recordingFile = null;
  h.project.manifest.recording.sourceContentSha256 = "synthetic-hash";
  assert.deepEqual(await h.open(false), { state: "loaded" });
  assert.deepEqual(h.calls.applied, [h.project]);
  assert.equal(h.env.showImport, false);
});

test("unreadable project archives return actionable errors and release the import guard", async () => {
  const h = projectHarness({ readNeurotraceProjectArchive: async () => { throw new Error("Synthetic archive corruption"); } });
  assert.deepEqual(await h.open(), { state: "error", message: "Synthetic archive corruption" });
  assert.match(h.env.uploadError.title, /could not be opened/i);
  assert.equal(h.env.importBusyRef.current, false);
  assert.equal(h.env.importBusy, false);
  assert.deepEqual(h.calls.applied, []);
});

test("failed embedded recording loads propagate status and clear pending review state", async () => {
  for (const status of [{ state: "error", message: "Synthetic decode failure" }, undefined]) {
    const h = projectHarness({ handleUploadedFiles: async () => status });
    const result = await h.open();
    assert.equal(result.state, "error");
    if (status) assert.equal(result, status);
    assert.equal(h.env.pendingProjectImportRef.current, null);
    assert.equal(h.env.projectFileImportRef.current, false);
    assert.deepEqual(h.calls.applied, []);
  }
});

test("unexpected embedded recording failures clear pending project state and remain actionable", async () => {
  const h = projectHarness({ handleUploadedFiles: async () => { throw new Error("Unexpected synthetic import failure"); } });
  assert.deepEqual(await h.open(), { state: "error", message: "Unexpected synthetic import failure" });
  assert.equal(h.env.pendingProjectImportRef.current, null);
  assert.equal(h.env.projectFileImportRef.current, false);
  assert.equal(h.env.importBusyRef.current, false);
  assert.equal(h.env.showImport, true);
  assert.equal(h.env.uploadError.message, "Unexpected synthetic import failure");
  assert.deepEqual(h.env.uploadError.files, [h.archive.name]);
  assert.deepEqual(h.calls.applied, []);
});

test("failed project review restoration is reported even if its embedded recording loaded", async () => {
  const h = projectHarness({ applyImportedProjectState: () => { throw new Error("Synthetic state failure"); } });
  assert.deepEqual(await h.open(), { state: "error", message: "Synthetic state failure" });
  assert.equal(h.env.pendingProjectImportRef.current, null);
  assert.equal(h.env.showImport, true);
  assert.match(h.env.uploadError.title, /warnings/i);
});

test("project loading refuses competing work while another import is busy", async () => {
  const h = projectHarness({ importBusyRef: { current: true },
    readNeurotraceProjectArchive: () => assert.fail("busy imports must not start archive reads") });
  assert.equal(await h.open(), undefined);
});

test("uploaded-file routing forwards project isolation and returns the actual load or confirmation status", async () => {
  for (const extension of ["edf", "neurotrace"]) {
    const file = fileAt(`signal.${extension}`);
    const status = { state: "confirmation" };
    const calls = [];
    const env = {
      importBusyRef: { current: false }, directoryConfirmationRef: { current: {} },
      projectFileImportRef: { current: false }, pendingProjectImportRef: { current: {} },
      importCustomToolFiles: async (files) => ({ assets: [], remainingFiles: files, errors: [] }),
      importFiles: async (...args) => { calls.push(args); return status; },
      openNeurotraceProject: async (...args) => { calls.push(args); return status; },
    };
    state(env, "importBusy", false);
    const result = await handler("handleUploadedFiles", env, ["SUPPORTED_RECORDING_EXTENSIONS", "recordingExtension"])([file], true);
    assert.equal(result, status);
    assert.deepEqual(calls, extension === "neurotrace" ? [[file, true]] : [[[file], undefined, true]]);
    assert.equal(env.directoryConfirmationRef.current, null);
  }
});

test("custom-tool parsing holds the busy guard until the recording importer takes over", async () => {
  const file = fileAt("signal.edf");
  const status = { state: "loaded" };
  let finish;
  let parseCalls = 0;
  let imports = 0;
  const env = {
    importBusyRef: { current: false }, directoryConfirmationRef: { current: {} },
    projectFileImportRef: { current: false }, pendingProjectImportRef: { current: null },
    importCustomToolFiles: async () => {
      parseCalls += 1;
      assert.equal(env.importBusyRef.current, true);
      assert.equal(env.importBusy, true);
      return new Promise((resolve) => { finish = resolve; });
    },
    importFiles: async (...args) => {
      imports += 1;
      assert.equal(env.importBusyRef.current, false, "the importer can acquire its own guard");
      assert.equal(env.importBusy, false);
      assert.deepEqual(args, [[file], undefined, true]);
      return status;
    },
  };
  state(env, "importBusy", false);
  const upload = handler("handleUploadedFiles", env, ["SUPPORTED_RECORDING_EXTENSIONS", "recordingExtension"]);
  const pending = upload([file], true);
  assert.equal(env.importBusyRef.current, true);
  assert.equal(await upload([file], true), undefined, "a second selection cannot race asynchronous parsing");
  assert.equal(parseCalls, 1);
  assert.equal(imports, 0);
  finish({ assets: [], remainingFiles: [file], errors: [] });
  assert.equal(await pending, status);
  assert.equal(imports, 1);
});

test("custom-tool parser rejection releases the busy guard", async () => {
  const env = {
    importBusyRef: { current: false }, directoryConfirmationRef: { current: null },
    projectFileImportRef: { current: false }, pendingProjectImportRef: { current: null },
    importCustomToolFiles: async () => { throw new Error("Synthetic parser failure"); },
    importFiles: () => assert.fail("failed parsing must not start a recording import"),
  };
  state(env, "importBusy", false);
  await assert.rejects(handler("handleUploadedFiles", env, ["SUPPORTED_RECORDING_EXTENSIONS", "recordingExtension"])([fileAt("signal.edf")]), /Synthetic parser failure/);
  assert.equal(env.importBusyRef.current, false);
  assert.equal(env.importBusy, false);
});

test("pending embedded-project restores cannot redirect to a duplicate recording tab", () => {
  const matching = { hasRecording: true, sourceHash: "same-waveform" };
  const env = {
    keepSeparateSession: false, pendingProjectImportRef: { current: null },
    sessionSnapshotsRef: { current: new Map([["other-tab", matching]]) },
    targetSessionId: "selected-tab", interpretationHash: "same-waveform",
  };
  const duplicate = () => executable(declaration("duplicateEntry"), "duplicateEntry", env);
  assert.deepEqual(duplicate(), ["other-tab", matching], "ordinary file opening still reuses matching tabs");
  env.pendingProjectImportRef.current = { manifest: { title: "Saved review" } };
  assert.equal(duplicate(), false, "embedded data must finish loading before applying the saved review");
  env.pendingProjectImportRef.current = null;
  env.keepSeparateSession = true;
  assert.equal(duplicate(), false, "separate folder sessions still bypass duplicate reuse");
});

test("directory MAT+DAT checks actual MAT contents before installing a standalone MAT or prompting raw DAT mapping", async () => {
  const standalone = standaloneMatFile({ name: "synthetic.mat" });
  const dat = fileAt("synthetic.dat");
  for (const mat of [standalone, fileAt("synthetic.mat")]) {
    const h = importHarness();
    const result = await h.run([mat, dat], "mat-dat");
    assert.equal(result.state, "error");
    assert.equal(h.env.uploadError.title, "Directory format mismatch");
    assert.equal(h.loaded.length, 0);
    assert.equal(h.contexts.length, 0);
    assert.equal(h.env.pendingDat, null);
    assert.equal(h.env.importBusyRef.current, false);
  }
});

test("directory content mismatch disposes a rejected standalone decoder", async () => {
  const mat = standaloneMatFile({ name: "synthetic.mat" });
  const dat = fileAt("synthetic.dat");
  let disposed = 0;
  const h = importHarness({ resolveMatDatImport: async () => ({ kind: "standalone-mat", file: mat,
    source: { dispose: () => { disposed += 1; } }, diagnostics: { format: "standalone-mat" } }) });
  assert.equal((await h.run([mat, dat], "mat-dat")).state, "error");
  assert.equal(disposed, 1);
  assert.equal(h.loaded.length, 0);
});

test("MAT-only directory cannot borrow a previously staged DAT to bypass format enforcement", async () => {
  const mat = legacyMatFile({ name: "synthetic.mat" });
  const dat = fileAt("synthetic.dat");
  const h = importHarness({ pendingImportFiles: [dat], uploadedFileInputs: [dat] });
  const result = await h.run([mat], "mat");
  assert.equal(result.state, "error");
  assert.equal(h.env.uploadError.title, "Legacy MAT needs its DAT file");
  assert.equal(h.env.pendingDat, null);
  assert.equal(h.loaded.length, 0);
});

test("MAT-only content guard rejects a legacy pair before mapping or source installation", async () => {
  const h = importHarness();
  const result = await h.run([legacyMatFile(), fileAt("synthetic.dat")], "mat");
  assert.equal(result.state, "error");
  assert.equal(h.env.uploadError.title, "Directory format mismatch");
  assert.equal(h.env.pendingDat, null);
  assert.equal(h.loaded.length, 0);
});

test("matching standalone MAT directory import opens the decoded signal without staged-file contamination", async () => {
  const mat = standaloneMatFile();
  const stale = fileAt("unrelated.dat");
  const h = importHarness({ uploadedFileInputs: [stale], pendingImportFiles: [stale] });
  assert.deepEqual(await h.run([mat], "mat"), { state: "loaded" });
  assert.equal(h.loaded.length, 1);
  assert.equal(h.loaded[0].primary, mat);
  assert.equal(h.loaded[0].keepSeparateSession, true, "do not merge directory sessions with identical waveform hashes");
  assert.deepEqual(h.contexts[0].files, [mat]);
  assert.deepEqual((await h.loaded[0].source.getWindow(0, 1)).data.map((values) => [...values]), [[1, 2, 3, 4], [10, 20, 30, 40]]);
});

test("matching legacy directory pair retains metadata and requires mapping confirmation, without loading the DAT", async () => {
  const mat = legacyMatFile({ sampleRate: 250, channelCount: 2, labels: ["SYN2", "SYN1"] });
  const dat = unreadableFile("synthetic.dat");
  const h = importHarness();
  assert.deepEqual(await h.run([mat, dat], "mat-dat"), { state: "confirmation" });
  assert.equal(h.env.pendingDat, dat);
  assert.equal(h.env.pendingLegacyMatFile, mat);
  assert.deepEqual(h.env.datMapping, { sampleRate: 250, channelCount: 2, physicalScale: "" });
  assert.equal(h.env.datChannelNamesText, "SYN2\nSYN1");
  assert.equal(h.loaded.length, 0);
});

test("format-constrained imports reject EDF/MAT family mismatches before decoding", async () => {
  for (const [files, format] of [[[fileAt("wrong.edf")], "mat"], [[standaloneMatFile()], "edf"]]) {
    const h = importHarness({ resolveMatDatImport: () => assert.fail("must reject before MAT decode"),
      EDFSource: { create: () => assert.fail("must reject before EDF decode") } });
    const result = await h.run(files, format);
    assert.equal(result.state, "error");
    assert.equal(h.env.uploadError.title, "Directory format mismatch");
    assert.equal(h.loaded.length, 0);
  }
});

test("EDF directory entry uses its own files, existing EDF loader, and an independent session identity", async () => {
  const edf = fileAt("root/session1.edf");
  const companion = fileAt("root/session1_events.tsv");
  const calls = [];
  const source = { header: { signals: [] }, events: [], meta: { durationSec: 1 } };
  const h = importHarness({ uploadedFileInputs: [fileAt("stale.edf")],
    EDFSource: { create: async (...args) => { calls.push(args); return source; } },
    prepareSourceImportContext: async (_source, primary, files) => {
      assert.equal(primary, edf);
      assert.deepEqual(new Set(files), new Set([edf, companion]));
      return { companionBundle: { files: [] } };
    },
  });
  assert.deepEqual(await h.run([edf, companion], "edf"), { state: "loaded" });
  assert.deepEqual(calls, [[edf, { parseAnnotations: false }]]);
  assert.equal(h.loaded[0].source, source);
  assert.equal(h.loaded[0].keepSeparateSession, true);
});

test("directory path remains in recovery identity while ordinary imports retain their existing identity", () => {
  const load = declarations.get("loadSource").initializer.arguments[0];
  const pathGuard = load.body.statements.find((statement) => ts.isIfStatement(statement)
    && statement.expression.getText(syntax) === "keepSeparateSession");
  assert.ok(pathGuard, "loadSource must scope directory recovery before loading a source");
  const identity = handler("sourceIdentityInterpretation", {});
  const scoped = (file, keepSeparateSession) => executable(
    `let interpretation = initial; ${pathGuard.getText(syntax)}`,
    "interpretation",
    { file, keepSeparateSession, relativeFilePath, initial: { kind: "raw-int16-le", sample_rate_hz: 250, patient_id_hint: "synthetic" } },
  );
  const first = identity(scoped(fileAt("root/session1/trace.dat"), true));
  const second = identity(scoped(fileAt("root/session2/trace.dat"), true));
  assert.equal(first.directory_session_path, "root/session1/trace.dat");
  assert.equal(first.patient_id_hint, undefined, "unrelated export-only fields remain excluded");
  assert.notDeepEqual(first, second, "identical samples in distinct session paths cannot share recovery identity");
  assert.deepEqual(first, identity(scoped(fileAt("root/session1/trace.dat"), true)), "reselecting a folder restores stable identity");
  const ordinary = identity(scoped(fileAt("root/session1/trace.dat"), false));
  assert.equal(ordinary.directory_session_path, undefined);
  assert.deepEqual(ordinary, { kind: "raw-int16-le", sample_rate_hz: 250 });
});

test("ordinary imports retain standalone precedence and manually mapped raw-DAT support", async () => {
  const mat = standaloneMatFile({ name: "synthetic.mat" });
  const dat = fileAt("synthetic.dat");
  const standalone = importHarness();
  assert.equal((await standalone.run([mat, dat])).state, "loaded");
  assert.equal(standalone.loaded[0].primary, mat);
  assert.equal(standalone.loaded[0].keepSeparateSession, false, "ordinary imports retain duplicate-session behavior");
  const raw = importHarness();
  assert.equal((await raw.run([dat])).state, "confirmation");
  assert.equal(raw.env.pendingDat, dat);
  assert.equal(raw.env.pendingLegacyMeta, null);
});

test("ordinary staged MAT+DAT imports continue to reuse their matching companion", async () => {
  const mat = legacyMatFile();
  const dat = fileAt("synthetic.dat");
  const h = importHarness({ pendingImportFiles: [mat], uploadedFileInputs: [mat] });
  assert.equal((await h.run([dat])).state, "confirmation");
  assert.equal(h.env.pendingLegacyMatFile, mat);
  assert.equal(h.env.pendingDat, dat);
});

test("confirmed DAT mapping updates its directory status only after a successful source load", async () => {
  const request = { catalogId: "catalog", recordingId: "recording" };
  const statuses = [];
  const env = {
    pendingDat: fileAt("synthetic.dat", new Int16Array([1, 2, 3, 4])), importBusyRef: { current: false },
    directoryConfirmationRef: { current: request }, pendingProjectImportRef: { current: null },
    datChannelNames: { error: null, labels: ["SYN1", "SYN2"] }, datMapping: { sampleRate: 2, channelCount: 2, physicalScale: "" },
    datPhysicalScaleValid: true, pendingLegacyMatFile: null, pendingLegacyMeta: null, pendingImportFiles: [],
    legacyExportHints: { patientId: "", matPath: "", dataDirectory: "", datFile: "" }, RawDatSource,
    prepareSourceImportContext: async () => ({}),
    loadSource: async (source, _file, _interpretation, _context, keepSeparateSession) => {
      assert.equal(statuses.length, 0);
      assert.equal(source.meta.channelCount, 2);
      assert.equal(keepSeparateSession, true, "MAT+DAT directory sessions cannot collapse into a different folder's review");
      return {};
    },
    updateDirectoryStatus: (...args) => statuses.push(args),
  };
  for (const [key, value] of Object.entries({ uploadError: null, importBusy: false, pendingDat: env.pendingDat,
    pendingLegacyMatFile: null, pendingLegacyMeta: null, pendingImportFiles: [], selectedLegacyEventIndices: new Set(), legacyExportHints: env.legacyExportHints })) state(env, key, value);
  await handler("confirmDatImport", env, ["portablePathParts"])();
  assert.deepEqual(statuses, [[request, { state: "loaded" }]]);
  assert.equal(env.directoryConfirmationRef.current, null);
  assert.equal(env.pendingDat, null);
  assert.equal(env.importBusyRef.current, false);
});
