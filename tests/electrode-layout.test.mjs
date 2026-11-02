import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { buildMontage, displayElectrodeGroup, orderElectrodeChannelIndices } from "../app/eeg-core.ts";
import { buildChannelRowLayout, channelRowFromFraction, ELECTRODE_GROUP_GAP_ROWS, orderElectrodeDisplayRows, matlabDisplayOrder, orderMatlabDisplayRows, remapDisplayFocus } from "../app/channel-layout.ts";

function displayRows(labels) {
  return {
    labels,
    data: labels.map((_, index) => new Float32Array([index * 10, index * 10 + 1])),
    traceBaselines: labels.map((_, index) => index * 2),
    envelopes: labels.map((_, index) => ({ minima: new Float32Array([index]) })),
    sampleRates: labels.map((_, index) => 100 + index),
    sourceSampleRates: labels.map((_, index) => 1000 + index),
    sourceStartSampleIndices: labels.map((_, index) => 1234 + index),
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
    for (const field of ["labels", "data", "traceBaselines", "envelopes", "sampleRates", "sourceSampleRates", "sourceStartSampleIndices", "startSecs", "units", "sourceIndices"]) {
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

test("equal-height sections retain padded gaps with aligned CSS tracks, waveform positions, and hit regions", () => {
  const labels = ["LA1", "LA2", "RB1", "RB2", "Events"];
  const layout = buildChannelRowLayout(labels, true);
  assert.equal(ELECTRODE_GROUP_GAP_ROWS, 4);
  assert.equal(layout.totalUnits, 18);
  assert.deepEqual([...layout.groupStarts], [2, 4]);
  assert.deepEqual(layout.rowGridLines, [2, 3, 6, 7, 10]);
  assert.equal(layout.gridTemplateRows, "2fr 1fr 1fr 2fr 2fr 1fr 1fr 2fr 2.5fr 1fr 2.5fr");
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

test("viewer groups prepared rows independently from waveform processing and shares grid geometry", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.equal(page.match(/publishDisplay\(nextDisplay\)/g)?.length, 4);
  assert.match(page, /const publishDisplay = \(next: DisplayWindow\) => \{[\s\S]*?centerDisplayWindow\(next\)[\s\S]*?setDisplay\(centered\)/);
  assert.match(page, /const display = useMemo\(\(\) => anatomicalGroups \? orderMatlabDisplayRows\(preparedDisplay\) : preparedDisplay/);
  assert.match(page, /const indices = matlabAnatomicalLayout && montage !== "referential"/);
  assert.match(page, /gridTemplateRows: channelRowLayout\.gridTemplateRows/);
  assert.match(page, /gridRow: `\$\{channelRowLayout\.rowGridLines\[channel\]\}/);
  assert.match(page, /groupStarts\.has\(channel\)[\s\S]*?context\.lineWidth = 2;[\s\S]*?context\.restore\(\)/);
  assert.match(css, /button\.group-start \{ border-top: 2px/);
});

test("MATLAB groups retain acquisition order, first-occurrence group order and case identity", () => {
  const labels = ["RHB10", "RHA2", "LA10", "RHB6", "LA2", "RHA1", "X35", "la4", "DC01", "Events", "EKG"];
  assert.deepEqual(matlabDisplayOrder(labels).map((index) => labels[index]), ["LA10", "LA2", "la4", "RHB10", "RHB6", "RHA2", "RHA1", "X35"]);
  const excluded = ["DC", "MARK", "E", "C", "EX", "F", "REF", "GND", "ECG", "EKG", "EMG", "EOG", "TRIG", "SYNC", "AUX", "STI"].map((group) => `${group.toLowerCase()}1`);
  const invalid = [...excluded, "A-1", "EEG LA1", "No digits", "1LA", "LA1a"];
  assert.deepEqual(matlabDisplayOrder([...invalid, " LA01 "]), [invalid.length]);
  assert.deepEqual(matlabDisplayOrder(invalid), invalid.map((_, index) => index), "no recognized group falls back to all channels");
  assert.deepEqual(buildChannelRowLayout(invalid, true).groups, []);
});

test("MATLAB labels use one shared group label, ordinal contacts, and actual bipolar pair numbers", () => {
  const layout = buildChannelRowLayout(["LA10", "LA2", "RB6", "RB1", "RB3"], true);
  assert.deepEqual(layout.groups, [{ name: "LA", startRow: 0, endRow: 1 }, { name: "RB", startRow: 2, endRow: 4 }]);
  assert.deepEqual(layout.contactLabels, ["1", "2", "1", "2", "3"]);
  assert.deepEqual(layout.rowStartUnits, [2.5, 3.5, 9, 10, 11]);
  assert.deepEqual(buildChannelRowLayout(["LA10-2", "RB6-1", "RB1-3"], true).contactLabels, ["10-2", "6-1", "1-3"]);
  assert.deepEqual(buildChannelRowLayout(["LA10 (CAR)", "LA2 (CAR)", "RB1 (CAR)"], true).contactLabels, ["1", "2", "1"]);
});

test("unequal groups have evenly spaced centers, equal row heights, and reserved outer and inner padding", () => {
  for (const counts of [[1], [3], [1, 6, 2], [5, 1, 3, 2], [2, 2, 2]]) {
    const labels = counts.flatMap((count, group) => Array.from({ length: count }, (_, row) => `${String.fromCharCode(76 + group)}A${row + 1}`));
    const layout = buildChannelRowLayout(labels, true);
    assert.equal(layout.groups.length, counts.length);
    for (const [index, group] of layout.groups.entries()) {
      const first = layout.rowStartUnits[group.startRow];
      const end = layout.rowStartUnits[group.endRow] + 1;
      const center = (first + end) / (2 * layout.totalUnits);
      assert.ok(Math.abs(center - (index + .5) / counts.length) < 1e-12, "each contact block is centered in its equal-height section");
      const sectionStart = index * layout.totalUnits / counts.length;
      const sectionEnd = (index + 1) * layout.totalUnits / counts.length;
      assert.equal(first - sectionStart, sectionEnd - end, "balanced padding above and below every group");
      assert.ok(first - sectionStart >= 2, "padding remains even for the largest group");
      for (let row = group.startRow; row < group.endRow; row++) assert.equal(layout.rowStartUnits[row + 1] - layout.rowStartUnits[row], 1);
    }
    for (let unit = 0; unit < layout.totalUnits; unit += .25) {
      const expected = layout.rowStartUnits.findIndex((start) => unit >= start && unit < start + 1);
      assert.equal(channelRowFromFraction(layout, unit / layout.totalUnits), expected < 0 ? null : expected);
    }
  }
});

test("group centers and reserved padding persist through recorded, CAR and bipolar layouts", () => {
  const layouts = [
    ["LA1", "LA2", "LA3", "RA1", "RA2"],
    ["LA1 (CAR)", "LA2 (CAR)", "LA3 (CAR)", "RA1 (CAR)", "RA2 (CAR)"],
    ["LA1-2", "LA2-3", "RA1-2"],
  ].map((labels) => buildChannelRowLayout(labels, true));
  for (const layout of layouts) {
    assert.deepEqual(layout.groups.map(({ startRow, endRow }) =>
      (layout.rowStartUnits[startRow] + layout.rowStartUnits[endRow] + 1) / (2 * layout.totalUnits)), [.25, .75]);
    assert.equal(channelRowFromFraction(layout, 0), null);
    assert.equal(channelRowFromFraction(layout, .5), null);
    assert.equal(channelRowFromFraction(layout, .999), null);
  }
});

test("MATLAB grouping keeps every row field, sample, calibration, timing, and source identity together", () => {
  const original = displayRows(["RB10", "LA3", "RB2", "LA1", "Events"]);
  const sorted = orderMatlabDisplayRows(original);
  assert.deepEqual(sorted.labels, ["LA3", "LA1", "RB10", "RB2"]);
  for (const [row, sourceIndex] of sorted.primarySourceIndices.entries()) {
    for (const field of ["labels", "data", "traceBaselines", "envelopes", "sampleRates", "sourceSampleRates", "sourceStartSampleIndices", "startSecs", "units", "sourceIndices"]) {
      assert.equal(sorted[field][row], original[field][sourceIndex], field);
    }
    assert.equal(remapDisplayFocus(original, sorted, sourceIndex), row);
    assert.equal(remapDisplayFocus(sorted, original, row), sourceIndex);
  }
  assert.equal(remapDisplayFocus(original, sorted, 4), -1, "hidden auxiliary is not silently mapped to another source");
  assert.deepEqual(original.labels, ["RB10", "LA3", "RB2", "LA1", "Events"]);
  assert.equal(sorted.warnings, original.warnings);
  assert.equal(sorted.flatlineRegions, original.flatlineRegions);
  assert.throws(() => orderMatlabDisplayRows({ ...original, units: [] }), /metadata does not match/);
});

test("grouping each montage preserves existing signals and acquisition-order bipolar polarity", () => {
  const labels = ["RHB10", "RHA2", "LA3", "RHB6", "LA1", "RHA1", "RHB2"];
  const source = labels.map((_, index) => new Float32Array([index * 100, index * 100 + 2]));
  for (const mode of ["referential", "average", "bipolar"]) {
    const montage = buildMontage(source, labels, mode);
    const original = { ...displayRows(montage.labels), data: montage.data, sourceIndices: montage.sourceIndices, primarySourceIndices: montage.primarySourceIndices };
    const grouped = orderMatlabDisplayRows(original);
    for (const [row, label] of grouped.labels.entries()) {
      const before = montage.labels.indexOf(label);
      assert.equal(grouped.data[row], montage.data[before]);
      assert.equal(grouped.sourceIndices[row], montage.sourceIndices[before]);
    }
    if (mode === "bipolar") {
      assert.deepEqual(grouped.labels, ["LA3-1", "RHB10-6", "RHB6-2", "RHA2-1"]);
      assert.deepEqual(grouped.data.map((row) => row[0]), [200, 300, 300, 400]);
    }
  }
});
