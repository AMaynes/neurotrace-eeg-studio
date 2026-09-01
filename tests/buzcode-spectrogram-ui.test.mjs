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
  assert.match(panel, /action === "zoom"/);
  assert.match(panel, /viewDuration \* 0\.15/);
  assert.match(panel, /value \+ 10/);
  assert.match(panel, /colorLimitShift/);
  assert.match(panel, /double-right reset/i);
  assert.equal((panel.match(/SPECTROGRAM_DRAG_PAN_SCALE/g) ?? []).length, 2);
  assert.match(page, /event\.deltaY > 0 \? 1\.25 : 0\.75/);
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

function panelResizeSection(page) {
  const start = page.indexOf("function SpectrogramPanel");
  const end = page.indexOf("type FileStructureNode", start);
  return page.slice(start, end);
}
