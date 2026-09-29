/** Execute the page's real handlers/effect with patient-free files and state spies. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { inspectMatRecording, RawDatSource } from "../app/eeg-core.ts";
import { mergeSelectedFiles, relativeFilePath } from "../app/bids-companions.ts";
import { DirectoryImportError, directoryRecordingFiles, planDirectoryImport } from "../app/directory-import.ts";
import { classifyRecordingSelection } from "../app/import-selection.ts";
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
  const h = stageHarness();
  state(h.env, "importBusy", false);
  const transfer = {};
  const files = [unreadableFile("root/source.edf")];
  let finish;
  const routed = [];
  h.env.collectDroppedRecordingFiles = (value) => {
    assert.equal(value, transfer);
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
  const pending = drop(transfer);
  await drop({ competingDrop: true });
  assert.deepEqual(routed, []);
  finish({ files, directory: true });
  await pending;
  assert.deepEqual(routed, [[files, true]]);
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
  const env = {
    // A later MAT picker can be cancelled while this EDF collection stays ready.
    guidedImportReady: true, importChoice: "mat", stagedDirectoryPlan: plan,
    importBusyRef: { current: false },
    directoryCatalogIdRef: { current: "old" }, directorySessionTabsRef: { current: tabs },
    directoryConfirmationRef: { current: { stale: true } }, makeId: () => "new-directory",
    handleUploadedFiles: () => assert.fail("cataloguing must not import any recording"),
  };
  for (const [key, value] of Object.entries({ directoryStatuses: { stale: true }, directoryCatalog: null,
    showImport: true, showDirectorySessions: false, toast: "", stagedDirectoryPlan: plan })) state(env, key, value);
  await handler("submitGuidedImport", env)();
  assert.equal(env.directoryCatalog.plan, plan);
  assert.equal(env.directoryCatalog.id, "new-directory");
  assert.equal(env.directoryCatalogIdRef.current, "new-directory");
  assert.equal(tabs.size, 0);
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
  state(env, "showDirectorySessions", true);
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
  h.env.directorySessionTabsRef.current.set(h.plan.recordings[0].id, { sessionId: "loaded-tab" });
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
    useCallback: (callback) => callback,
    directoryImportRunnerRef: { current: async (...args) => { calls.push(args); if (reject) throw new Error("synthetic failure"); return status; } },
  };
  state(env, "directoryStatuses", {});
  env.setQueuedDirectoryOpen = (value) => { env.queuedDirectoryOpen = value; };
  env.updateDirectoryStatus = handler("updateDirectoryStatus", env);
  return { env, request, calls, effect: () => executable(`const effect = ${queueEffect};`, "effect", env) };
}

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
  return { env, loaded, contexts, run: (files, expected) => handler("importFiles", env, importHelpers)(files, expected) };
}

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
