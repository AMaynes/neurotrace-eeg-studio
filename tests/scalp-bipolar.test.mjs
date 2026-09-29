import assert from "node:assert/strict";
import test from "node:test";
import { buildMontage } from "../app/eeg-core.ts";
import { bipolarMontageKind, bipolarMontageLabel, canonicalScalpElectrode } from "../app/bipolar-montage.ts";

// Complete public label catalog from the reported EDF; no recording samples.
const EDF_LABELS = [
  "eeg Fp1", "eeg Fp2", "eeg F3", "eeg F4", "eeg C3", "eeg C4", "eeg P3", "eeg P4", "eeg O1", "eeg O2",
  "eeg F7", "eeg F8", "eeg T7", "eeg T8", "eeg P7", "eeg P8", "eeg Fz", "eeg Cz", "eeg Pz", "eeg E",
  "eeg Pg1", "eeg Pg2", "eeg M1", "eeg M2", "eeg T1", "eeg T2", "bio X1", "bio X2", "bio X3", "bio X4",
  "eeg ABD", "bio X6", "bio X7", "eeg SpO2", "eeg EtCO2", "misc DC03", "misc DC04", "misc DC05", "misc DC06",
  "eeg Pulse", "eeg CO2Wave",
];
const EXPECTED_PAIRS = [
  [0, 10, "Fp1-F7"], [10, 12, "F7-T7"], [12, 14, "T7-P7"], [14, 8, "P7-O1"],
  [1, 11, "Fp2-F8"], [11, 13, "F8-T8"], [13, 15, "T8-P8"], [15, 9, "P8-O2"],
  [0, 2, "Fp1-F3"], [2, 4, "F3-C3"], [4, 6, "C3-P3"], [6, 8, "P3-O1"],
  [1, 3, "Fp2-F4"], [3, 5, "F4-C4"], [5, 7, "C4-P4"], [7, 9, "P4-O2"],
  [16, 17, "Fz-Cz"], [17, 18, "Cz-Pz"],
];
const signals = (labels) => labels.map((_, c) => Float32Array.from({ length: 31 }, (_, n) => (c + 1) * 101 + n * (c + 3)));

test("the reported EDF has 18 explicit longitudinal pairs with exact source provenance and polarity", () => {
  const data = signals(EDF_LABELS);
  const untouched = data.map((channel) => [...channel]);
  const result = buildMontage(data, EDF_LABELS, "bipolar", new Set(), EDF_LABELS.map(() => 200), EDF_LABELS.map(() => 4), { channelUnits: EDF_LABELS.map(() => "µV") });
  assert.equal(bipolarMontageKind(EDF_LABELS), "scalp");
  assert.equal(bipolarMontageLabel(EDF_LABELS), "Longitudinal bipolar");
  assert.deepEqual(result.labels, EXPECTED_PAIRS.map(([, , label]) => label));
  assert.deepEqual(result.sourceIndices, EXPECTED_PAIRS.map(([first, second]) => [first, second]));
  assert.deepEqual(result.primarySourceIndices, EXPECTED_PAIRS.map(([first]) => first));
  assert.deepEqual(result.sampleStartSecs, EXPECTED_PAIRS.map(() => 4));
  EXPECTED_PAIRS.forEach(([first, second], row) => {
    assert.deepEqual([...result.data[row]], [...data[first]].map((sample, n) => sample - data[second][n]));
  });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(data.map((channel) => [...channel]), untouched);
  assert.ok(!result.labels.includes("Fp1-Fp2") && !result.labels.includes("F3-F4"));
});

test("legacy T3/T4/T5/T6 aliases and case match modern temporal channels", () => {
  const labels = EDF_LABELS.map((label) => label.replace("T7", "T3").replace("T8", "T4").replace("P7", "T5").replace("P8", "T6").toUpperCase());
  const result = buildMontage(signals(labels), labels, "bipolar");
  assert.deepEqual(result.labels, EXPECTED_PAIRS.map(([, , label]) => label));
  assert.deepEqual(result.sourceIndices, EXPECTED_PAIRS.map(([first, second]) => [first, second]));
  assert.equal(canonicalScalpElectrode(" EEG  fp1 "), "Fp1");
  for (const label of ["SEEG Fp1", "Fp01", "Fp1-REF", "Fp1-F7", "xFp1", "EEGFp1"]) {
    assert.equal(canonicalScalpElectrode(label), null, label);
  }
});

test("missing and excluded electrodes omit fixed pairs without creating a bridge", () => {
  const kept = EDF_LABELS.map((_, i) => i).filter((i) => i !== 12);
  const labels = kept.map((i) => EDF_LABELS[i]);
  const result = buildMontage(signals(labels), labels, "bipolar", new Set(), undefined, undefined,
    { allChannelLabels: EDF_LABELS, sourceChannelIndices: kept });
  assert.equal(result.labels.length, 16);
  assert.ok(!result.labels.includes("F7-T7") && !result.labels.includes("T7-P7") && !result.labels.includes("F7-P7"));
  assert.match(result.warnings.join(" "), /source channels is not selected/);
  const excluded = buildMontage(signals(EDF_LABELS), EDF_LABELS, "bipolar", new Set([12]));
  assert.deepEqual(excluded.labels, result.labels);
  assert.match(excluded.warnings.join(" "), /excluded/);
});

