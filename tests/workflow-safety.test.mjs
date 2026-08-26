import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../app/page.tsx", import.meta.url);

async function pageSource() {
  return readFile(pageUrl, "utf8");
}

function section(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, `expected ${startText} before ${endText}`);
  return source.slice(start, end);
}

test("commit bypass applies only to clinical advisories", async () => {
  const page = await pageSource();
  const commit = section(page, "const commitSelected", "useEffect(() => {");

  assert.match(commit, /const blockers:\s*string\[\]\s*=\s*\[\]/);
  assert.match(commit, /Number\.isFinite\(selectedAnnotation\.start\)/);
  assert.match(commit, /geometry\s*!==\s*"point"\s*&&\s*selectedAnnotation\.end\s*<=\s*selectedAnnotation\.start/);
  assert.match(commit, /!selectedAnnotation\.reviewer\.trim\(\)[\s\S]*?blockers\.push/);
  assert.match(commit, /selectedAnnotation\.labelId\s*===\s*"spikes"[\s\S]*?channelScope[\s\S]*?blockers\.push/);
  assert.match(commit, /if\s*\(blockers\.length\)[\s\S]*?return false/);
  assert.doesNotMatch(commit, /blockers\.length\s*&&\s*!force/);
  assert.match(commit, /if\s*\(advisories\.length\s*&&\s*!force\)/);
  assert.match(commit, /Ictal duration is under 3 seconds/);
  assert.match(commit, /Another ictal onset exists within 30 seconds/);
  assert.match(commit, /status:\s*"committed"[\s\S]*?return true/);
});

test("committed deletion is confirmed and canceled actions keep the editor open", async () => {
  const page = await pageSource();
  const deletion = section(page, "const confirmAnnotationDeletion", "const moveSelectedAnnotations");
  assert.match(deletion, /item\.status\s*===\s*"committed"/);
  assert.match(deletion, /window\.confirm/);
  assert.match(deletion, /if\s*\(!confirmAnnotationDeletion\(\[removed\]\)\)[\s\S]*?return false/);
  assert.match(deletion, /if\s*\(!confirmAnnotationDeletion\(removed\)\)[\s\S]*?return false/);

  const editor = section(page, "{showAnnotationEditor &&", "{showSessionMap &&");
  assert.match(editor, /if\s*\(commitSelected\(\)\)\s*setShowAnnotationEditor\(false\)/);
  assert.match(editor, /if\s*\(deleteAnnotation\(selectedAnnotation\.id\)\)\s*setShowAnnotationEditor\(false\)/);
});

test("reviewer identity stays with its recording rather than a browser-wide preference", async () => {
  const page = await pageSource();
  assert.doesNotMatch(page, /neurotrace:reviewer/);
  assert.match(page, /reviewer:\s*""[\s\S]*?sessionSnapshotsRef\.current\.set\(id,\s*snapshot\)/);
  assert.match(page, /setReviewer\(restoredReviewer\s*\?\?\s*""\)/);
  assert.match(page, /reviewer:\s*snapshot\.reviewer/);
});

test("global shortcuts leave native controls alone and reserve Enter and Space for the waveform", async () => {
  const page = await pageSource();
  const keyboard = section(page, "const onKey = (event: KeyboardEvent)", 'window.addEventListener("keydown"');
  assert.match(keyboard, /closest\("input, textarea, select, button, a, \[role='button'\], \[contenteditable='true'\]"\)/);
  assert.match(keyboard, /if\s*\(interactiveTarget\)\s*return/);
  assert.match(keyboard, /if\s*\(event\.metaKey\s*\|\|\s*event\.ctrlKey\s*\|\|\s*event\.altKey\)\s*return/);
  assert.match(keyboard, /target\s*===\s*canvasRef\.current/);
  assert.doesNotMatch(keyboard, /controlBindings\.commit\s*\|\|\s*event\.key\s*===\s*"Enter"\s*\|\|\s*event\.code\s*===\s*"Space"/);

  const modalEscape = section(keyboard, 'if (event.key === "Escape" && modalOpen)', "if (modalOpen) return");
  assert.ok(modalEscape.indexOf("confirmCommit.length") < modalEscape.indexOf("showAnnotationEditor"), "Escape closes the top advisory before its editor");
  assert.doesNotMatch(modalEscape, /setSelectedAnnotationId\(null\)|setSelectedAnnotationIds\(new Set\(\)\)/);
});

test("critical feedback and dialogs expose accessible semantics", async () => {
  const page = await pageSource();
  assert.match(page, /<canvas[^>]*tabIndex=\{0\}[^>]*role="img"[^>]*onPointerCancel=\{onWavePointerCancel\}/);
  assert.match(page, /className="command-status"\s*role="status"\s*aria-live="polite"\s*aria-atomic="true"/);
  assert.match(page, /className="modal confirm-modal"\s*role="dialog"\s*aria-modal="true"\s*aria-label="Commit advisory"/);
  assert.match(page, /className="session-map-modal"\s*role="dialog"\s*aria-modal="true"\s*aria-label="Session map and quality review"/);
});

