import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { buildMontage, applyDisplayFilters, isObviousAuxiliaryChannel } from "../app/eeg-core.ts";

test("average reference never includes auxiliary signals, even if they outnumber EEG or share µV units", () => {
  const labels = ["ECG1", "LA1", "misc DC03", "LA2", "EOG2", "TRIG1"];
  const units = ["µV", "µV", "NA", "µV", "µV", "NA"];
  const data = labels.map((_, row) => new Float64Array([row * 10, row * 100, NaN]));
  const copy = structuredClone(data);
  const options = { channelUnits: units };
  for (const mode of ["average", "average-reference"]) {
    const result = buildMontage(data, labels, mode, new Set(), labels.map(() => 200), labels.map(() => 1), options);
    assert.deepEqual(result.labels, ["LA1 (CAR)", "LA2 (CAR)"]);
    assert.deepEqual(result.data.map((values) => [...values]), [[-10, -100, NaN], [10, 100, NaN]]);
    assert.deepEqual(result.sourceIndices, [[1, 3], [1, 3]]);
    assert.deepEqual(result.primarySourceIndices, [1, 3]);
    assert.deepEqual(result.warnings, []);
  }
  const raw = buildMontage(data, labels, "referential", new Set(), undefined, undefined, options);
  assert.deepEqual(raw.labels, labels);
  raw.data.forEach((values, i) => assert.equal(values, data[i]));
  assert.deepEqual(data, copy, "all source arrays remain unchanged");
});

test("CAR unit safety applies inside the montage engine, not only in one UI branch", () => {
  const data = [10, 20, 1000, 2000, 3000].map((value) => new Float64Array([value]));
  const result = buildMontage(data, ["LA1", "LA2", "LB1", "LB2", "LB3"], "average", new Set(),
    undefined, undefined, { channelUnits: ["µV", "µV", "ADC counts", "ADC counts", "ADC counts"] });
  assert.deepEqual(result.data.map((values) => [...values]), [[-5], [5]]);
  assert.deepEqual(result.sourceIndices, [[0, 1], [0, 1]]);
  assert.match(result.warnings.join(" "), /incompatible physical units.*LB1, LB2, LB3/);
  const none = buildMontage(data.slice(0, 2), ["ECG1", "EOG1"], "average");
  assert.deepEqual(none.data, []);
  assert.match(none.warnings.join(" "), /No compatible channels/);
});

test("bipolar unit checks are local to each pair; an unrelated unit majority cannot discard valid pairs", () => {
  const result = buildMontage([2, 7, 100, 130].map((value) => new Float64Array([value])),
    ["LA1", "LA2", "LB1", "LB2"], "bipolar", new Set(), [200, 200, 200, 200], [0, 0, 0, 0],
    { channelUnits: ["µV", "µV", "ADC counts", "ADC counts"] });
  assert.deepEqual(result.labels, ["LA1-2", "LB1-2"]);
  assert.deepEqual(result.data.map((values) => [...values]), [[5], [30]]);
  assert.deepEqual(result.warnings, []);
});

test("custom filters plus CAR use EEG alone and never mutate input samples", () => {
  const labels = ["LA1", "ECG1", "LA2", "misc DC03"];
  const raw = labels.map((_, row) => Float32Array.from({ length: 2000 }, (_, n) =>
    1000 * row + (row + 1) * Math.sin(n * .1) + Math.cos(n * .9)));
  const before = structuredClone(raw);
  const filtered = applyDisplayFilters(raw, [200, 200, 200, 200], { enabled: true, highPassHz: 1, lowPassHz: 40, notchHz: 60 });
  const derived = buildMontage(filtered, labels, "average", new Set(), [200, 200, 200, 200], [0, 0, 0, 0],
    { channelUnits: ["µV", "µV", "µV", "NA"] });
  assert.deepEqual(derived.labels, ["LA1 (CAR)", "LA2 (CAR)"]);
  assert.deepEqual(derived.warnings, []);
  for (let n = 0; n < 2000; n++) {
    const mean = (filtered[0][n] + filtered[2][n]) / 2;
    assert.equal(derived.data[0][n], Math.fround(filtered[0][n] - mean));
    assert.equal(derived.data[1][n], Math.fround(filtered[2][n] - mean));
  }
  assert.deepEqual(raw, before);
});

test("numbered auxiliary names are recognized without excluding scalp or depth contacts", () => {
  for (const label of ["ECG1", "EEG EOG2-REF", "EMG12", "AUX3", "TRIG1", "MARK2", "SYNC1", "GND1", "DC03"]) {
    assert.equal(isObviousAuxiliaryChannel(label), true, label);
  }
  for (const label of ["eeg C3", "F3", "LA1", "RA2", "ECGX1", "DCX1", "A1", "M1"]) {
    assert.equal(isObviousAuxiliaryChannel(label), false, label);
  }
});

test("custom-filter UI delegates unit safety to the same montage engine as exact views", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const start = page.indexOf("const croppedStartSecs: number[] = [];");
  const end = page.indexOf("publishDisplay(nextDisplay);", start);
  const path = page.slice(start, end);
  assert.match(path, /buildMontage\([\s\S]*channelUnits: rawWindow.channelUnits/);
  assert.match(path, /warnings: montageResult.warnings/);
  assert.doesNotMatch(path, /unitCounts|referenceUnit|montageWarnings/);
});
