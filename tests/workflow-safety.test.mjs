import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../app/page.tsx", import.meta.url);

async function pageSource() {
  return (await readFile(pageUrl, "utf8")).replaceAll("\r\n", "\n");
}

function section(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, `expected ${startText} before ${endText}`);
  return source.slice(start, end);
}

test("commit bypass applies only to clinical advisories", async () => {
  const page = await pageSource();
  const commit = section(page, "const commitAnnotation", "const commitSelected");

  assert.match(commit, /const blockers:\s*string\[\]\s*=\s*\[\]/);
  assert.match(commit, /Number\.isFinite\(targetAnnotation\.start\)/);
  assert.match(commit, /geometry\s*!==\s*"point"\s*&&\s*targetAnnotation\.end\s*<=\s*targetAnnotation\.start/);
  assert.match(commit, /if\s*\(!commitReviewer\)\s*blockers\.push/);
  assert.match(commit, /targetAnnotation\.labelId\s*===\s*"spikes"[\s\S]*?channelScope[\s\S]*?blockers\.push/);
  assert.match(commit, /if\s*\(blockers\.length\)[\s\S]*?return false/);
  assert.doesNotMatch(commit, /blockers\.length\s*&&\s*!force/);
  assert.match(commit, /if\s*\(advisories\.length\s*&&\s*!force\)/);
  assert.match(commit, /Ictal duration is under 3 seconds/);
  assert.match(commit, /Another ictal onset exists within 30 seconds/);
  assert.match(commit, /status:\s*"committed"[\s\S]*?return true/);
});