test("duplicate modern and legacy electrode aliases are ambiguous even if one is hidden", () => {
  const allLabels = [...EDF_LABELS, "T3"];
  const result = buildMontage(signals(EDF_LABELS), EDF_LABELS, "bipolar", new Set(), undefined, undefined,
    { allChannelLabels: allLabels, sourceChannelIndices: EDF_LABELS.map((_, i) => i) });
  assert.equal(result.labels.length, 16);
  assert.ok(!result.labels.includes("F7-T7") && !result.labels.includes("T7-P7"));
  assert.match(result.warnings.join(" "), /Ambiguous scalp electrodes \(T7\)/);
  const duplicateFp1 = buildMontage(signals([...EDF_LABELS, "FP1"]), [...EDF_LABELS, "FP1"], "bipolar");
  assert.ok(!duplicateFp1.labels.includes("Fp1-F7") && !duplicateFp1.labels.includes("Fp1-F3"));
});

test("scalp pairs retain gaps and reject incompatible units, rates, and start times", () => {
  const data = [new Float32Array([10, NaN, 20, 30]), new Float32Array([2, 4, Infinity, 5])];
  const labels = ["eeg Fp1", "eeg F7"];
  const valid = buildMontage(data, labels, "bipolar", new Set(), [200, 200], [4, 4], { channelUnits: ["µV", "µV"] });
  assert.deepEqual([...valid.data[0]], [8, NaN, NaN, 25]);
  assert.deepEqual(valid.sourceIndices, [[0, 1]]);
  for (const [rates, starts, units, warning] of [
    [[200, 100], [4, 4], ["µV", "µV"], /cannot be subtracted without resampling/],
    [[200, 200], [4, 4.005], ["µV", "µV"], /not aligned/],
    [[200, 200], [4, 4], ["µV", "ADC counts"], /different units/],
  ]) {
    const result = buildMontage(data, labels, "bipolar", new Set(), rates, starts, { channelUnits: units });
    assert.equal(result.data.length, 0);
    assert.match(result.warnings.join(" "), warning);
  }
});

test("scalp electrodes never silently enter anatomical numeric pairing", () => {
  for (const labels of [["Fp1", "Fp2"], ["F3", "F4"], ["eeg Pg1", "eeg Pg2"]]) {
    const result = buildMontage(signals(labels), labels, "bipolar");
    assert.equal(result.data.length, 0);
    assert.ok(result.warnings.length > 0);
  }
  for (const depthLabel of ["LA1", "EEG LA1", "SEEG LA1"]) {
    const labels = ["eeg Fp1", "eeg F7", depthLabel];
    assert.equal(bipolarMontageKind(labels), "mixed");
    const result = buildMontage(signals(labels), labels, "bipolar");
    assert.equal(result.data.length, 0);
    assert.match(result.warnings.join(" "), /mixed scalp and anatomical/);
  }
});

test("anatomical pairs preserve MATLAB acquisition order and sign while selections cannot bridge contacts", () => {
  const allLabels = ["RA2", "LA3", "LA1", "RA1", "LA2", "LB1", "LB2"];
  const allData = signals(allLabels);
  const full = buildMontage(allData, allLabels, "bipolar");
  assert.deepEqual(full.labels, ["LA3-1", "LA1-2", "LB1-2", "RA2-1"]);
  assert.deepEqual(full.sourceIndices, [[1, 2], [2, 4], [5, 6], [0, 3]]);
  assert.deepEqual([...full.data[0]], [...allData[2]].map((sample, n) => sample - allData[1][n]));
  const kept = [0, 1, 3, 4, 5, 6];
  const selected = buildMontage(kept.map((i) => allData[i]), kept.map((i) => allLabels[i]), "bipolar", new Set(), undefined, undefined,
    { allChannelLabels: allLabels, sourceChannelIndices: kept });
  assert.deepEqual(selected.labels, ["LB1-2", "RA2-1"]);
  assert.deepEqual(selected.sourceIndices, [[4, 5], [0, 2]]);
  assert.ok(!selected.labels.includes("LA3-2"));
  assert.equal(bipolarMontageLabel(allLabels), "Anatomical bipolar");
});

test("full-catalog provenance must identify each input exactly once", () => {
  const labels = ["LA1", "LA2"];
  const data = signals(labels);
  for (const options of [
    { allChannelLabels: labels },
    { allChannelLabels: labels, sourceChannelIndices: [0, 0] },
    { allChannelLabels: labels, sourceChannelIndices: [1, 0] },
    { allChannelLabels: labels, sourceChannelIndices: [0, 2] },
    { channelUnits: ["µV"] },
  ]) assert.throws(() => buildMontage(data, labels, "bipolar", new Set(), undefined, undefined, options));
});
