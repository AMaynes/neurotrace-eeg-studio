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
  assert.match(html, /Clinical Observation/);
  assert.match(html, /Medication/);
  assert.match(html, />Other</);
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
  assert.match(page, /ePhys Window Labels/);
  assert.match(page, /ePhys Instance Labels/);
  assert.match(page, /context-resize-handle/);
  assert.match(page, /wave-cursor pinned/);
  assert.match(page, /Converted to a windowed duration label/);
  assert.match(page, /Context palette/);
  assert.match(page, /Entire-session context/);
  assert.match(page, /Clinical Observation/);
  assert.match(page, /Medication/);
  assert.match(page, /name:\s*"Other"/);
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
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const sidebarStart = page.indexOf('<aside className="right-sidebar">');
  const sidebarEnd = page.indexOf("</aside>", sidebarStart);
  const sidebar = page.slice(sidebarStart, sidebarEnd);
  const contextPosition = sidebar.indexOf("Context palette");
  const labelPosition = sidebar.indexOf("Label palette");

  assert.ok(contextPosition >= 0, "context palette is rendered");
  assert.ok(labelPosition > contextPosition, "context palette is above the label palette");
  assert.match(sidebar, /compact-context-palette/);
  assert.match(sidebar, /rightContextLabels\.map/);
  assert.match(sidebar, /compact-ephys-palette/);
  assert.doesNotMatch(sidebar, /entireSessionContexts|Window context|Entire-session context/);

  const rightContextDefinition = page.match(/const rightContextLabels = \[([^\]]+)\]/)?.[1] ?? "";
  assert.match(rightContextDefinition, /"clinical"/);
  assert.match(rightContextDefinition, /"medication"/);
  assert.match(rightContextDefinition, /"note"/);
  assert.equal((rightContextDefinition.match(/"/g) ?? []).length, 6, "the right context palette has exactly three label ids");
  assert.doesNotMatch(page, /id:\s*"button"|id:\s*"asm"/, "unrequested context definitions are not shipped");

  const leftStart = page.indexOf('<section className="session-labels-section">');
  const leftEnd = page.indexOf("</section>", leftStart);
  assert.match(page.slice(leftStart, leftEnd), /entireSessionContexts\.map/, "whole-session labels are added only from the left panel");
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
  sourceHas(/className=\{`channel-layout-button[\s\S]*?>E<\/button>/, "the expanded channel layout control sits beside CH+");
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

test("keeps footer status text separated from annotation actions", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const footerStart = page.indexOf('<footer className="command-strip">');
  const footerEnd = page.indexOf("</footer>", footerStart);
  const footer = page.slice(footerStart, footerEnd);

  assert.match(footer, /className="command-status-text">\{toast\}/);
  assert.match(footer, /className="annotation-command-actions"/);
  assert.match(css, /\.command-status-text\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.annotation-command-actions\s*\{[^}]*padding-left:\s*12px[^}]*border-left:/);
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
  assert.match(resolver, /label\.category\s*===\s*"Context"[\s\S]*?"context-window"[\s\S]*?"context-instance"/);
  assert.match(resolver, /selection[\s\S]*?\?\s*"windowed"[\s\S]*?:\s*"instance"/);
  assert.match(resolver, /addAnnotation\(label,\s*selection\?\.start\s*\?\?\s*cursorTime,\s*selection\?\.end,\s*intent\)/);

  const addStart = page.indexOf("const addAnnotation");
  const addEnd = page.indexOf("const placePaletteLabel", addStart);
  const addAnnotation = page.slice(addStart, addEnd);
  assert.match(addAnnotation, /intent\s*===\s*"instance"\s*\|\|\s*intent\s*===\s*"context-instance"[\s\S]*?\?\s*"point"/);
  assert.match(addAnnotation, /intent\s*===\s*"windowed"\s*\|\|\s*intent\s*===\s*"context-window"[\s\S]*?\?\s*"interval"/);
  assert.match(addAnnotation, /intent\s*===\s*"context-instance"\s*\|\|\s*intent\s*===\s*"context-window"[\s\S]*?\?\s*"context"/);
  assert.match(addAnnotation, /intent\s*===\s*"instance"[\s\S]*?\?\s*"instance"/);
  assert.match(addAnnotation, /intent\s*===\s*"windowed"[\s\S]*?\?\s*"windowed"/);

  const paletteClickBindings = page.match(/onClick=\{\(\) => placePaletteLabel\(label\)\}/g) ?? [];
  assert.ok(paletteClickBindings.length >= 2, "both context and label palettes use the same placement resolver");

  const dropStart = page.indexOf("const onLabelDrop");
  const dropEnd = page.indexOf("const onLabelDragOver", dropStart);
  const drop = page.slice(dropStart, dropEnd);
  assert.match(drop, /label\.category\s*===\s*"Context"[\s\S]*?"context-window"[\s\S]*?"context-instance"/);
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

test("reattaches non-passive waveform wheel controls after a blank session loads", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  const wheelHandlerStart = page.indexOf("const onViewerWheel");
  const wheelHandlerEnd = page.indexOf("useLayoutEffect", wheelHandlerStart);
  assert.ok(wheelHandlerStart >= 0 && wheelHandlerEnd > wheelHandlerStart, "the waveform wheel handler is present");
  const wheelHandler = page.slice(wheelHandlerStart, wheelHandlerEnd);
  assert.match(wheelHandler, /event\.preventDefault\(\)/, "browser page zoom and scrolling are intercepted over the recording");
  assert.match(wheelHandler, /event\.ctrlKey\s*\|\|\s*event\.metaKey/, "trackpad pinch and modified wheel gestures enter time zoom");
  assert.match(wheelHandler, /zoomTimeWindow\(/, "pinch changes the EEG time window");
  assert.match(wheelHandler, /event\.deltaX/);
  assert.match(wheelHandler, /event\.deltaY/);
  assert.match(wheelHandler, /overExpandedChannels[\s\S]*?Math\.abs\(event\.deltaY\)\s*>\s*Math\.abs\(event\.deltaX\)[\s\S]*?return/, "vertical gestures scroll expanded channels natively");
  assert.match(wheelHandler, /setViewStartSafe\(/, "ordinary wheel and trackpad gestures pan the recording");

  const listenerStart = page.indexOf('viewer.addEventListener("wheel"');
  const listenerEffectStart = page.lastIndexOf("useEffect(() => {", listenerStart);
  const listenerEffectEnd = page.indexOf("\n\n  useEffect", listenerStart);
  assert.ok(listenerEffectStart >= 0 && listenerEffectEnd > listenerStart, "the wheel listener lifecycle is present");
  const listenerEffect = page.slice(listenerEffectStart, listenerEffectEnd);
  assert.match(listenerEffect, /viewerRef\.current/);
  assert.match(listenerEffect, /passive:\s*false/, "wheel handling can prevent browser-level zoom");
  assert.match(listenerEffect, /removeEventListener\("wheel"/, "the wheel listener is cleaned up");
  assert.match(
    listenerEffect,
    /\},\s*\[[^\]]*\bhasRecording\b[^\]]*\]\);/,
    "the listener effect reruns when a recording replaces the initial blank state",
  );
});

test("resizes context from its top edge, with upward drag expanding the track", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  const resizeRead = page.indexOf("const resize = contextResizeRef.current");
  const resizeEffectStart = page.lastIndexOf("useEffect(() => {", resizeRead);
  const resizeEffectEnd = page.indexOf("\n\n  const jumpTo", resizeRead);
  assert.ok(resizeEffectStart >= 0 && resizeEffectEnd > resizeRead, "the context resize lifecycle is present");
  const resizeEffect = page.slice(resizeEffectStart, resizeEffectEnd);
  assert.match(
    resizeEffect,
    /resize\.startHeight\s*-\s*\(\s*event\.clientY\s*-\s*resize\.startY\s*\)/,
    "dragging upward increases context height and dragging downward decreases it",
  );

  const handleRule = css.match(/\.context-resize-handle\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.match(handleRule, /\btop\s*:/, "the resize affordance is attached to the context track's top edge");
  assert.doesNotMatch(handleRule, /\bbottom\s*:/, "the old bottom-edge resize affordance is removed");
});

test("keeps the right panel label-only and ordered like the ontology palette", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const sidebarStart = page.indexOf('<aside className="right-sidebar">');
  const sidebarEnd = page.indexOf("</aside>", sidebarStart);
  assert.ok(sidebarStart >= 0 && sidebarEnd > sidebarStart, "the right label panel is present");
  const sidebar = page.slice(sidebarStart, sidebarEnd);

  const searchPosition = sidebar.search(/Search ontology/i);
  const contextPosition = sidebar.indexOf("Context Labels");
  const ephysPosition = sidebar.indexOf("ePhys Labels");
  assert.ok(searchPosition >= 0, "ontology search is available at the top of the right panel");
  assert.ok(contextPosition > searchPosition, "context labels follow ontology search");
  assert.ok(ephysPosition > contextPosition, "ePhys labels follow context labels");
  assert.doesNotMatch(sidebar, /right-tabs|rightTab|<QcPanel|\bQC\b|inspector-section/, "QC and annotation inspection do not compete with the label palette");
});

test("moves QC into an accessible tab inside the Session Map dialog", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const sessionMapStart = page.indexOf("function SessionMap(");
  assert.ok(sessionMapStart >= 0, "SessionMap is present");
  const sessionMap = page.slice(sessionMapStart);

  assert.match(sessionMap, /role="tablist"/, "Session Map exposes its view switcher as a tab list");
  assert.match(sessionMap, /role="tab"[\s\S]{0,300}Session map/i, "the map remains the primary tab");
  assert.match(sessionMap, /role="tab"[\s\S]{0,300}>QC(?:\s|<)/i, "QC is available as a sibling tab");
  assert.match(sessionMap, /<QcPanel\b/, "the existing QC report renders inside Session Map");

  const invocationStart = page.indexOf("{showSessionMap && <SessionMap");
  const invocationEnd = page.indexOf("/>}", invocationStart);
  assert.ok(invocationStart >= 0 && invocationEnd > invocationStart, "the Session Map dialog is wired from the workspace");
  const invocation = page.slice(invocationStart, invocationEnd);
  assert.match(invocation, /(?:issues|qcIssues)=\{qcIssues\}/, "QC findings are passed into Session Map");
  assert.match(invocation, /badChannels=\{badChannels\}/);
  assert.match(invocation, /recoveryStatus=\{recoveryStatus\}/);
});

test("opens patient information as a modal instead of expanding the left panel", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const leftStart = page.indexOf('<aside className="left-sidebar">');
  const leftEnd = page.indexOf("</aside>", leftStart);
  const left = page.slice(leftStart, leftEnd);
  assert.match(left, /setShowPatientInfo\(true\)/);
  assert.doesNotMatch(left, /patient-info-panel|aria-expanded|patientInfoOpen/);

  const modalStart = page.indexOf("{showPatientInfo && hasRecording");
  const modalEnd = page.indexOf("{showAnnotationEditor", modalStart);
  assert.ok(modalStart >= 0 && modalEnd > modalStart, "patient information popup is present");
  const modal = page.slice(modalStart, modalEnd);
  assert.match(modal, /role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Patient information"/);
  assert.match(modal, /Close patient information/);
  assert.match(modal, /Patient Information/);
  assert.match(modal, /Replace recording/);
  assert.match(modal, /Export model-ready bundle/);
});

test("uses Instance Queue only to navigate file events, instance labels, and non-session context", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const entriesStart = page.indexOf("const instanceQueueEntries");
  const entriesEnd = page.indexOf("const activeQueueIndex", entriesStart);
  const entries = page.slice(entriesStart, entriesEnd);
  assert.match(entries, /item\.track\s*===\s*"instance"/);
  assert.match(entries, /item\.track\s*===\s*"context"/);
  assert.match(entries, /annotationGeometry\(item\)\s*!==\s*"session"/);
  assert.match(entries, /candidates/);
  assert.match(entries, /linkedCandidateIds/, "reviewed file events are not duplicated beside their linked annotation");
  assert.match(entries, /\.sort\(\(a,\s*b\)\s*=>\s*a\.time\s*-\s*b\.time/);

  const queueStart = page.indexOf('<section className="queue-section">');
  const queueEnd = page.indexOf("</section>", queueStart);
  const queue = page.slice(queueStart, queueEnd);
  assert.match(queue, /instanceQueueEntries\.map/);
  assert.match(queue, /selectInstanceQueueEntry/);
  assert.match(queue, /className="queue-arrow"[\s\S]*?Open details for/);
  assert.match(queue, /setQueueDetailTarget\(\{ kind: entry\.kind, id: entry\.id \}\)/);
  assert.doesNotMatch(queue, /setCandidates|Manual review target|\+ Add/, "the queue is navigation-only");
});

test("opens queue-item details with complete notes and context", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const modalStart = page.indexOf("{queueDetailEntry &&");
  const modalEnd = page.indexOf("{showAnnotationEditor", modalStart);
  const modal = page.slice(modalStart, modalEnd);

  assert.match(modal, /role="dialog"[^>]*aria-modal="true"/);
  assert.match(modal, /Close queue item details/);
  assert.match(modal, /TIMED CONTEXT/);
  assert.match(modal, /CONTEXT \/ NOTES/);
  assert.match(modal, /queueDetailAnnotation\?\.notes\?\.trim\(\)/);
  assert.match(modal, /CHANNEL PROVENANCE/);
  assert.match(modal, /Jump to location/);
  assert.match(modal, /Open annotation/);
});

test("does not tint the waveform for whole-session labels", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const drawStart = page.lastIndexOf("for (const item of annotations)", page.indexOf("const rows = Math.max(1, display.data.length)"));
  const drawEnd = page.indexOf("const rows =", drawStart);
  const shading = page.slice(drawStart, drawEnd);

  assert.match(shading, /const geometry = annotationGeometry\(item\)/);
  assert.match(shading, /if \(geometry === "session"\) continue/);
  assert.ok(
    shading.indexOf('if (geometry === "session") continue') < shading.indexOf("context.fillRect"),
    "whole-session labels are skipped before any annotation color is painted",
  );
});

test("refreshes signal windows during panning instead of debouncing until scrolling stops", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const effectStart = page.lastIndexOf("useEffect(() => {", page.indexOf("const requestId = ++displayRequestIdRef.current"));
  const effectEnd = page.indexOf("\n\n  useEffect", page.indexOf("const requestId = ++displayRequestIdRef.current"));
  assert.ok(effectStart >= 0 && effectEnd > effectStart, "signal-window refresh effect is present");
  const effect = page.slice(effectStart, effectEnd);
  assert.match(effect, /displayRefreshPendingRef\.current\s*=\s*refreshWindow/, "each pan position replaces the pending read immediately");
  assert.match(effect, /pumpLatestWindow/, "the newest requested window is pumped without building a stale read backlog");
  assert.doesNotMatch(effect, /setTimeout/, "signal refresh no longer waits for wheel momentum to stop");
  assert.match(effect, /displayAppliedRequestIdRef/, "out-of-order reads cannot overwrite a newer rendered window");
});

test("keeps whole-session context out of the timed tracks and preserves exact label geometry", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /const bottomAnnotations[\s\S]*?annotationGeometry\(item\)\s*!==\s*"session"/);
  assert.match(page, /bottomAnnotations\.filter\(\(item\)\s*=>\s*item\.track\s*===\s*track\.id\)/);
  assert.match(page, /\{ id: "context", label: "Context Labels" \}/);
  assert.match(page, /\{ id: "windowed", label: "ePhys Window Labels" \}/);
  assert.match(page, /\{ id: "instance", label: "ePhys Instance Labels" \}/);
  assert.match(page, /return geometry === "window" \? "interval" : geometry/, "legacy fixed windows migrate to ordinary movable intervals");
  assert.doesNotMatch(page, /id: "(?:wake|sleep-unspecified|n1|n2|n3|rem)"[^\n]+geometry: "window"/);

  const dragStart = page.indexOf("const applyPreview");
  const dragEnd = page.indexOf("const startAnnotationDrag", dragStart);
  const drag = page.slice(dragStart, dragEnd);
  assert.match(drag, /geometry\s*=\s*target\s*===\s*"instance"\s*\?\s*"point"\s*:\s*"interval"/);
  assert.doesNotMatch(drag, /geometry\s*=\s*"window"/);
});

test("highlights a focused channel and provides compact or vertically scrollable channel layouts", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /className=\{focusedChannel\s*===\s*index\s*\?\s*"focused"\s*:\s*""\}/);
  assert.match(page, /aria-pressed=\{focusedChannel\s*===\s*index\}/);
  assert.match(page, /setFocusedChannel\(index\)/);
  assert.match(page, /waveform-wrap \$\{expandedChannels \? "channel-scroll-mode" : ""\}/);
  assert.match(page, /--channel-content-height/);
  assert.match(page, /aria-pressed=\{expandedChannels\}/);
  assert.match(css, /\.waveform-wrap\.channel-scroll-mode[\s\S]*?height:\s*0[\s\S]*?overflow-y:\s*scroll/);
  assert.match(css, /\.channel-rail button\.focused/);
});

test("aligns waveform rows and pointer hit-testing with the channel rail", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /const CHANNEL_RAIL_HEADER_HEIGHT\s*=\s*28/);

  const drawStart = page.indexOf("const rows = Math.max(1, display.data.length)");
  const drawEnd = page.indexOf("if (markOnset !== null)", drawStart);
  const draw = page.slice(drawStart, drawEnd);
  assert.match(draw, /const plotTop\s*=\s*CHANNEL_RAIL_HEADER_HEIGHT/);
  assert.match(draw, /const plotHeight\s*=\s*Math\.max\(1,\s*height\s*-\s*plotTop\)/);
  assert.match(draw, /const rowTop\s*=\s*plotTop\s*\+\s*rowHeight\s*\*\s*channel/);
  assert.match(draw, /const center\s*=\s*rowTop\s*\+\s*rowHeight\s*\*\s*0\.5/);
  assert.match(draw, /baselineSum[\s\S]*?baselineCount[\s\S]*?max\s*-\s*baseline/, "each trace is centered on its display-window baseline");

  const pointerStart = page.indexOf("const onWavePointerDown");
  const pointerEnd = page.indexOf("const onWavePointerUp", pointerStart);
  const pointer = page.slice(pointerStart, pointerEnd);
  assert.equal((pointer.match(/rect\.height\s*-\s*CHANNEL_RAIL_HEADER_HEIGHT/g) ?? []).length, 2);
  assert.equal((pointer.match(/event\.clientY\s*-\s*rect\.top\s*-\s*CHANNEL_RAIL_HEADER_HEIGHT/g) ?? []).length, 2);
});

test("filters padded signal data and crops back to the requested viewport", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const refreshStart = page.indexOf("const refreshWindow");
  const refreshEnd = page.indexOf("displayRefreshPendingRef.current = refreshWindow", refreshStart);
  const refresh = page.slice(refreshStart, refreshEnd);

  assert.match(refresh, /filterPadSec/);
  assert.match(refresh, /paddedStart\s*=\s*Math\.max\(0,\s*viewStart\s*-\s*filterPadSec\)/);
  assert.match(refresh, /paddedEnd\s*=\s*Math\.min\(meta\.durationSec,\s*viewStart\s*\+\s*timebase\s*\+\s*filterPadSec\)/);
  assert.match(refresh, /source\.getWindow\(paddedStart/);
  assert.match(refresh, /applyDisplayFilters\(windowData\.data/);
  assert.match(refresh, /cropStart[\s\S]*?channel\.slice\(/, "filter settling samples are removed before rendering");
});

test("uses every available context lane before compressing overlapping labels", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /const contextLaneHeight\s*=\s*34/);
  assert.match(page, /Math\.floor\(\(contextTrackHeight\s*-\s*10\)\s*\/\s*contextLaneHeight\)/);
  assert.match(page, /contextLaneLayout\.laneCount\s*<=\s*contextLaneCapacity[\s\S]*?\?\s*contextLaneHeight/);
  assert.match(page, /clamp\(resize\.startHeight[\s\S]*?,\s*44,\s*420\)/, "the context surface can expand far enough for dense concurrent context");
});

test("does not render candidate controls or candidate marks", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /activeCandidateItem|candidate-cursor|Suggested instance|skipActiveCandidate/);
  assert.doesNotMatch(css, /map-candidate|candidate-mark|candidate-cursor/);
});