test("source-event decisions remain synchronized and export the MATLAB-compatible schema", async () => {
  const page = await pageSource();
  assert.match(page, /targetAnnotation\.candidateId\s*\?\s*reviewer\s*:/, "review-bar initials are authoritative for source-event commits");
  assert.match(page, /commitSelected\(true,\s*commitAdvanceAfter\)/, "an advisory commit preserves accept-and-advance intent");
  assert.match(page, /const reopenCandidateReviews[\s\S]*?status:\s*index\s*===\s*activeCandidate\s*\?\s*"active"\s*:\s*"queued"/);
  assert.match(page, /type AnnotationHistorySnapshot[\s\S]*?candidates:\s*Candidate\[\][\s\S]*?activeCandidate:\s*number/);
  assert.match(page, /redoRef\.current\.push\(\{[\s\S]*?candidates:\s*candidatesRef\.current[\s\S]*?setCandidates\(previous\.candidates\)/);
  const mutation = section(page, "const commitMutation", "const undo");
  assert.doesNotMatch(mutation, /setAnnotations\(\(current\)/, "history side effects stay outside React state updaters");
  assert.match(page, /currentWithoutPreviousCandidateDraft[\s\S]*?item\.candidateId\s*===\s*activeSourceCandidate\.id/);
  assert.match(page, /selectedAnnotation\.id\s*===\s*activeCandidateAnnotation\?\.id/);
  assert.match(page, /previous\.candidateId\s*&&\s*previous\.status\s*===\s*"committed"\s*&&\s*!allowCandidateReopen/);
  assert.match(page, /updateAnnotation\(activeCandidateAnnotation\.id,\s*\{\s*status:\s*"draft"\s*\},\s*true,\s*true\)/);
  assert.match(page, /Accepted source-event marks are locked[\s\S]*?use Revise marks before dragging them/);
  assert.match(page, /selectedAnnotation\.candidateId\s*===\s*activeCandidateItem\?\.id/, "the global commit shortcut cannot accept a different selected annotation");
  assert.match(page, /candidate\.status\s*===\s*"reviewed"\s*&&\s*linked\?\.status\s*===\s*"committed"/);
  assert.match(page, /patient_id_hint/);
  assert.match(page, /companion_mat_path/);
  assert.match(page, /data_dir_hint/);
  assert.match(page, /dat_file_base/);
  assert.match(page, /candidateDecisionLocked[\s\S]*?disabled=\{candidateDecisionLocked\}/);
  assert.match(page, /candidate\.status\s*===\s*"skipped"\s*\|\|\s*\([\s\S]*?item\.status\s*===\s*"committed"/);
  for (const column of [
    "patient_id",
    "reviewer_initials",
    "mat_path",
    "data_dir",
    "event_time_original_sec",
    "onset_relative_to_annotation_sec",
    "offset_relative_to_annotation_sec",
    "seizure_duration_sec",
    "ictal_channels",
    "confidence_score",
    "review_status",
    "accepted",
  ]) assert.match(page, new RegExp(`"${column}"`));
});

test("committed deletion is confirmed and canceled actions keep the editor open", async () => {
  const page = await pageSource();
  const deletion = section(page, "const confirmAnnotationDeletion", "const moveSelectedAnnotations");
  assert.match(deletion, /item\.status\s*===\s*"committed"/);
  assert.match(deletion, /window\.confirm/);
  assert.match(deletion, /Accepted source-event marks are locked[\s\S]*?use Revise marks before deleting them/);
  assert.match(deletion, /removed\.some\(\(item\)\s*=>\s*item\.candidateId\s*&&\s*item\.status\s*===\s*"committed"\)[\s\S]*?return false/);
  assert.match(deletion, /if\s*\(!confirmAnnotationDeletion\(\[removed\]\)\)[\s\S]*?return false/);
  assert.match(deletion, /if\s*\(!confirmAnnotationDeletion\(removed\)\)[\s\S]*?return false/);

  const editor = section(page, "{showAnnotationEditor &&", "{showSessionMap &&");
  assert.match(editor, /if\s*\(commitSelected\(\)\)\s*setShowAnnotationEditor\(false\)/);
  assert.match(editor, /if\s*\(deleteAnnotation\(selectedAnnotation\.id\)\)\s*setShowAnnotationEditor\(false\)/);
  assert.match(editor, /Accepted source-event decision locked/);
  assert.match(editor, /className="icon-danger"[\s\S]*?deleteAnnotation\(selectedAnnotation\.id\)[\s\S]*?disabled=\{selectedCandidateDecisionLocked\}\s+title="Delete annotation"/);
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
  assert.match(keyboard, /closest\("\.spectrogram-panel"\) && event\.key !== "Escape"/);
  assert.match(keyboard, /event\.key === "Escape"[\s\S]*?setChannelSelectionActive\(false\)/);
  const selectionEscape = section(keyboard, 'if (event.key === "Escape")', "if (interactiveTarget) return");
  assert.doesNotMatch(selectionEscape, /setWaveformVerticalViewport\(null\)/, "Escape preserves the current waveform zoom");
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
  assert.match(page, /function sourceIdentityInterpretation[\s\S]*?patient_id_hint[\s\S]*?data_dir_hint/);
  assert.match(page, /function sourceIdentityInterpretation[\s\S]*?display_amplitude_mode/);
  assert.match(load, /sourceIdentityInterpretation\(interpretation\)/);
  assert.match(load, /physical_scale_uv_per_count\s*===\s*null[\s\S]*?physical_scale_uv_per_count:\s*1[\s\S]*?legacyRecoveryKey/);
  assert.match(load, /neurotrace:project:\$\{legacyRecoveryKey\}[\s\S]*?usedLegacyRecoveryKey/);
  assert.match(load, /Recovered prior DAT review state and migrated it to the unscaled raw-count display/);
  assert.match(page, /matlabExportIdentity:\s*matlabExportIdentityFromInterpretation\(sourceInterpretation\)/);
  assert.match(load, /applyMatlabExportIdentity\(interpretation,\s*restoredMatlabExportIdentity\)/);
  assert.match(page, /Editable without changing the recording recovery key/);
});

test("raw DAT requires valid dimensions while preserving an explicit raw-count mode", async () => {
  const page = await pageSource();
  const confirm = section(page, "const confirmDatImport", "const exportBundle");
  assert.match(confirm, /Number\.isFinite\(datMapping\.sampleRate\)/);
  assert.match(confirm, /datMapping\.sampleRate\s*>\s*0/);
  assert.match(confirm, /Number\.isInteger\(datMapping\.channelCount\)/);
  assert.match(page, /datMapping\.physicalScale\s*===\s*""[\s\S]*?Number\.isFinite\(datMapping\.physicalScale\)[\s\S]*?datMapping\.physicalScale\s*>\s*0/);
  assert.match(confirm, /const verifiedPhysicalScale\s*=\s*datMapping\.physicalScale\s*===\s*""\s*\?\s*undefined/);
  assert.match(confirm, /channelUnits:\s*verifiedPhysicalScale\s*===\s*undefined\s*\?\s*"ADC count"\s*:\s*"µV"/);
  assert.match(confirm, /display_amplitude_mode:\s*verifiedPhysicalScale\s*===\s*undefined\s*\?\s*"legacy-raw-counts"/);
  assert.match(page, /Leave scale blank to match MATLAB&apos;s raw-count display with 15,000 counts between channel baselines/);

  const mapperButton = page.match(/<button className="button primary wide" disabled=\{([^}]+)\} onClick=\{confirmDatImport\}/)?.[1] ?? "";
  assert.match(mapperButton, /Number\.isInteger\(datMapping\.channelCount\)/);
  assert.match(mapperButton, /datPhysicalScaleValid/);
  const load = section(page, "const loadSource", "const importFiles");
  assert.match(load, /setGain\(1\)[\s\S]*?setMontage\("referential"\)[\s\S]*?setFilters\(\{\s*\.\.\.DEFAULT_FILTERS\s*\}\)/);
});

test("legacy MAT review defaults seizure events into a selectable pre-review queue", async () => {
  const page = await pageSource();
  assert.match(page, /setSelectedLegacyEventIndices\(new Set\(legacyMetadata\.events\.flatMap/);
  assert.match(page, /className="legacy-event-picker"/);
  assert.match(page, /Source events to review/);
  assert.match(page, /selectedLegacyEventIndices\.has\(sourceIndex\)/);
  assert.match(page, /restoredTerminalDecisions/);
  assert.match(page, /MATLAB export identity/);
  assert.match(page, /Browsers hide absolute local paths/);
  assert.match(page, /setActiveCandidate\(0\)[\s\S]*?no selected seizure-keyword events remain/);
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
  assert.match(page, /className=\{`canvas-shell[^`]*`\}[\s\S]{0,320}?onDragOver=\{onLabelDragOver\}[\s\S]{0,100}?onDrop=\{onLabelDrop\}/);
  assert.doesNotMatch(page, /className=\{`signal-and-tracks[^>]+onDrop=\{onLabelDrop\}/);
});

test("large-window memory and missing-data rendering stay bounded and explicit", async () => {
  const [page, spectrogramCore] = await Promise.all([
    pageSource(),
    readFile(new URL("../app/spectrogram-compute.ts", import.meta.url), "utf8"),
  ]);
  const refresh = section(page, "const refreshWindow", "const timer = window.setInterval");
  assert.match(page, /displayAbortRef\.current\?\.abort\(\)/);
  assert.match(refresh, /typeof source\.getEnvelopeWindow\s*===\s*"function"/);
  assert.doesNotMatch(refresh, /&&\s*!requiresClinicalPreparation/);
  assert.doesNotMatch(refresh, /&&\s*!spectrogramOpen/);
  assert.match(refresh, /waveformWidth\s*>=\s*MIN_WAVEFORM_WIDTH_FOR_ENVELOPE/);
  assert.match(refresh, /SOURCE_READ_AHEAD_BUDGET_BYTES/);
  assert.match(refresh, /ENVELOPE_CACHE_BUDGET_BYTES/);
  assert.match(refresh, /reusableEnvelopeBucketCount/);
  assert.match(refresh, /aggregateEnvelopeWindow/);
  assert.match(refresh, /buildEDFEnvelopeWindowOffThread/);
  assert.match(refresh, /buildRawDatEnvelopeWindowOffThread/);
  assert.match(refresh, /buildEDFFileWindowOffThread/);
  assert.match(refresh, /buildRawDatFileWindowOffThread/);
  assert.match(refresh, /pyramidMinimumBucketCount:\s*64/);
  assert.match(refresh, /fallbackToMainThread:\s*false/);
  assert.match(refresh, /sourceVerificationRef\.current[\s\S]*?requiredDuration\s*>\s*maximumEnvelopeReadDuration/);
  assert.match(page, /FULL_SESSION_ENVELOPE_REFINEMENT\s*=\s*32/);
  assert.match(page, /adaptiveTimeGridInterval\(timebase/);
  assert.match(page, /MAX_INTERACTIVE_TIMELINE_ANNOTATIONS\s*=\s*400/);
  assert.match(page, /clusterTimelineDensity\(/);
  assert.match(page, /timelineUsesDensity\s*\?/);
  const qc = section(page, "const qcIssues", "const advanceFromCandidate");
  assert.doesNotMatch(qc, /annotations\.some\(/);
  assert.match(qc, /committedIctalCandidateIds/);
  assert.match(qc, /latestSleepEndByLabel/);
  assert.match(qc, /displayWarningKey/);
  assert.match(refresh, /maximumRawDuration/);
  assert.match(refresh, /detectEnvelopeSynchronizedFlatlines/);
  assert.match(refresh, /const overviewColumnCount\s*=\s*waveformOverviewColumnBudget\(timebase, waveformWidth\)/);
  assert.match(refresh, /const requiredBucketDuration\s*=\s*timebase\s*\/\s*overviewColumnCount/);
  assert.match(refresh, /minimumCacheBuckets[\s\S]*?overviewColumnCount/);
  assert.match(refresh, /maximumUsefulBucketCount[\s\S]*?cacheDuration\s*\*\s*maximumSourceSampleRate/);
  assert.match(refresh, /Math\.min\(requestedBucketCount,\s*maximumUsefulBucketCount\)/);
  assert.match(refresh, /processDisplaySignalsOffThread/);
  assert.match(refresh, /requestId\s*!==\s*displayRequestIdRef\.current/);
  assert.match(refresh, /rawOwnerIsCached\s*=\s*rawWindowCacheRef\.current\.includes\(rawWindow\)/);
  assert.match(refresh, /if\s*\(rawOwnerIsCached[\s\S]*?!duplicatesRaw/);
  assert.match(refresh, /sourceStartSampleIndices[\s\S]*?processDisplaySignalsOffThread[\s\S]*?outputStartSampleIndices/);
  assert.match(refresh, /const processingData\s*=\s*rawWindow\.data\.map[\s\S]*?channel\.subarray/);
  assert.match(refresh, /processDisplaySignalsOffThread\(\{\s*data:\s*processingData/);

  const baseline = section(page, "function robustTraceBaseline", "function boundedCanvasScale");
  assert.match(baseline, /for\s*\(let index\s*=\s*0;\s*index\s*<\s*values\.length/);
  assert.match(baseline, /Number\.isFinite\(value\)/);
  assert.match(baseline, /reservoir sampling/i);

  const spectrum = section(page, "function SpectrogramPanel", "function QcPanel");
  assert.match(spectrum, /computeSpectrogramOffThread/);
  assert.match(spectrum, /if\s*\(overview\s*\|\|/);
  assert.match(spectrum, /dark green → lime → yellow → orange marks distance beyond ±100 µV/);
  assert.match(spectrogramCore, /finiteSamples\s*\/\s*windowSize\s*<\s*0\.75/);
  assert.match(spectrogramCore, /if\s*\(!Number\.isFinite\(sourceValue\)\)\s*continue/);
  assert.match(spectrum, /Array\.from\(powers\)\.filter\(Number\.isFinite\)/);
  assert.match(spectrum, /No sufficiently complete signal frames/);

  const drawing = section(page, "const traceOrder", "if (markOnset !== null)");
  const groupedExtrema = section(page, "function drawGroupedExtrema", "function drawOverviewEnvelope");
  const overviewEnvelope = section(page, "function drawOverviewEnvelope", "function expectedEDFRecordBytes");
  assert.match(drawing, /if\s*\(rowTop\s*\+\s*rowHeight\s*<\s*plotTop\s*\|\|\s*rowTop\s*>\s*height\)\s*continue/);
  assert.match(drawing, /display\.envelopes\[channel\]/);
  assert.match(drawing, /waveformGeometryFitsBudget/);
  assert.match(drawing, /envelopeTraceRenderMode/);
  assert.match(drawing, /drawContinuousTrace/);
  assert.match(drawing, /maximumExtremaGroupsForBudget/);
  assert.match(drawing, /extremaGroupBudget/);
  assert.match(page, /WAVEFORM_VIEW_EXTREMA_GROUP_BUDGET_MULTIPLIER\s*=\s*1\.5/);
  assert.match(drawing, /drawGroupedExtrema/);
  assert.match(drawing, /context\.fill\(\)/);
  assert.doesNotMatch(drawing, /context\.lineTo\(x\s*\+\s*\.5,\s*confineTraceYValueToRow\(minimumY/);
  assert.match(groupedExtrema, /drawBoundary\(\(group\)\s*=>\s*group\.maximum\)/);
  assert.match(groupedExtrema, /drawBoundary\(\(group\)\s*=>\s*group\.minimum\)/);
  assert.doesNotMatch(groupedExtrema, /context\.lineTo\(x,\s*bottom\)/);
  assert.match(groupedExtrema, /interrupted/);
  assert.match(groupedExtrema, /representativeGroupEnd\s*!==\s*group\.start/);
  assert.match(groupedExtrema, /representativeConnected/);
  assert.match(groupedExtrema, /representativeMean/);
  assert.doesNotMatch(groupedExtrema, /binWidth/);
  assert.doesNotMatch(groupedExtrema, /previousTop/);
  assert.doesNotMatch(groupedExtrema, /context\.fill\(\)/);
  assert.match(groupedExtrema, /context\.stroke\(\)/);
  assert.equal(groupedExtrema.match(/context\.stroke\(\)/g)?.length, 1);
  assert.match(drawing, /drawOverviewEnvelope/);
  assert.match(overviewEnvelope, /context\.closePath\(\)[\s\S]*?context\.fill\(\)/);
  assert.match(overviewEnvelope, /gaussianClippingHaloIntensity/);
  assert.match(overviewEnvelope, /showClippingHalo\s*&&\s*rowHeight\s*>=\s*4/);
  assert.match(overviewEnvelope, /context\.fillRect\(left,\s*ribbonTop/);
  assert.match(drawing, /cachedGeometry/);
  assert.match(page, /WAVEFORM_ROW_COMMAND_BUDGET_MULTIPLIER\s*=\s*3\.25/);
  assert.match(page, /MAX_WAVEFORM_CANVAS_SCALE\s*=\s*1/);
  assert.match(page, /getContext\("2d",\s*\{\s*alpha:\s*false,\s*desynchronized:\s*true\s*\}\)/);
  assert.match(page, /context\.lineJoin\s*=\s*"bevel"/);
  assert.match(page, /channelScrollOffsetRef\.current[\s\S]*?waveDrawRef\.current\(\)/);
  assert.doesNotMatch(page, /setChannelScrollOffset/, "vertical channel scrolling repaints imperatively without a React render per frame");

  const hitTesting = section(page, "const channelRowFromClientY", "const timeFromPointer");
  assert.match(hitTesting, /waveformScrollRef\.current\?\.scrollTop/);
  assert.match(hitTesting, /channelRowLayout\.totalUnits\s*\*\s*60/);
  assert.match(page, /const envelope\s*=\s*display\.envelopes\[row\][\s\S]*?Math\.floor/);
});

test("finite clipped waveform samples remain connected when zoom rebuilds the trace", async () => {
  const page = await pageSource();
  const rowConfinement = section(page, "const TRACE_ROW_EDGE_INSET_PX", "function traceYOverflowsRow");
  const continuousTrace = section(page, "function drawContinuousTrace", "function drawGroupedExtrema");
  const drawing = section(page, "const traceOrder", "if (markOnset !== null)");
  const directTrace = section(
    drawing,
    "} else if (values.length <= Math.max(2, width * 1.5)) {",
    "} else {\n          const pixelColumns",
  );

  assert.match(rowConfinement, /const edgeInset\s*=\s*Math\.min\(TRACE_ROW_EDGE_INSET_PX,\s*rowHeight\s*\/\s*2\)/);
  assert.match(rowConfinement, /Math\.min\(visibleBottom,\s*Math\.max\(visibleTop,\s*y\)\)/, "clipped montage strokes stay visibly inside the row clip");
  assert.match(continuousTrace, /if\s*\(!Number\.isFinite\(value\)\s*\|\|\s*gaps\?\.\[index\]\)\s*\{\s*connected\s*=\s*false/);
  assert.match(continuousTrace, /if\s*\(traceYOverflowsRow\(rawY,\s*rowTop,\s*rowHeight\)\)\s*\{\s*overflow\s*=\s*true;\s*\}\s*if\s*\(connected\)\s*context\.lineTo\(x,\s*y\)/);
  assert.doesNotMatch(continuousTrace, /traceYOverflowsRow[\s\S]*?connected\s*=\s*false/, "finite clipped samples remain connected at row boundaries");
  assert.match(directTrace, /overflow\s*=\s*drawContinuousTrace\(/, "zoomed raw traces reuse the continuous clipping path");
});

test("detects recording modality instead of accepting a manual recording-type selection", async () => {
  const page = await pageSource();
  const detection = section(page, "const recordingType = useMemo", "const [viewStart");
  const summary = section(page, "{hasRecording && <section className=\"recording-summary\">", "</section>}");

  assert.match(detection, /detectRecordingType\(/);
  assert.match(detection, /channelLabels:\s*meta\.channelLabels/);
  assert.match(summary, /<strong>\{recordingType\}<\/strong>/);
  assert.doesNotMatch(summary, /<select/);
  assert.doesNotMatch(page, /setRecordingType|channelLabels\.length\s*>\s*64\s*\?\s*"SEEG \/ iEEG"/);
});

test("measures the waveform after a recording mounts or returns from file info", async () => {
  const page = await pageSource();
  const resize = section(page, "useLayoutEffect(() => {\n    const canvas = canvasRef.current", "const updateExpandedChannelViewport");
  assert.match(resize, /const measure\s*=\s*\(\)\s*=>/);
  assert.match(resize, /measure\(\);[\s\S]*?new ResizeObserver\(measure\)/);
  assert.match(resize, /\},\s*\[activeSessionContentView, hasRecording\]\);/);
  assert.match(page, /const MIN_WAVEFORM_WIDTH_FOR_ENVELOPE\s*=\s*64/);
});

test("large source verification stays off the UI thread and combines EDF hashing with TAL extraction", async () => {
  const page = await pageSource();
  const client = await readFile(new URL("../app/source-integrity-worker-client.ts", import.meta.url), "utf8");
  const worker = await readFile(new URL("../app/source-hash-worker.ts", import.meta.url), "utf8");
  const displayClient = await readFile(new URL("../app/display-processing-worker-client.ts", import.meta.url), "utf8");
  const displayWorker = await readFile(new URL("../app/display-processing-worker.ts", import.meta.url), "utf8");

  assert.match(client, /new Worker\(new URL\("\.\/source-hash-worker\.ts",\s*import\.meta\.url\)/);
  assert.match(client, /worker\.terminate\(\)/);
  assert.match(client, /options\.signal\?\.addEventListener\("abort"/);
  assert.match(client, /fallbackToDirect[\s\S]*?verifySourceDirectly/);
  assert.match(client, /annotationSignals\.map/);
  assert.match(worker, /const sha256\s*=\s*new IncrementalSha256\(\)/);
  assert.match(worker, /events\.push\(\.\.\.parseEdfTalText/);
  assert.match(worker, /for\s*\(let offset\s*=\s*declaredDataEnd;\s*offset\s*<\s*blob\.size/);
  assert.match(worker, /hash:\s*sha256\.hexDigest\(\)/);
  assert.match(page, /sourceVerificationAbortRef\.current/);
  assert.match(page, /className="verification-cancel"/);
  assert.match(page, /verifySourceOffThread\(\s*pendingLegacyMatFile/);
  assert.match(displayClient, /new Worker\(new URL\("\.\/display-processing-worker\.ts",\s*import\.meta\.url\)/);
  assert.match(displayClient, /options\.signal\?\.addEventListener\("abort"/);
  assert.match(displayClient, /fallbackToDirect[\s\S]*?processDirectly/);
  assert.match(displayWorker, /applyDisplayFilters/);
  assert.match(displayWorker, /prepareClinicalDisplaySignals/);
  assert.doesNotMatch(page, /source\.loadAnnotations\(/, "EDF+ events reuse the shared hash/index pass instead of rereading the source");
  const applySnapshot = section(page, "const applySessionSnapshot", "const switchSession");
  assert.doesNotMatch(applySnapshot, /(?:rawWindow|processedWindow|envelopeWindow)CacheRef\.current\s*=\s*\[\]/, "switching tabs retains source-keyed signal indexes");
});
