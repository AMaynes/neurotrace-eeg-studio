import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { buildMontage, displayElectrodeGroup, orderElectrodeChannelIndices } from "../app/eeg-core.ts";
import { buildChannelRowLayout, channelRowFromFraction, ELECTRODE_GROUP_GAP_ROWS, orderElectrodeDisplayRows } from "../app/channel-layout.ts";

function displayRows(labels) {
  return {
    labels,
    data: labels.map((_, index) => new Float32Array([index * 10, index * 10 + 1])),
    traceBaselines: labels.map((_, index) => index * 2),
    envelopes: labels.map((_, index) => ({ minima: new Float32Array([index]) })),
    sampleRates: labels.map((_, index) => 100 + index),
    sourceSampleRates: labels.map((_, index) => 1000 + index),
    startSecs: labels.map((_, index) => index / 1000),
    units: labels.map((_, index) => `unit${index}`),
    sourceIndices: labels.map((_, index) => [index]),
    primarySourceIndices: labels.map((_, index) => index),
    warnings: ["preserved"], viewStart: 17, flatlineRegions: [],
  };
}

test("electrode groups are contiguous and contacts use numeric order rather than acquisition order", () => {
  const labels = ["RHB10", "RHA2", "LA10", "RHB6", "RHC1", "RHB2", "LA2", "RHA1", "X35", "DC01", "Events", "EKG"];
  const order = orderElectrodeChannelIndices(labels);
  assert.deepEqual(order.map((index) => labels[index]), ["LA2", "LA10", "RHA1", "RHA2", "RHB2", "RHB6", "RHB10", "RHC1", "X35", "DC01", "Events", "EKG"]);
  assert.equal(new Set(order).size, labels.length, "no source channel disappears or duplicates");
  const sorted = order.map((index) => labels[index]);
  const groups = sorted.map(displayElectrodeGroup).filter((group, index, values) => group !== values[index - 1]);
  assert.equal(new Set(groups).size, groups.length, "no repeated blocks of the same electrode");
});

test("display ordering supports CAR, bipolar, case variants, leading zeroes, and stable duplicates", () => {
  assert.deepEqual(orderElectrodeChannelIndices(["ra10 (CAR)", "RA2 (CAR)", "RA02 (CAR)", "RA1 (CAR)"]), [3, 1, 2, 0]);
  assert.deepEqual(orderElectrodeChannelIndices(["RB10-11", "RA2-3", "RB2-3", "RA1-2"]), [3, 1, 2, 0]);
  assert.deepEqual(orderElectrodeChannelIndices(["Events", "EKG", "DC01"]), [0, 1, 2]);
  assert.equal(displayElectrodeGroup("rha2 (CAR)"), "RHA");
  assert.equal(displayElectrodeGroup("RHA2-3"), "RHA");
  assert.equal(displayElectrodeGroup("ECG1"), null);
});

test("display-only sorting keeps every waveform and metadata field attached to its source", () => {
  const original = displayRows(["RB10", "LA3", "RB2", "LA1", "Events"]);
  const sorted = orderElectrodeDisplayRows(original);
  assert.deepEqual(sorted.labels, ["LA1", "LA3", "RB2", "RB10", "Events"]);
  for (const [row, sourceIndex] of sorted.primarySourceIndices.entries()) {
    for (const field of ["labels", "data", "traceBaselines", "envelopes", "sampleRates", "sourceSampleRates", "startSecs", "units", "sourceIndices"]) {
      assert.equal(sorted[field][row], original[field][sourceIndex], `${field} must follow the same channel`);
    }
  }
  assert.deepEqual(original.labels, ["RB10", "LA3", "RB2", "LA1", "Events"]);
  assert.equal(sorted.warnings, original.warnings);
  assert.equal(sorted.viewStart, 17);
  assert.equal(sorted.flatlineRegions, original.flatlineRegions);
  assert.throws(() => orderElectrodeDisplayRows({ ...original, units: [] }), /metadata does not match/);
});

