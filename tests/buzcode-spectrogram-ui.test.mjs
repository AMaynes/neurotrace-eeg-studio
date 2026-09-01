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
  assert.doesNotMatch(panel, /action === "zoom"|onZoom|zoomSelection|Zoom mode/);
  assert.match(panel, /viewDuration \* 0\.15/);
  assert.match(panel, /value \+ 10/);
  assert.match(panel, /colorLimitShift/);
  assert.match(panel, /waveform controls own zoom/i);
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
  assert.match(page, /source\.getWindow\(signalViewStart, timebase, \[sourceIndex\]/);
  assert.match(page, /matchingExactSpectrogramSignal\?\.data \?\? display\.data\[focusedChannel\]/);
  assert.match(page, /viewer\.clientHeight - fixedSiblingHeight/);
  assert.doesNotMatch(page, /viewer\.clientHeight - waveformMinimumHeight/);
  assert.match(css, /\.signal-and-tracks\.with-spectrogram \.waveform-wrap\s*\{\s*min-height:\s*0;/);
  assert.match(panelResizeSection(page), /resize\.startHeight - \(event\.clientY - resize\.startY\)/);
});

test("keeps spectrogram bins aligned with continuous horizontal panning", async () => {
  const page = await readFile(projectFile("app/page.tsx"), "utf8");
  const panel = panelResizeSection(page);

  assert.match(page, /dataStart=\{spectrogramDataStart\}/, "the panel receives the actual start time of its signal data");
  assert.match(page, /signalKey=\{spectrogramSignalKey\}/, "cached results are retained only for the same displayed signal");
  assert.match(panel, /retainedSpectrumMatchesSignal/, "the previous result stays visible while its replacement is computing");
  assert.match(panel, /centerTime\s*=\s*spectrumDataStart\s*\+\s*spectrum\.times\[frame\]/, "each frame keeps its absolute recording time");
  assert.match(panel, /rawLeft\s*=\s*plotLeft\s*\+\s*\(\(frameStart\s*-\s*viewStart\)\s*\/\s*viewDuration\)/, "panning reprojects cached frames into the live viewport");
  assert.doesNotMatch(panel, /frame\s*\/\s*spectrum\.frames/, "cached frames are not stretched back across every new viewport");
});

function panelResizeSection(page) {
  const start = page.indexOf("function SpectrogramPanel");
  const end = page.indexOf("type FileStructureNode", start);
  return page.slice(start, end);
}