test("recovery validates saved structures, preserves unreadable data, and falls back to a valid draft", async () => {
  const page = await pageSource();
  const validation = section(page, "function parseRecoveryDraft", "const DEFAULT_FILTERS");
  assert.match(validation, /if\s*\(!Array\.isArray\(parsed\)\)\s*throw/);
  assert.match(page, /function hasValidRecoveryBounds[\s\S]*?rawGeometry\s*===\s*"point"[\s\S]*?annotation\.end\s*>\s*annotation\.start/);
  assert.match(validation, /hasValidRecoveryBounds\(annotation,\s*durationSec\)/);
  assert.match(validation, /annotations\.length\s*!==\s*parsed\.length/);
  assert.match(validation, /project\.version\s*!==\s*2/);
  assert.match(validation, /candidates\.length\s*!==\s*rawCandidates\.length/);
  assert.match(validation, /badChannels\.length\s*!==\s*rawBadChannels\.length/);

  const load = section(page, "const loadSource", "const importFiles");
  assert.match(load, /preserveUnreadableRecovery/);
  assert.match(load, /neurotrace:unreadable-/);
  assert.match(load, /const usedDraft\s*=\s*restoreDraft\(\)/);
  assert.match(load, /recoveryWarning/);
});

test("raw DAT confirmation rejects zero, negative, non-finite, and fractional mapping values", async () => {
  const page = await pageSource();
  const confirm = section(page, "const confirmDatImport", "const exportBundle");
  assert.match(confirm, /Number\.isFinite\(datMapping\.sampleRate\)/);
  assert.match(confirm, /datMapping\.sampleRate\s*>\s*0/);
  assert.match(confirm, /Number\.isInteger\(datMapping\.channelCount\)/);
  assert.match(confirm, /Number\.isFinite\(datMapping\.physicalScale\)/);
  assert.match(confirm, /datMapping\.physicalScale\s*>\s*0/);

  const mapperButton = page.match(/<button className="button primary wide" disabled=\{([^}]+)\} onClick=\{confirmDatImport\}/)?.[1] ?? "";
  assert.match(mapperButton, /Number\.isInteger\(datMapping\.channelCount\)/);
  assert.match(mapperButton, /datMapping\.physicalScale\s*>\s*0/);
});

test("mixed-rate interaction keeps channel provenance and sample timing", async () => {
  const page = await pageSource();
  const add = section(page, "const addAnnotation", "const placePaletteLabel");
  assert.match(add, /targetRow\s*=\s*focusedChannel/);
  assert.match(add, /sourceRateForDisplayRow\(display,\s*meta,\s*targetRow\)/);
  assert.match(add, /display\.sourceIndices\[targetRow\]/);
  assert.match(add, /display\.primarySourceIndices\[targetRow\]/);

  const movement = section(page, "const moveSelectedAnnotations", "const qcIssues");
  assert.match(movement, /anchor\.channelScope/);
  assert.match(movement, /meta\.sampleRates\[anchor\.channelScope\.primarySourceIndex\]/);

  const pointer = section(page, "const timeFromPointer", "const onWavePointerDown");
  assert.match(pointer, /visibleStart/);
  assert.match(pointer, /visibleEnd/);
  assert.match(pointer, /snapTime[\s\S]*?visibleStart,[\s\S]*?visibleEnd/);

  const drop = section(page, "const onLabelDrop", "useEffect(() => {");
  assert.match(drop, /clientY\s*<\s*canvasRect\.top\s*\+\s*CHANNEL_RAIL_HEADER_HEIGHT/);
  assert.match(drop, /addAnnotation\(label,[\s\S]*?intent,\s*row\)/);
  assert.match(page, /className="canvas-shell"\s+onDragOver=\{onLabelDragOver\}\s+onDrop=\{onLabelDrop\}/);
  assert.doesNotMatch(page, /className=\{`signal-and-tracks[^>]+onDrop=\{onLabelDrop\}/);
});

test("large-window memory and missing-data rendering stay bounded and explicit", async () => {
  const page = await pageSource();
  const refresh = section(page, "const refreshWindow", "const timer = window.setInterval");
  assert.match(refresh, /rawOwnerIsCached\s*=\s*rawWindowCacheRef\.current\.includes\(rawWindow\)/);
  assert.match(refresh, /if\s*\(rawOwnerIsCached[\s\S]*?!duplicatesRaw/);
  assert.match(refresh, /sourceStartSampleIndex[\s\S]*?prepareClinicalDisplaySignals[\s\S]*?outputStartSampleIndices/);

  const baseline = section(page, "function robustTraceBaseline", "function boundedCanvasScale");
  assert.match(baseline, /for\s*\(let index\s*=\s*0;\s*index\s*<\s*values\.length/);
  assert.match(baseline, /Number\.isFinite\(value\)/);
  assert.match(baseline, /reservoir sampling/i);

  const spectrum = section(page, "function SpectrogramPanel", "function QcPanel");
  assert.match(spectrum, /finiteSamples\s*\/\s*windowSize\s*<\s*\.75/);
  assert.match(spectrum, /if\s*\(!Number\.isFinite\(sourceValue\)\)\s*continue/);
  assert.match(spectrum, /powers\.flat\(\)\.filter\(Number\.isFinite\)/);
  assert.match(spectrum, /No sufficiently complete signal frames/);
});
