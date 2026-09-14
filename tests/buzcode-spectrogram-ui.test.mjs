import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectFile = (path) => new URL(`../${path}`, import.meta.url);

test("exposes TheStateEditor processing controls and linked navigation", async () => {
  const page = await readFile(projectFile("app/page.tsx"), "utf8");
  const start = page.indexOf("function SpectrogramPanel");
  const end = page.indexOf("type FileStructureNode", start);
  const panel = page.slice(start, end);
  assert.match(panel, /BUZCODE_DEFAULT_SMOOTHING_SECONDS/);
  assert.match(panel, /BUZCODE_SMOOTHING_OPTIONS\.map/);
  assert.match(panel, /thetaRatioOverlay/);
  assert.match(panel, /matlabJet/);
  assert.doesNotMatch(panel, /Frequency resize mode|>F<|>FREQ</);
  const browseButton = panel.indexOf('aria-label="Browse spectrogram"');
  const boxZoomButton = panel.indexOf('aria-label="Box zoom spectrogram"');
  const frequencyRange = panel.indexOf('aria-label="Displayed frequency range"');
  assert.ok(browseButton >= 0, "the browse tool is available");
  assert.ok(boxZoomButton > browseButton, "box zoom sits immediately after browse");
  assert.ok(frequencyRange > boxZoomButton, "frequency controls follow the navigation tools");
  assert.match(panel, /useState<SpectrogramTool>\("browse"\)/);
  assert.match(panel, /interaction\.tool === "box-zoom"[\s\S]*?onZoom\(Math\.min\(startTime, endTime\), Math\.max\(startTime, endTime\)\)/);
  assert.match(panel, /setDisplayMinHz\(nextMinimumHz\)[\s\S]*?setDisplayMaxHz\(nextMaximumHz\)/);
  assert.match(panel, /className="spectrogram-zoom-box"/);
  assert.match(page, /onZoom=\{zoomToTimeRange\}/);
  assert.match(panel, /role="group" aria-label="Displayed frequency range"/);
  assert.match(panel, /aria-label="Lower maximum displayed frequency"/);
  assert.match(panel, /aria-label="Raise maximum displayed frequency"/);
  assert.match(panel, /aria-label="Reset displayed frequency range"/);
  assert.match(panel, /<output aria-live="polite">\{Math\.round\(effectiveDisplayMinHz\)\}–\{Math\.round\(effectiveDisplayMaxHz\)\} Hz<\/output>/);
  assert.match(panel, /viewDuration \* 0\.15/);
  assert.match(panel, /effectiveDisplayMaxHz \+ 10/);
  assert.match(panel, /colorLimitShift/);
  assert.match(panel, /Z box zoom · drag a time-frequency area/i);
  assert.match(panel, /Frequency range shows the visible band/i);
  assert.match(panel, /waveform controls also set time zoom/i);
  assert.equal((panel.match(/SPECTROGRAM_DRAG_PAN_SCALE/g) ?? []).length, 2);
  assert.match(page, /\(canvasShell \?\? spectrogramShell\)\?\.getBoundingClientRect\(\) \?\? viewerRect/);
  assert.match(page, /if \(spectrogramShell && \(event\.ctrlKey \|\| event\.metaKey\)\)[\s\S]*?return/);
  assert.doesNotMatch(page, /if \(spectrogramShell\)[\s\S]*?setTimeWindow/);
});

test("lets the spectrogram replace the waveform pane without changing the waveform data path", async () => {
  const [page, css] = await Promise.all([
    readFile(projectFile("app/page.tsx"), "utf8"),
    readFile(projectFile("app/globals.css"), "utf8"),
  ]);
  assert.match(page, /SPECTROGRAM_EXACT_INPUT_BUDGET_BYTES/);
  assert.doesNotMatch(page, /spectrogramCanUseExactSamples/);
  assert.match(page, /setExactSpectrogramSignal/);
  assert.match(page, /requestedChannels\.map\(\(\{ sourceIndex \}\) => sourceIndex\)/);
  assert.match(page, /channelSelectionActive[\s\S]*?display\.data\.map\(\(_, index\) => index\)/);
  assert.match(page, /exact\?\.data \?\? display\.data\[displayIndex\]/);
  assert.match(page, /`All enabled channels \(\$\{spectrogramSignals\.length\}\)`/);
  assert.match(panelResizeSection(page), /computeAverageSpectrogramOffThread/);
  assert.match(page, /viewer\.clientHeight - fixedSiblingHeight/);
  assert.doesNotMatch(page, /viewer\.clientHeight - waveformMinimumHeight/);
  assert.match(css, /\.signal-and-tracks\.with-spectrogram \.waveform-wrap\s*\{\s*min-height:\s*0;/);
  assert.match(panelResizeSection(page), /resize\.startHeight - \(event\.clientY - resize\.startY\)/);
});

test("keeps spectrogram bins aligned with continuous horizontal panning", async () => {
  const page = await readFile(projectFile("app/page.tsx"), "utf8");
  const panel = panelResizeSection(page);

  assert.match(page, /signals=\{spectrogramSignals\}/, "the panel receives the selected or all-channel signal set");
  assert.match(panel, /retainedSpectrumMatchesSignal/, "the previous result stays visible while its replacement is computing");
  assert.match(panel, /centerTime\s*=\s*spectrumDataStart\s*\+\s*spectrum\.times\[frame\]/, "each frame keeps its absolute recording time");
  assert.match(panel, /rawLeft\s*=\s*plotLeft\s*\+\s*\(\(frameStart\s*-\s*viewStart\)\s*\/\s*viewDuration\)/, "panning reprojects cached frames into the live viewport");
  assert.doesNotMatch(panel, /frame\s*\/\s*spectrum\.frames/, "cached frames are not stretched back across every new viewport");
});

test("lets Escape leave spectrogram focus and return to all enabled channels", async () => {
  const page = await readFile(projectFile("app/page.tsx"), "utf8");
  const panel = panelResizeSection(page);
  assert.match(page, /event\.key === "Escape"[\s\S]*?setChannelSelectionActive\(false\)/);
  assert.match(page, /const spectrogramChannelIndices = useMemo\(\(\) => channelSelectionActive[\s\S]*?: display\.data\.map/);
  const localEscape = panel.indexOf('if (key === "escape")');
  const stopPropagation = panel.indexOf("event.stopPropagation()", localEscape);
  assert.ok(localEscape >= 0 && stopPropagation > localEscape, "Escape is handled before propagation is stopped");
  assert.match(panel.slice(localEscape, stopPropagation), /return;/, "Escape bubbles to the global selection clearer");
});

function panelResizeSection(page) {
  const start = page.indexOf("function SpectrogramPanel");
  const end = page.indexOf("type FileStructureNode", start);
  return page.slice(start, end);
}
