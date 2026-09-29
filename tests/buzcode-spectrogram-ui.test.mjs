import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectFile = (path) => new URL(`../${path}`, import.meta.url);

test("exposes MATLAB wavelet processing with linked navigation and frequency/color controls", async () => {
  const page = await readFile(projectFile("app/page.tsx"), "utf8");
  const start = page.indexOf("function SpectrogramPanel");
  const end = page.indexOf("type FileStructureNode", start);
  const panel = page.slice(start, end);
  assert.match(panel, /computeMatlabSpectrogramOffThread/);
  assert.match(panel, /baselineTime/);
  assert.match(panel, /rasterizeMatlabSpectrogram/);
  assert.match(panel, /Wavelet Z-score/);
  assert.doesNotMatch(panel, /BUZCODE_DEFAULT_SMOOTHING_SECONDS|BUZCODE_SMOOTHING_OPTIONS|thetaRatioOverlay|DPSS|Whitening/);
  assert.doesNotMatch(panel, /Frequency resize mode|>F<|>FREQ</);
  const browseButton = panel.indexOf('aria-label="Browse spectrogram"');
  const boxZoomButton = panel.indexOf('aria-label="Box zoom spectrogram"');
  const frequencyRange = panel.indexOf('aria-label="Displayed frequency range"');
  assert.ok(browseButton >= 0, "the browse tool is available");
  assert.ok(boxZoomButton > browseButton, "box zoom sits immediately after browse");
  assert.ok(frequencyRange > boxZoomButton, "frequency controls follow the navigation tools");
  assert.match(panel, /useState<SpectrogramTool>\("browse"\)/);
  assert.match(panel, /timeRange = \{ start: Math\.min\(startTime, endTime\), end: Math\.max\(startTime, endTime\) \}/);
  assert.match(panel, /nextFrequencyRange = \{ min: nextMinimumHz, max: nextMaximumHz \}/);
  assert.match(panel, /onZoom\(timeRange, nextFrequencyRange\)/, "both axes are committed together for undo");
  assert.match(panel, /className="spectrogram-zoom-box"/);
  assert.match(page, /zoomToTimeRange\(range\.start, range\.end, frequencyRange \? \{ frequencyRange \} : \{\}\)/);
  assert.match(panel, /role="group" aria-label="Displayed frequency range"/);
  assert.match(panel, /aria-label="Lower maximum displayed frequency"/);
  assert.match(panel, /aria-label="Raise maximum displayed frequency"/);
  assert.match(panel, /aria-label="Reset displayed frequency range"/);
  assert.match(panel, /<output aria-live="polite">\{Math\.round\(effectiveDisplayMinHz\)\}–\{Math\.round\(effectiveDisplayMaxHz\)\} Hz<\/output>/);
  assert.match(panel, /viewDuration \* 0\.15/);
  assert.match(panel, /effectiveDisplayMaxHz \+ 10/);
  assert.match(panel, /colorLimitShift/);
  const tutorials = await readFile(projectFile("app/tutorials.ts"), "utf8");
  assert.match(panel, /onClick=\{onHelp\} aria-label="Open spectrogram tutorials"/);
  assert.match(tutorials, /Select Z, just to the right of B/);
  assert.match(tutorials, /Frequency range controls the visible Hz band/i);
  assert.match(tutorials, /increase Window in the waveform toolbar/i);
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
  assert.match(page, /matlabSpectrogramInputPlan\(meta, display\.primarySourceIndices\[focusedChannel\], signalViewStart, timebase, anchor\)/);
  assert.match(page, /readMatlabSourceWindow\(source, plan\.readStart, plan\.readDuration, plan\.sourceIndices/);
  assert.match(page, /data: exact\?\.data,/);
  assert.doesNotMatch(page, /data: exact\?\.data \?\? display\.data/);
  assert.match(page, /const spectrogramLabel = spectrogramInputPlan\.plan\?\.label/);
  assert.match(page, /baselineTime=\{spectrogramInputPlan\.plan\?\.baselineTime/);
  assert.match(panelResizeSection(page), /computeMatlabSpectrogramOffThread/);
  assert.doesNotMatch(panelResizeSection(page), /computeAverageSpectrogramOffThread/);
  assert.match(page, /viewer\.clientHeight - fixedSiblingHeight/);
  assert.doesNotMatch(page, /viewer\.clientHeight - waveformMinimumHeight/);
  assert.match(css, /\.signal-and-tracks\.with-spectrogram \.waveform-wrap\s*\{\s*min-height:\s*0;/);
  assert.match(panelResizeSection(page), /resize\.startHeight - \(event\.clientY - resize\.startY\)/);
});

test("keeps spectrogram bins aligned with continuous horizontal panning", async () => {
  const page = await readFile(projectFile("app/page.tsx"), "utf8");
  const panel = panelResizeSection(page);

  assert.match(page, /signals=\{spectrogramSignals\}/, "the panel receives exact raw group inputs");
  assert.match(panel, /spectrumState\.signals === signals && spectrumState\.baselineTime === baselineTime/,
    "a previous window or baseline is never shown as the new result");
  const raster = page.slice(page.indexOf("function rasterizeMatlabSpectrogram"), page.indexOf("function SpectrogramPanel"));
  assert.match(raster, /firstTime = spectrum\.dataStart \+ \(spectrum\.times\[0\] \?\? 0\)/);
  assert.match(raster, /time = viewStart \+ \(\(x \+ \.5\) \/ width\) \* viewDuration/);
  assert.match(raster, /sample = Math\.round\(\(time - firstTime\) \/ timeStep\)/);
  assert.match(raster, /sample >= 0 && sample < spectrum\.width/,
    "outside the cropped analysis interval stays blank rather than copying boundary samples");
});

test("lets Escape clear spectrogram interaction without substituting a different analysis recipe", async () => {
  const page = await readFile(projectFile("app/page.tsx"), "utf8");
  const panel = panelResizeSection(page);
  assert.match(page, /event\.key === "Escape"[\s\S]*?setChannelSelectionActive\(false\)/);
  assert.match(page, /matlabSpectrogramInputPlan\(meta, display\.primarySourceIndices\[focusedChannel\]/);
  assert.doesNotMatch(page, /const spectrogramChannelIndices = useMemo/);
  const localEscape = panel.indexOf('if (matchesShortcut(event, controlBindings, "clear"))');
  const stopPropagation = panel.indexOf("event.stopPropagation()", localEscape);
  assert.ok(localEscape >= 0 && stopPropagation > localEscape, "Escape is handled before propagation is stopped");
  assert.match(panel.slice(localEscape, stopPropagation), /return;/, "Escape bubbles to the global selection clearer");
});

function panelResizeSection(page) {
  const start = page.indexOf("function SpectrogramPanel");
  const end = page.indexOf("type FileStructureNode", start);
  return page.slice(start, end);
}

test("matches the waveform plotting bounds after resizing and channel scrollbar changes", async () => {
  const page = await readFile(projectFile("app/page.tsx"), "utf8");
  const panel = panelResizeSection(page);
  assert.match(page, /waveformCanvasRef=\{canvasRef\}/);
  assert.match(page, /const SPECTROGRAM_PLOT_LEFT = 0;/);
  assert.match(page, /const SPECTROGRAM_PLOT_RIGHT = 0;/);
  assert.match(panel, /observer\.observe\(waveform\)/);
  assert.match(panel, /observer\.observe\(panel\)/);
  assert.match(panel, /className="spectrogram-frequency-axis"/, "frequency labels occupy the rail, not the time plot");
  assert.doesNotMatch(panel, /\.width - 51/, "pan release uses the same bounds as dragging");

  // Exercise the actual sizing callback with fractional pixels and scrollbar gutters.
  const callback = panel.match(/const alignTimePlot = \(\) => \{([\s\S]*?)\n    \};/);
  assert.ok(callback);
  const align = new Function("waveform", "panel", callback[1]);
  for (const [left, width, gutter] of [[0, 900, 0], [235.5, 720.25, 8], [51.25, 1440.5, 15], [0, 320, 0]]) {
    const waveformRect = { left: left + 70, width: width - 70 - gutter };
    const spectrogram = { getBoundingClientRect: () => ({ left, width }), style: {} };
    align({ getBoundingClientRect: () => waveformRect }, spectrogram);
    const [rail, plot] = spectrogram.style.gridTemplateColumns.split(" ").map(parseFloat);
    assert.equal(rail, 70);
    assert.equal(plot, waveformRect.width);
    for (const ratio of [0, 0.15, 0.5, 0.85, 1]) {
      assert.equal(left + rail + ratio * plot, waveformRect.left + ratio * waveformRect.width);
    }
  }
});