test("sorting derived display rows does not recalculate bipolar pairs or reverse polarity", () => {
  const labels = ["RHB10", "RHA2", "RHB6", "RHA1", "RHB2"];
  const source = labels.map((_, index) => new Float32Array([index * 100, index * 100 + 2]));
  const montage = buildMontage(source, labels, "bipolar");
  const original = { ...displayRows(montage.labels), data: montage.data, sourceIndices: montage.sourceIndices, primarySourceIndices: montage.primarySourceIndices };
  const sorted = orderElectrodeDisplayRows(original);
  assert.deepEqual(sorted.labels, ["RHA2-1", "RHB6-2", "RHB10-6"]);
  for (const [row, label] of sorted.labels.entries()) {
    const before = montage.labels.indexOf(label);
    assert.equal(sorted.data[row], montage.data[before]);
    assert.equal(sorted.sourceIndices[row], montage.sourceIndices[before]);
    assert.equal(sorted.primarySourceIndices[row], montage.primarySourceIndices[before]);
  }
});

test("tiny electrode gaps have aligned CSS tracks, waveform positions, and non-channel hit regions", () => {
  const labels = ["LA1", "LA2", "RB1", "RB2", "Events"];
  const layout = buildChannelRowLayout(labels, true);
  assert.equal(ELECTRODE_GROUP_GAP_ROWS, 0.12);
  assert.ok(Math.abs(layout.totalUnits - 5.24) < 1e-12);
  assert.deepEqual([...layout.groupStarts], [2, 4]);
  assert.deepEqual(layout.rowGridLines, [1, 2, 4, 5, 7]);
  assert.equal(layout.gridTemplateRows, "1fr 1fr 0.12fr 1fr 1fr 0.12fr 1fr");
  const tracks = layout.gridTemplateRows.split(" ").map(Number.parseFloat);
  for (const [row, line] of layout.rowGridLines.entries()) {
    const trackStart = tracks.slice(0, line - 1).reduce((sum, height) => sum + height, 0);
    assert.ok(Math.abs(trackStart - layout.rowStartUnits[row]) < 1e-12);
    assert.equal(channelRowFromFraction(layout, (trackStart + 0.5) / layout.totalUnits), row);
    if (layout.groupStarts.has(row)) {
      assert.equal(channelRowFromFraction(layout, (trackStart - ELECTRODE_GROUP_GAP_ROWS / 2) / layout.totalUnits), null);
    }
  }
  assert.equal(channelRowFromFraction(layout, -0.1), null);
  assert.equal(channelRowFromFraction(layout, 1), null);
  assert.equal(channelRowFromFraction(layout, NaN), null);
});

test("CAR and bipolar views share electrode gaps; ordinary layouts have no group spacing", () => {
  for (const labels of [["LA1 (CAR)", "LA2 (CAR)", "RA1 (CAR)"], ["LA1-2", "LA2-3", "RA1-2"]]) {
    assert.deepEqual([...buildChannelRowLayout(labels, true).groupStarts], [2]);
    const ordinary = buildChannelRowLayout(labels, false);
    assert.deepEqual(ordinary.rowStartUnits, [0, 1, 2]);
    assert.deepEqual(ordinary.rowGridLines, [1, 2, 3]);
    assert.equal(ordinary.totalUnits, 3);
  }
  assert.equal(buildChannelRowLayout([], true).totalUnits, 1);
});

test("viewer sorts all three trace paths after derivation and uses thick dividers with fractional grid tracks", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.equal(page.match(/setDisplay\(matlabAnatomicalLayout \? orderElectrodeDisplayRows\(nextDisplay\) : nextDisplay\)/g)?.length, 3);
  assert.match(page, /const indices = matlabAnatomicalLayout && montage !== "referential"/);
  assert.match(page, /gridTemplateRows: channelRowLayout\.gridTemplateRows/);
  assert.match(page, /gridRow: `\$\{channelRowLayout\.rowGridLines\[channel\]\}/);
  assert.match(page, /groupStarts\.has\(channel\)[\s\S]*?context\.lineWidth = 2;[\s\S]*?context\.restore\(\)/);
  assert.match(css, /button\.group-start \{ border-top: 2px/);
});
