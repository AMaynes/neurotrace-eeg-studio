import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("https://neurotrace.test/", { headers: { accept: "text/html", host: "neurotrace.test" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the NeuroTrace clinical EEG workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>NeuroTrace — Clinical EEG Studio<\/title>/i);
  assert.match(html, /NEUROTRACE/);
  assert.match(html, /Clinical EEG Studio/);
  assert.match(html, /Context palette/);
  assert.match(html, /Entire-session context/);
  assert.match(html, /Window context/);
  assert.match(html, /Label palette/);
  assert.match(html, /GPDs/);
  assert.match(html, /LPDs/);
  assert.match(html, /BIPDs/);
  assert.match(html, /GRDA/);
  assert.match(html, /LRDA/);
  assert.match(html, /N1 sleep/);
  assert.match(html, /N2 sleep/);
  assert.match(html, /N3 sleep/);
  assert.match(html, /REM sleep/);
  assert.match(html, /Load a recording to begin/);
  assert.match(html, /Open Settings/);
  assert.match(html, /og\.png/);
  assert.doesNotMatch(html, /Mark seizure|PHI stays here|Source \/ reliability|IIIC pattern|Ictal seizure|NREM sleep/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("ships product source without starter preview artifacts", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(page, /EDFSource/);
  assert.match(page, /MatSource/);
  assert.match(page, /createStoredZip/);
  assert.match(page, /aria-label="Delete annotation"/);
  assert.match(page, /aria-label="Close Settings"/);
  assert.match(page, /data-track-id=/);
  assert.match(page, /Windowed Labels/);
  assert.match(page, /Instance Labels/);
  assert.match(page, /context-resize-handle/);
  assert.match(page, /wave-cursor pinned/);
  assert.match(page, /Converted to a windowed duration label/);
  assert.match(page, /Context palette/);
  assert.match(page, /Entire-session context/);
  assert.match(page, /Window context/);
  assert.match(page, /candidate_events\.tsv/);
  assert.match(page, /source_content_sha256/);
  assert.match(page, /entire_session_context/);
  assert.match(page, /timed_context/);
  assert.match(page, /sha256Blob/);
  assert.match(page, /status === "committed"/);
  assert.doesNotMatch(page, /fileFingerprint/);
  assert.doesNotMatch(page, /> Cursor<\/button>|> Select<\/button>|Manage ontology/);
  assert.doesNotMatch(page, /Source \/ reliability|Candidate queue|Event labels/);
  assert.match(layout, /NeuroTrace — Clinical EEG Studio/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await access(new URL("../public/og.png", import.meta.url));
  await access(new URL(".openai/hosting.json", root));
});

test("keeps context and model-label palettes visually and semantically separate", async () => {
  const response = await render();
  const html = await response.text();
  const contextPosition = html.indexOf("Context palette");
  const labelPosition = html.indexOf("Label palette");

  assert.ok(contextPosition >= 0, "context palette is rendered");
  assert.ok(labelPosition > contextPosition, "context palette is above the label palette");
  assert.match(html, /context-palette-section/);
  assert.match(html, /context-palette-group/);
  assert.match(html, /label-palette-section/);
  assert.match(html, /Entire-session context/);
  assert.match(html, /Window context/);
});

test("ships a load-first state and accessible workspace dialogs", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const sourceHas = (pattern, message) => assert.ok(pattern.test(page), message);

  // The demo session may remain server-rendered, but production loading must
  // have an explicit conditional empty state instead of a synthetic fallback.
  const emptyStart = page.indexOf('className="recording-empty-state"');
  const emptyEnd = page.indexOf("</button>", emptyStart);
  assert.ok(emptyStart >= 0 && emptyEnd > emptyStart, "a dedicated empty-recording surface is shipped");
  const emptyState = page.slice(emptyStart, emptyEnd);
  assert.match(emptyState, /Load (?:(?:a|an EEG) )?recording to begin/i, "the empty state has a direct load action");
  assert.match(emptyState, /EDF[\s\S]*MAT/i, "the empty state identifies supported EEG formats");

  sourceHas(/aria-label="Add channels"/, "CH+ has an accessible action name");
  sourceHas(/>\s*CH\+\s*<\/button>/, "the compact channel action is visible as CH+");
  sourceHas(/aria-label="(?:Open )?Help"/, "Help trigger has an accessible name");
  sourceHas(/aria-label="(?:Open )?Settings"/, "Settings trigger has an accessible name");

  // Closed dialogs do not appear in the initial SSR response, so their
  // accessibility contract is verified directly in the conditional JSX.
  sourceHas(/aria-label="Channel controls"/, "channel dialog is named");
  sourceHas(/aria-label="Help"/, "Help dialog is named");
  sourceHas(/aria-label="Settings"/, "Settings dialog is named");
  sourceHas(/aria-modal="true"/, "workspace dialogs are exposed as modal");
});

test("keeps requested signal tools in the primary toolbar without legacy clutter", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const toolbarStart = page.indexOf('<div className="viewer-toolbar">');
  const toolbarEnd = page.indexOf('<div className="overview-block">', toolbarStart);
  assert.ok(toolbarStart >= 0 && toolbarEnd > toolbarStart, "primary viewer toolbar is present");

  const toolbar = page.slice(toolbarStart, toolbarEnd);
  for (const control of ["Spectrum", "Montage", "Filters", "Window", "Gain"]) {
    assert.match(toolbar, new RegExp(control, "i"), `${control} remains accessible from the primary toolbar`);
  }
  assert.doesNotMatch(toolbar, />\s*(?:Cursor|Select)\s*</i);
  assert.doesNotMatch(toolbar, /Mark seizure|Manage ontology/i);
  assert.match(page, /className="channel-manager-button"[\s\S]{0,160}>CH\+<\/button>/, "CH+ is in the recording rail");

  const headerStart = page.indexOf('<header className="topbar">');
  const headerEnd = page.indexOf("</header>", headerStart);
  const header = page.slice(headerStart, headerEnd);
  assert.match(header, /Open Help/);
  assert.match(header, /Open Settings/);
  assert.match(header, /session-tab-strip/);

  const commandStart = page.indexOf('<footer className="command-strip">');
  const commandEnd = page.indexOf("</footer>", commandStart);
  assert.ok(commandStart >= 0 && commandEnd > commandStart, "status strip is present");
  const commandStrip = page.slice(commandStart, commandEnd);
  assert.doesNotMatch(commandStrip, /className="strip-actions"/);
  assert.doesNotMatch(commandStrip, />\s*(?:Spectrum|Controls|Settings|Help)\s*</i);
});

test("resolves palette clicks from session, selection, or pinned-cursor context", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const resolverStart = page.indexOf("const placePaletteLabel");
  const resolverEnd = page.indexOf("const updateAnnotation", resolverStart);
  assert.ok(resolverStart >= 0 && resolverEnd > resolverStart, "palette placement resolver is present");

  const resolver = page.slice(resolverStart, resolverEnd);
  assert.match(resolver, /label\.geometry\s*!==\s*"session"/);
  assert.match(resolver, /cursorLocked/);
  assert.match(resolver, /selection\?\.start\s*\?\?\s*cursorTime/);
  assert.match(resolver, /selection\?\.end/);
  assert.match(resolver, /label\.category\s*===\s*"Context"[\s\S]*?"native"/);
  assert.match(resolver, /selection[\s\S]*?\?\s*"windowed"[\s\S]*?:\s*"instance"/);
  assert.match(resolver, /addAnnotation\(label,\s*selection\?\.start\s*\?\?\s*cursorTime,\s*selection\?\.end,\s*intent\)/);

  const addStart = page.indexOf("const addAnnotation");
  const addEnd = page.indexOf("const placePaletteLabel", addStart);
  const addAnnotation = page.slice(addStart, addEnd);
  assert.match(addAnnotation, /intent\s*===\s*"instance"\s*\?\s*"point"/);
  assert.match(addAnnotation, /intent\s*===\s*"windowed"\s*\?\s*"interval"/);
  assert.match(addAnnotation, /intent\s*===\s*"instance"\s*\?\s*"instance"/);
  assert.match(addAnnotation, /intent\s*===\s*"windowed"\s*\?\s*"windowed"/);

  const paletteClickBindings = page.match(/onClick=\{\(\) => placePaletteLabel\(label\)\}/g) ?? [];
  assert.ok(paletteClickBindings.length >= 2, "both context and label palettes use the same placement resolver");

  const dropStart = page.indexOf("const onLabelDrop");
  const dropEnd = page.indexOf("const onLabelDragOver", dropStart);
  const drop = page.slice(dropStart, dropEnd);
  assert.match(drop, /selection\s*\?\s*"windowed"\s*:\s*"instance"/);
  assert.match(drop, /selection\?\.start\s*\?\?\s*time/);
  assert.match(drop, /selection\?\.end/);

  const pointerUpStart = page.indexOf("const onWavePointerUp");
  const pointerUpEnd = page.indexOf("const onLabelDrop", pointerUpStart);
  assert.match(page.slice(pointerUpStart, pointerUpEnd), /pointer\.moved\s*&&\s*Math\.abs\(time - pointer\.startTime\)\s*>\s*0/);
});

test("renders accessible session tabs and isolates each session workspace", async () => {
  const response = await render();
  const html = await response.text();
  assert.match(html, /role="tablist"[^>]*aria-label="EEG sessions"/);
  assert.match(html, /role="tab"[^>]*aria-selected="true"/);
  assert.match(html, /aria-label="Add blank session"/);
  assert.match(html, /Load a recording to begin/);
  assert.doesNotMatch(html, /P-1027|UNM_EMU/);

  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const storeStart = page.indexOf("const storeActiveSession");
  const storeEnd = page.indexOf("const applySessionSnapshot", storeStart);
  const store = page.slice(storeStart, storeEnd);
  assert.match(store, /sessionSnapshotsRef\.current\.set\(activeSessionId/);
  for (const state of ["hasRecording", "source", "annotations", "candidates", "selectedChannels", "badChannels", "viewStart", "timebase", "undo", "redo"]) {
    assert.match(store, new RegExp(`\\b${state}\\b`), `${state} is retained per session`);
  }

  const switchStart = page.indexOf("const switchSession");
  const switchEnd = page.indexOf("const createBlankSession", switchStart);
  const switchSession = page.slice(switchStart, switchEnd);
  assert.ok(
    switchSession.indexOf("storeActiveSession()") < switchSession.indexOf("applySessionSnapshot(snapshot)"),
    "the outgoing workspace is saved before the target workspace is restored",
  );

  const blankStart = page.indexOf("const createBlankSession");
  const blankEnd = page.indexOf("const setViewStartSafe", blankStart);
  const blank = page.slice(blankStart, blankEnd);
  assert.match(blank, /hasRecording:\s*false/);
  assert.match(blank, /annotations:\s*\[\]/);
  assert.match(blank, /candidates:\s*\[\]/);
  assert.match(blank, /selectedChannels:\s*\[\]/);
  assert.match(blank, /cursorLocked:\s*false/);
  assert.match(blank, /sessionSnapshotsRef\.current\.set\(id,\s*snapshot\)/);
  assert.match(blank, /setSessionTabs\(\(current\)\s*=>\s*\[\.\.\.current/);

  const loadStart = page.indexOf("const loadSource");
  const loadEnd = page.indexOf("const confirmDatImport", loadStart);
  const load = page.slice(loadStart, loadEnd);
  assert.match(load, /setHasRecording\(true\)/);
  assert.match(load, /const targetSessionId\s*=\s*activeSessionId/);
  assert.match(load, /tab\.id\s*===\s*targetSessionId/);
  assert.match(load, /title:\s*shortFileName/);
  assert.ok(load.indexOf("await sha256Blob(file") < load.indexOf("sourceRef.current = source"), "source identity is verified before the active source changes");
  assert.match(load, /activeSessionIdRef\.current\s*!==\s*targetSessionId/);
  assert.match(load, /duplicateEntry[\s\S]*?applySessionSnapshot\(duplicateSnapshot\)[\s\S]*?return false/);

  const closeStart = page.indexOf("const closeSession");
  const closeEnd = page.indexOf("const updateControlBinding", closeStart);
  const close = page.slice(closeStart, closeEnd);
  assert.match(close, /storeActiveSession\(\)/);
  assert.match(close, /recoveryStatus\s*===\s*"error"/);
  assert.match(close, /export it before closing/i);
  assert.match(page, /className="session-tab-close"/);
  assert.match(page, /window\.addEventListener\("pagehide",\s*flush\)/);

  const importStart = page.indexOf("const importFiles");
  const importEnd = page.indexOf("const confirmDatImport", importStart);
  assert.match(page.slice(importStart, importEnd), /importBusyRef\.current/);
  assert.match(page, /!importBusyRef\.current\s*&&\s*event\.dataTransfer\.files\.length/);
});

test("wires channel, Help, and Settings dialogs to operable controls", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  const channelsStart = page.indexOf("{showChannels &&");
  const channelsEnd = page.indexOf("{showHelp &&", channelsStart);
  const channels = page.slice(channelsStart, channelsEnd);
  assert.match(channels, /role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Channel controls"/);
  assert.match(channels, /aria-label="Close channel controls"/);
  assert.match(channels, /setShowChannels\(false\)/);
  assert.match(channels, /aria-label="Search detected channels"/);
  assert.match(channels, />Enable all<\/button>/);
  assert.match(channels, />Disable all<\/button>/);
  assert.match(channels, /checked=\{selectedChannels\.has\(index\)\}/);
  assert.match(channels, /if\s*\(next\.has\(index\)\)\s*next\.delete\(index\)/);
  assert.match(channels, /setBadChannels/);
  assert.match(channels, /source channel \{index \+ 1\}/);
  assert.match(channels, /original channel provenance/i);

  const helpStart = page.indexOf("{showHelp &&");
  const helpEnd = page.indexOf("{showSettings &&", helpStart);
  const help = page.slice(helpStart, helpEnd);
  assert.match(help, /role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Help"/);
  assert.match(help, /aria-label="Close Help"/);
  assert.match(help, /Session tabs/);
  assert.match(help, /Waveform labeling/);
  assert.match(help, /CH\+ channel manager/);

  const settingsStart = page.indexOf("{showSettings &&");
  const settingsEnd = page.indexOf("{showSessionMap &&", settingsStart);
  const settings = page.slice(settingsStart, settingsEnd);
  assert.match(settings, /role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Settings"/);
  assert.match(settings, /aria-label="Close Settings"/);
  assert.match(settings, /Restore defaults/);
  assert.match(settings, /controlBindings\[row\.key\]/);
  assert.match(settings, /setControlBindings/);
  assert.match(settings, /updateControlBinding/);
  assert.match(settings, /swaps the two actions/);
  assert.match(settings, /Label snapping/);

  const keyboardStart = page.indexOf("const modalOpen");
  const keyboardEnd = page.indexOf('window.addEventListener("keydown"', keyboardStart);
  const keyboard = page.slice(keyboardStart, keyboardEnd);
  for (const dialog of ["showHelp", "showSettings", "showChannels"]) {
    assert.match(keyboard, new RegExp(`\\b${dialog}\\b`), `${dialog} participates in Escape handling`);
  }
  assert.match(keyboard, /event\.key\s*===\s*"Escape"/);
  assert.match(page, /setAttribute\("inert"/);
  assert.match(page, /event\.key\s*!==\s*"Tab"/);
  assert.match(page, /modalOpen\s*&&\s*zoomModifier/);
});
