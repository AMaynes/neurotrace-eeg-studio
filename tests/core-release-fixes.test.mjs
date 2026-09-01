/**
 * Overview & Purpose
 * Guards source parsing, clinical display decimation, raw dropout detection,
 * and identifier invariants required by the clinical viewer release.
 *
 * Architectural Relationships
 * Called by: Node's built-in test runner.
 * Calls: Public signal-domain operations from app/eeg-core.ts.
 *
 * External Resources
 * None; all EDF fixtures are deterministic in-memory files.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  EDFSource,
  LEGACY_RAW_COUNTS_PER_ROW,
  RawDatSource,
  aggregateEnvelopeWindow,
  anatomicalChannelGroup,
  buildEnvelopePyramid,
  buildMontage,
  clinicalDecimationFactor,
  confineTraceYToRow,
  decimateClinicalDisplayTrace,
  designClinicalDecimationFir,
  detectEnvelopeSynchronizedFlatlines,
  detectRawSynchronizedFlatlines,
  formatDisplayChannelLabel,
  makeId,
  mergeNearbyFlatlineRegions,
  normalizeEDFPhysicalDimension,
  orderAnatomicalChannelIndices,
  parseEDFHeader,
  prepareClinicalDisplaySignals,
  projectEnvelopeChannels,
  selectEnvelopePyramidLevel,
} from "../app/eeg-core.ts";

test("removes redundant EEG prefixes from displayed channel labels", () => {
  assert.equal(formatDisplayChannelLabel("EEG Fp1"), "Fp1");
  assert.equal(formatDisplayChannelLabel("EEG Fp1-REF–EEG F7-REF"), "Fp1-REF–F7-REF");
  assert.equal(formatDisplayChannelLabel("SEEG LA1"), "SEEG LA1");
});

function latin1Bytes(text, width) {
  const output = new Uint8Array(width).fill(0x20);
  for (let index = 0; index < Math.min(width, text.length); index += 1) {
    output[index] = text.charCodeAt(index) & 0xff;
  }
  return output;
}

function writeFixed(target, offset, text, width) {
  target.set(latin1Bytes(String(text), width), offset);
  return offset + width;
}

function makeEDF({ reserved = "EDF+C", signals, recordCount = 1, recordDurationSec = 1 }) {
  const signalCount = signals.length;
  const headerBytes = 256 + signalCount * 256;
  const header = new Uint8Array(headerBytes).fill(0x20);
  let offset = 0;
  offset = writeFixed(header, offset, "0", 8);
  offset = writeFixed(header, offset, "TEST PATIENT", 80);
  offset = writeFixed(header, offset, "TEST RECORDING", 80);
  offset = writeFixed(header, offset, "01.01.25", 8);
  offset = writeFixed(header, offset, "00.00.00", 8);
  offset = writeFixed(header, offset, headerBytes, 8);
  offset = writeFixed(header, offset, reserved, 44);
  offset = writeFixed(header, offset, recordCount, 8);
  offset = writeFixed(header, offset, recordDurationSec, 8);
  writeFixed(header, offset, signalCount, 4);

  offset = 256;
  const fields = [
    ["label", 16, ""],
    ["transducer", 80, ""],
    ["dimension", 8, "a.u."],
    ["physicalMinimum", 8, -1],
    ["physicalMaximum", 8, 1],
    ["digitalMinimum", 8, 0],
    ["digitalMaximum", 8, 100],
    ["prefilter", 80, ""],
    ["samplesPerRecord", 8, 2],
    ["signalReserved", 32, ""],
  ];
  for (const [key, width, fallback] of fields) {
    for (const signal of signals) {
      offset = writeFixed(header, offset, signal[key] ?? fallback, width);
    }
  }

  const recordByteLength = signals.reduce(
    (total, signal) => total + (signal.samplesPerRecord ?? 2) * 2,
    0,
  );
  const records = new Uint8Array(recordByteLength * recordCount);
  let recordOffset = 0;
  for (const signal of signals) {
    const sampleCount = signal.samplesPerRecord ?? 2;
    if (signal.annotationText !== undefined) {
      const encoded = new TextEncoder().encode(signal.annotationText);
      assert.ok(encoded.length <= sampleCount * 2, "annotation fixture must fit its EDF signal");
      records.set(encoded, recordOffset);
    } else {
      const values = signal.digitalValues ?? [0, 100];
      const view = new DataView(records.buffer);
      for (let sample = 0; sample < sampleCount; sample += 1) {
        view.setInt16(recordOffset + sample * 2, values[sample] ?? values.at(-1) ?? 0, true);
      }
    }
    recordOffset += sampleCount * 2;
  }
  return new File([header, records], "fixture.edf", { lastModified: 1 });
}

test("normalizes voltage units while preserving non-voltage dimensions", () => {
  const expected = new Map([
    ["V", 1_000_000],
    ["mV", 1_000],
    ["uV", 1],
    ["µV", 1],
    ["μV", 1],
    ["nV", 0.001],
  ]);
  for (const [dimension, scale] of expected) {
    assert.deepEqual(normalizeEDFPhysicalDimension(dimension), {
      unit: "µV",
      scale,
      isVoltage: true,
    });
  }
  assert.deepEqual(normalizeEDFPhysicalDimension("mmHg"), {
    unit: "mmHg",
    scale: 1,
    isVoltage: false,
  });
});

test("EDF subset reads apply the original signal's voltage scale", async () => {
  const file = makeEDF({
    signals: [
      { label: "EEG V1", dimension: "V", physicalMinimum: 0, physicalMaximum: 0.0001 },
      {
        label: "EDF Annotations",
        dimension: "a.u.",
        samplesPerRecord: 64,
        annotationText: "+0\u0014\u0014\0",
      },
      { label: "EEG MV1", dimension: "mV", physicalMinimum: 0, physicalMaximum: 0.1 },
      { label: "EEG UV1", dimension: "uV", physicalMinimum: 0, physicalMaximum: 100 },
      { label: "EEG MICRO1", dimension: "µV", physicalMinimum: 0, physicalMaximum: 100 },
      { label: "EEG NV1", dimension: "nV", physicalMinimum: 0, physicalMaximum: 100000 },
      { label: "Pressure", dimension: "mmHg", physicalMinimum: 0, physicalMaximum: 100 },
    ],
  });
  const source = await EDFSource.create(file);
  assert.deepEqual(source.meta.channelUnits, ["µV", "µV", "µV", "µV", "µV", "mmHg"]);
  assert.deepEqual(source.meta.recommendedDisplayChannels, [0, 1, 2, 3, 4]);

  const window = await source.getWindow(0, 1, [4, 0, 3, 1, 2, 5]);
  assert.deepEqual(window.channelUnits, ["µV", "µV", "µV", "µV", "µV", "mmHg"]);
  for (const channel of window.data) {
    assert.ok(Math.abs(channel[0]) < 1e-6);
    assert.ok(Math.abs(channel[1] - 100) < 1e-3);
  }
});

test("invalid and implausible EDF calibrations are warned and not initially recommended", async () => {
  const file = makeEDF({
    signals: [
      { label: "EEG C3", dimension: "uV", physicalMinimum: -100, physicalMaximum: 100 },
      { label: "EEG C4", dimension: "uV", physicalMinimum: 0, physicalMaximum: 0 },
      {
        label: "EEG C5",
        dimension: "uV",
        physicalMinimum: -100,
        physicalMaximum: 100,
        digitalMinimum: 0,
        digitalMaximum: 0,
      },
      { label: "EEG C6", dimension: "V", physicalMinimum: -1, physicalMaximum: 1 },
    ],
  });
  const source = await EDFSource.create(file);
  assert.deepEqual(source.meta.channelUnits, ["µV", "count", "count", "µV"]);
  assert.deepEqual(source.meta.recommendedDisplayChannels, [0]);
  assert.match(source.meta.warnings.join("\n"), /C4.*identical physical minimum and maximum/i);
  assert.match(source.meta.warnings.join("\n"), /C5.*identical digital minimum and maximum/i);
  assert.match(source.meta.warnings.join("\n"), /normalized physical spans.*C6/is);

  const rawCounts = await source.getWindow(0, 1, [1, 2]);
  assert.deepEqual(rawCounts.data.map((channel) => [...channel]), [[0, 100], [0, 100]]);
  assert.deepEqual(rawCounts.channelUnits, ["count", "count"]);

  const allInvalid = await EDFSource.create(makeEDF({
    signals: [
      { label: "EEG C4", dimension: "uV", physicalMinimum: 0, physicalMaximum: 0 },
    ],
  }));
  assert.deepEqual(allInvalid.meta.recommendedDisplayChannels, []);
  assert.match(allInvalid.meta.warnings.join("\n"), /no channels were selected automatically/i);
});

test("decodes EDF+ TAL labels as UTF-8", async () => {
  const label = "Dose café 🧠";
  const file = makeEDF({
    signals: [
      { label: "EEG C3", dimension: "uV", physicalMinimum: -100, physicalMaximum: 100 },
      {
        label: "EDF Annotations",
        dimension: "a.u.",
        samplesPerRecord: 64,
        annotationText: `+0\u0014\u0014\0+0.5\u0014${label}\u0014\0`,
      },
    ],
  });
  const source = await EDFSource.create(file);
  assert.deepEqual(source.events, [
    { label, timeSec: 0.5, durationSec: undefined, source: "edf+" },
  ]);

  const deferred = await EDFSource.create(file, { parseAnnotations: false });
  assert.deepEqual(deferred.events, []);
  await deferred.loadAnnotations();
  assert.deepEqual(deferred.events, source.events);
});

test("file-backed overview envelopes retain both polarities with pixel-bounded output", async () => {
  const channelZero = [0, 2, 100, -50, 4, 6, 8, 10];
  const channelOne = [20, 18, 16, 14, 12, 10, -30, 40];
  const bytes = new Uint8Array(channelZero.length * 2 * 2);
  const view = new DataView(bytes.buffer);
  channelZero.forEach((value, sample) => {
    view.setInt16((sample * 2) * 2, value, true);
    view.setInt16((sample * 2 + 1) * 2, channelOne[sample], true);
  });
  const source = await RawDatSource.create(new File([bytes], "overview.dat"), {
    sampleRate: 8,
    channelCount: 2,
    physicalScale: 1,
  });
  const envelope = await source.getEnvelopeWindow(0, 1, 2, [1, 0]);
  assert.deepEqual([...envelope.minima[0]], [14, -30]);
  assert.deepEqual([...envelope.maxima[0]], [20, 40]);
  assert.deepEqual([...envelope.minima[1]], [-50, 4]);
  assert.deepEqual([...envelope.maxima[1]], [100, 10]);
  assert.deepEqual([...envelope.gaps[0]], [0, 0]);
  assert.deepEqual([...envelope.data[1]], [25, 7]);
  assert.equal(envelope.data[0].length, 2);
  assert.equal(envelope.bucketDurationSec, 0.5);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    source.getEnvelopeWindow(0, 1, 2, [0], { signal: controller.signal }),
    (error) => error?.name === "AbortError",
  );
});

test("overview extrema preserve synchronized flatline QC conservatively", () => {
  const minima = [
    new Float32Array([1, 2, 2, 4]),
    new Float32Array([5, 6, 6, 8]),
    new Float32Array([9, 10, 10, 12]),
    new Float32Array([13, 14, 15, 16]),
    new Float32Array([17, 18, 18, 20]),
  ];
  const maxima = minima.map((channel) => channel.slice());
  maxima[3][2] = 16;
  const gaps = minima.map(() => new Uint8Array(4));
  const regions = detectEnvelopeSynchronizedFlatlines(minima, maxima, gaps, 0.25, {
    startSec: 10,
    thresholdFraction: 0.8,
    minimumDurationSec: 0.5,
  });
  assert.deepEqual(regions, [{
    startSec: 10.25,
    endSec: 10.75,
    durationSec: 0.5,
    minimumFlatChannelCount: 4,
    totalChannelCount: 5,
  }]);

  gaps[0][1] = 1;
  gaps[1][1] = 1;
  gaps[0][2] = 1;
  gaps[1][2] = 1;
  assert.deepEqual(detectEnvelopeSynchronizedFlatlines(minima, maxima, gaps, 0.25, {
    startSec: 10,
    thresholdFraction: 0.8,
    minimumDurationSec: 0.5,
  }), []);
});

test("overview flatline detection uses constant typed-array workspace", () => {
  const allocationCount = (bucketCount) => {
    const minima = Array.from({ length: 18 }, (_, channel) => {
      const values = new Float32Array(bucketCount);
      for (let bucket = 0; bucket < bucketCount; bucket += 1) values[bucket] = channel + Math.floor(bucket / 3);
      return values;
    });
    const maxima = minima.map((channel) => channel.slice());
    const gaps = minima.map(() => new Uint8Array(bucketCount));
    const NativeFloat32Array = globalThis.Float32Array;
    const NativeUint8Array = globalThis.Uint8Array;
    const allocations = { float32: 0, uint8: 0 };
    globalThis.Float32Array = class CountingFloat32Array extends NativeFloat32Array {
      constructor(...args) {
        super(...args);
        allocations.float32 += 1;
      }
    };
    globalThis.Uint8Array = class CountingUint8Array extends NativeUint8Array {
      constructor(...args) {
        super(...args);
        allocations.uint8 += 1;
      }
    };
    try {
      detectEnvelopeSynchronizedFlatlines(minima, maxima, gaps, 0.25);
    } finally {
      globalThis.Float32Array = NativeFloat32Array;
      globalThis.Uint8Array = NativeUint8Array;
    }
    return allocations;
  };

  assert.deepEqual(allocationCount(4), { float32: 2, uint8: 2 });
  assert.deepEqual(allocationCount(12_000), { float32: 2, uint8: 2 });
});

test("groups displayed flatline regions separated by no more than two seconds", () => {
  const regions = mergeNearbyFlatlineRegions([
    { startSec: 7, endSec: 8 },
    { startSec: 0, endSec: 1 },
    { startSec: 3, endSec: 4 },
    { startSec: 6.000_001, endSec: 6.5 },
  ], 2);

  assert.deepEqual(regions, [
    { startSec: 0, endSec: 4 },
    { startSec: 6.000_001, endSec: 8 },
  ]);
  assert.deepEqual(mergeNearbyFlatlineRegions([], 2), []);
  assert.throws(() => mergeNearbyFlatlineRegions([{ startSec: 2, endSec: 1 }], 2), /ordered boundaries/i);
  assert.throws(() => mergeNearbyFlatlineRegions([], -1), /merge gap/i);
});

test("cached exact envelopes aggregate extrema, gaps, and absolute metadata conservatively", () => {
  const source = {
    data: [
      new Float32Array([1.5, 2.5, -2.5, 6, 5.5, 7.5, 7.5, 9]),
      new Float32Array([11, 12, 13, 14, 15, 16, 17, 18]),
    ],
    minima: [
      new Float32Array([1, 2, -4, 4, 5, 6, 7, 8]),
      new Float32Array([10, 11, 12, 13, 14, 15, 16, 17]),
    ],
    maxima: [
      new Float32Array([2, 3, -1, 8, 6, 9, 8, 10]),
      new Float32Array([12, 13, 14, 15, 16, 17, 18, 19]),
    ],
    gaps: [new Uint8Array(8), new Uint8Array(8)],
    variation: [
      new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]),
      new Float32Array([8, 7, 6, 5, 4, 3, 2, 1]),
    ],
    bucketDurationSec: 0.5,
    sampleRates: [2, 2],
    channelStartSecs: [10, 10],
    startSec: 10,
    durationSec: 4,
    channelIndices: [3, 7],
    channelLabels: ["C3", "C4"],
    channelUnits: ["µV", "µV"],
  };
  source.gaps[0][2] = 1;

  const aggregated = aggregateEnvelopeWindow(source, 10, 4, 2);
  assert.deepEqual([...aggregated.minima[0]], [-4, 5]);
  assert.deepEqual([...aggregated.maxima[0]], [8, 10]);
  assert.ok(Number.isNaN(aggregated.data[0][0]), "a propagated gap must not acquire a finite midpoint");
  assert.equal(aggregated.data[0][1], 7.5);
  assert.deepEqual([...aggregated.gaps[0]], [1, 0]);
  assert.deepEqual([...aggregated.minima[1]], [10, 14]);
  assert.deepEqual([...aggregated.maxima[1]], [15, 19]);
  assert.deepEqual([...aggregated.data[1]], [12.5, 16.5]);
  assert.deepEqual([...aggregated.gaps[1]], [0, 0]);
  assert.deepEqual([...aggregated.variation[0]], [10, 26]);
  assert.deepEqual([...aggregated.variation[1]], [26, 10]);
  assert.equal(aggregated.startSec, 10);
  assert.equal(aggregated.durationSec, 4);
  assert.equal(aggregated.bucketDurationSec, 2);
  assert.deepEqual(aggregated.sampleRates, [0.5, 0.5]);
  assert.deepEqual(aggregated.channelStartSecs, [10, 10]);
  assert.deepEqual(aggregated.channelIndices, [3, 7]);
  assert.deepEqual(aggregated.channelLabels, ["C3", "C4"]);
  assert.deepEqual(aggregated.channelUnits, ["µV", "µV"]);
  assert.notEqual(aggregated.channelIndices, source.channelIndices);
  assert.deepEqual([...source.minima[0]], [1, 2, -4, 4, 5, 6, 7, 8], "the cached source remains unchanged");
});

test("cached envelope aggregation includes every partially overlapping source bucket", () => {
  const source = {
    data: [new Float32Array([1.5, 3.5, 5.5, 7.5])],
    minima: [new Float32Array([1, 3, 5, 7])],
    maxima: [new Float32Array([2, 4, 6, 8])],
    gaps: [new Uint8Array(4)],
    bucketDurationSec: 0.5,
    sampleRates: [2],
    channelStartSecs: [20],
    startSec: 20,
    durationSec: 2,
    channelIndices: [9],
    channelLabels: ["Pz"],
    channelUnits: ["µV"],
  };

  const cropped = aggregateEnvelopeWindow(source, 20.25, 1.5, 1);
  assert.deepEqual([...cropped.minima[0]], [1]);
  assert.deepEqual([...cropped.maxima[0]], [8]);
  assert.deepEqual([...cropped.data[0]], [4.5]);
  assert.equal(cropped.startSec, 20.25);
  assert.equal(cropped.channelStartSecs[0], 20.25);
  assert.equal(cropped.bucketDurationSec, 1.5);
});

test("oversampled empty envelope buckets do not become recording gaps", () => {
  const source = {
    data: [new Float32Array([1, Number.NaN, 3, Number.NaN])],
    minima: [new Float32Array([1, Number.NaN, 3, Number.NaN])],
    maxima: [new Float32Array([1, Number.NaN, 3, Number.NaN])],
    gaps: [new Uint8Array(4)],
    bucketDurationSec: 0.25,
    sampleRates: [4],
    channelStartSecs: [0],
    startSec: 0,
    durationSec: 1,
    channelIndices: [0],
    channelLabels: ["Fp1"],
    channelUnits: ["µV"],
  };

  const aggregated = aggregateEnvelopeWindow(source, 0, 1, 2);
  assert.deepEqual([...aggregated.minima[0]], [1, 3]);
  assert.deepEqual([...aggregated.maxima[0]], [1, 3]);
  assert.deepEqual([...aggregated.data[0]], [1, 3]);
  assert.deepEqual([...aggregated.gaps[0]], [0, 0]);
});

test("cached envelope aggregation rejects missing coverage and invented resolution", () => {
  const source = {
    data: [new Float32Array([1, Number.NaN, 3, 4])],
    minima: [new Float32Array([1, Number.NaN, 3, 4])],
    maxima: [new Float32Array([1, Number.NaN, 3, 4])],
    gaps: [new Uint8Array([0, 1, 0, 0])],
    bucketDurationSec: 1,
    sampleRates: [1],
    channelStartSecs: [5],
    startSec: 5,
    durationSec: 4,
    channelIndices: [0],
    channelLabels: ["Fp1"],
    channelUnits: ["µV"],
  };

  const missingOnly = aggregateEnvelopeWindow(source, 6, 1, 1);
  assert.ok(Number.isNaN(missingOnly.minima[0][0]));
  assert.ok(Number.isNaN(missingOnly.maxima[0][0]));
  assert.ok(Number.isNaN(missingOnly.data[0][0]));
  assert.deepEqual([...missingOnly.gaps[0]], [1]);
  assert.throws(() => aggregateEnvelopeWindow(source, 4.9, 2, 1), /outside cached coverage/i);
  assert.throws(() => aggregateEnvelopeWindow(source, 8, 2, 1), /outside cached coverage/i);
  assert.throws(() => aggregateEnvelopeWindow(source, 5, 1, 2), /finer time buckets/i);
  assert.throws(
    () => aggregateEnvelopeWindow({ ...source, maxima: [new Float32Array(3)] }, 5, 2, 1),
    /bucket counts are inconsistent/i,
  );
});

test("envelope pyramid preserves exact extrema, gaps, coverage, and metadata", () => {
  const base = {
    data: [new Float32Array([5.5, 1.5, 8, 3.5, -0.5, 4.5, 7, 1.5])],
    minima: [new Float32Array([5, 1, 7, 3, -2, 4, 6, 0])],
    maxima: [new Float32Array([6, 2, 9, 4, 1, 5, 8, 3])],
    gaps: [new Uint8Array([0, 0, 1, 0, 0, 0, 0, 0])],
    bucketDurationSec: 1,
    sampleRates: [1],
    channelStartSecs: [10],
    startSec: 10,
    durationSec: 8,
    channelIndices: [3],
    channelLabels: ["C3"],
    channelUnits: ["µV"],
  };

  const levels = buildEnvelopePyramid(base, 1);
  assert.deepEqual(levels.map((level) => level.data[0].length), [8, 4, 2, 1]);
  assert.equal(levels[0], base, "the finest level reuses the caller-owned base envelope");

  assert.deepEqual([...levels[1].minima[0]], [1, 3, -2, 0]);
  assert.deepEqual([...levels[1].maxima[0]], [6, 9, 5, 8]);
  assert.deepEqual([...levels[1].gaps[0]], [0, 1, 0, 0]);
  assert.deepEqual([...levels[1].data[0]], [3.5, Number.NaN, 1.5, 4]);

  assert.deepEqual([...levels[2].minima[0]], [1, -2]);
  assert.deepEqual([...levels[2].maxima[0]], [9, 8]);
  assert.deepEqual([...levels[2].gaps[0]], [1, 0]);
  assert.deepEqual([...levels[2].data[0]], [Number.NaN, 3]);

  assert.deepEqual([...levels[3].minima[0]], [-2]);
  assert.deepEqual([...levels[3].maxima[0]], [9]);
  assert.deepEqual([...levels[3].gaps[0]], [1]);
  assert.ok(Number.isNaN(levels[3].data[0][0]));

  levels.forEach((level, index) => {
    assert.equal(level.startSec, 10);
    assert.equal(level.durationSec, 8);
    assert.equal(level.channelStartSecs[0], 10);
    assert.equal(level.bucketDurationSec, 2 ** index);
    assert.equal(level.sampleRates[0], 1 / (2 ** index));
    assert.deepEqual(level.channelIndices, [3]);
    assert.deepEqual(level.channelLabels, ["C3"]);
    assert.deepEqual(level.channelUnits, ["µV"]);
  });

  const signalBytes = (level) => [level.data, level.minima, level.maxima, level.gaps]
    .flat()
    .reduce((total, channel) => total + channel.byteLength, 0);
  const retainedBytes = levels.reduce((total, level) => total + signalBytes(level), 0);
  assert.ok(retainedBytes < signalBytes(base) * 2, "retained envelope storage stays below twice the base");
  assert.deepEqual([...base.minima[0]], [5, 1, 7, 3, -2, 4, 6, 0], "the base remains unchanged");
});

test("envelope pyramid stops near its minimum without exceeding twice the base storage", () => {
  const bucketCount = 1_000;
  const minima = Float32Array.from({ length: bucketCount }, (_, index) => -index);
  const maxima = Float32Array.from({ length: bucketCount }, (_, index) => index + 0.5);
  const base = {
    data: [Float32Array.from({ length: bucketCount }, () => 0.25)],
    minima: [minima],
    maxima: [maxima],
    gaps: [new Uint8Array(bucketCount)],
    bucketDurationSec: 0.01,
    sampleRates: [100],
    channelStartSecs: [25],
    startSec: 25,
    durationSec: 10,
    channelIndices: [7],
    channelLabels: ["Pz"],
    channelUnits: ["µV"],
  };

  const levels = buildEnvelopePyramid(base);
  assert.deepEqual(levels.map((level) => level.data[0].length), [1_000, 500, 250, 125, 64]);
  assert.ok(levels.every((level) => level.startSec === 25 && level.durationSec === 10));
  assert.ok(levels.reduce((total, level) => total + level.data[0].length, 0) < bucketCount * 2);
  assert.deepEqual([...levels.at(-1).minima[0].slice(0, 2)], [-15, -31]);
  assert.deepEqual([...levels.at(-1).maxima[0].slice(-2)], [991.5, 999.5]);

  assert.deepEqual(buildEnvelopePyramid(base, bucketCount), [base]);
  assert.throws(() => buildEnvelopePyramid(base, 0), /positive whole number/i);
});

test("envelope channel projection reorders metadata while reusing every signal buffer", () => {
  const source = {
    data: [
      new Float32Array([1, 2]),
      new Float32Array([3, 4]),
      new Float32Array([5, 6]),
    ],
    minima: [
      new Float32Array([0, 1]),
      new Float32Array([2, 3]),
      new Float32Array([4, 5]),
    ],
    maxima: [
      new Float32Array([2, 3]),
      new Float32Array([4, 5]),
      new Float32Array([6, 7]),
    ],
    gaps: [
      new Uint8Array([0, 0]),
      new Uint8Array([0, 1]),
      new Uint8Array([1, 0]),
    ],
    bucketDurationSec: 0.5,
    sampleRates: [2, 4, 8],
    channelStartSecs: [10, 10.25, 10.5],
    startSec: 10,
    durationSec: 1,
    channelIndices: [7, 2, 11],
    channelLabels: ["C7", "C2", "C11"],
    channelUnits: ["µV", "mV", "count"],
  };

  const projected = projectEnvelopeChannels(source, [11, 7]);
  assert.deepEqual(projected.channelIndices, [11, 7]);
  assert.deepEqual(projected.channelLabels, ["C11", "C7"]);
  assert.deepEqual(projected.channelUnits, ["count", "µV"]);
  assert.deepEqual(projected.sampleRates, [8, 2]);
  assert.deepEqual(projected.channelStartSecs, [10.5, 10]);
  assert.equal(projected.startSec, source.startSec);
  assert.equal(projected.durationSec, source.durationSec);
  assert.equal(projected.bucketDurationSec, source.bucketDurationSec);

  for (const field of ["data", "minima", "maxima", "gaps"]) {
    assert.notEqual(projected[field], source[field], `${field} gets a new channel-order container`);
    assert.equal(projected[field][0], source[field][2], `${field} channel 11 reuses its typed array`);
    assert.equal(projected[field][1], source[field][0], `${field} channel 7 reuses its typed array`);
    assert.equal(projected[field][0].buffer, source[field][2].buffer, `${field} channel 11 reuses its buffer`);
    assert.equal(projected[field][1].buffer, source[field][0].buffer, `${field} channel 7 reuses its buffer`);
  }
});

test("envelope channel projection rejects duplicate, missing, and invalid source requests", () => {
  const source = {
    data: [new Float32Array([1])],
    minima: [new Float32Array([0])],
    maxima: [new Float32Array([2])],
    gaps: [new Uint8Array([0])],
    bucketDurationSec: 1,
    sampleRates: [1],
    channelStartSecs: [0],
    startSec: 0,
    durationSec: 1,
    channelIndices: [3],
    channelLabels: ["C3"],
    channelUnits: ["µV"],
  };

  assert.throws(() => projectEnvelopeChannels(source, [3, 3]), /requested more than once/i);
  assert.throws(() => projectEnvelopeChannels(source, [4]), /not present in the cached envelope/i);
  assert.throws(() => projectEnvelopeChannels(source, [-1]), /source channel -1 is invalid/i);
  assert.throws(
    () => projectEnvelopeChannels({ ...source, channelUnits: [] }, [3]),
    /channel metadata is inconsistent/i,
  );
});

test("24-hour envelope pyramid keeps a 6-hour render pixel-bounded with exact extrema", { timeout: 30_000 }, () => {
  const channelCount = 18;
  const baseBucketCount = 65_536;
  const recordingDurationSec = 24 * 60 * 60;
  const baseBucketDurationSec = recordingDurationSec / baseBucketCount;
  const channelIndices = Array.from({ length: channelCount }, (_, index) => index * 2 + 1);
  const minima = Array.from({ length: channelCount }, (_, channel) =>
    Float32Array.from(
      { length: baseBucketCount },
      (_, bucket) => channel * 100_000 + bucket,
    ));
  const maxima = minima.map((channel) => Float32Array.from(channel, (value) => value + 0.5));
  const gaps = Array.from({ length: channelCount }, (_, channel) =>
    Uint8Array.from(
      { length: baseBucketCount },
      (_, bucket) => (bucket + channel * 13) % 257 === 0 ? 1 : 0,
    ));
  const data = minima.map((channel, channelIndex) => Float32Array.from(
    channel,
    (value, bucket) => gaps[channelIndex][bucket] ? Number.NaN : value + 0.25,
  ));
  const base = {
    data,
    minima,
    maxima,
    gaps,
    bucketDurationSec: baseBucketDurationSec,
    sampleRates: Array.from({ length: channelCount }, () => 1 / baseBucketDurationSec),
    channelStartSecs: Array.from({ length: channelCount }, () => 0),
    startSec: 0,
    durationSec: recordingDurationSec,
    channelIndices,
    channelLabels: channelIndices.map((index) => `EEG ${index}`),
    channelUnits: Array.from({ length: channelCount }, () => "µV"),
  };

  const levels = buildEnvelopePyramid(base, 64);
  assert.deepEqual(
    levels.map((level) => level.data[0].length),
    [65_536, 32_768, 16_384, 8_192, 4_096, 2_048, 1_024, 512, 256, 128, 64],
  );
  const signalBytes = (level) => [level.data, level.minima, level.maxima, level.gaps]
    .flat()
    .reduce((total, channel) => total + channel.byteLength, 0);
  const retainedBytes = levels.reduce((total, level) => total + signalBytes(level), 0);
  assert.ok(retainedBytes < signalBytes(base) * 2, "all LOD levels stay below twice the finest storage");

  const windowStartSec = 6 * 60 * 60;
  const windowDurationSec = 6 * 60 * 60;
  const displayBucketCount = 2_048;
  const displayBucketDurationSec = windowDurationSec / displayBucketCount;
  const selected = selectEnvelopePyramidLevel(levels, displayBucketDurationSec);
  assert.equal(selected.data[0].length, 8_192, "selection skips the 65,536-bucket finest level");
  const selectedBucketsInWindow = Math.ceil(windowDurationSec / selected.bucketDurationSec) + 2;
  assert.ok(
    selectedBucketsInWindow <= displayBucketCount * 2,
    "aggregation examines at most two selected-level buckets per output pixel, plus boundaries",
  );

  const visible = aggregateEnvelopeWindow(
    selected,
    windowStartSec,
    windowDurationSec,
    displayBucketCount,
  );
  assert.equal(visible.data.length, channelCount);
  assert.ok(visible.data.every((channel) => channel.length === displayBucketCount));
  assert.ok(visible.minima.every((channel) => channel.length === displayBucketCount));
  assert.ok(visible.maxima.every((channel) => channel.length === displayBucketCount));
  assert.ok(visible.gaps.every((channel) => channel.length === displayBucketCount));
  assert.deepEqual(visible.channelIndices, channelIndices);

  const baseFirstBucket = baseBucketCount / 4;
  const baseBucketsPerDisplayBucket = baseBucketCount / 4 / displayBucketCount;
  assert.equal(baseBucketsPerDisplayBucket, 8);
  for (let channel = 0; channel < channelCount; channel += 1) {
    for (let displayBucket = 0; displayBucket < displayBucketCount; displayBucket += 1) {
      const firstBaseBucket = baseFirstBucket + displayBucket * baseBucketsPerDisplayBucket;
      const lastBaseBucket = firstBaseBucket + baseBucketsPerDisplayBucket - 1;
      const expectedMinimum = channel * 100_000 + firstBaseBucket;
      const expectedMaximum = channel * 100_000 + lastBaseBucket + 0.5;
      let expectedGap = 0;
      for (let bucket = firstBaseBucket; bucket <= lastBaseBucket; bucket += 1) {
        if ((bucket + channel * 13) % 257 === 0) {
          expectedGap = 1;
          break;
        }
      }
      assert.equal(visible.minima[channel][displayBucket], expectedMinimum);
      assert.equal(visible.maxima[channel][displayBucket], expectedMaximum);
      assert.equal(visible.gaps[channel][displayBucket], expectedGap);
      if (expectedGap) assert.ok(Number.isNaN(visible.data[channel][displayBucket]));
      else assert.equal(visible.data[channel][displayBucket], (expectedMinimum + expectedMaximum) / 2);
    }
  }
});

test("envelope pyramid level selection rejects unusable requests", () => {
  assert.throws(() => selectEnvelopePyramidLevel([], 1), /at least one level/i);
  assert.throws(() => selectEnvelopePyramidLevel([{
    data: [], minima: [], maxima: [], gaps: [],
    bucketDurationSec: 1,
    sampleRates: [], channelStartSecs: [], startSec: 0, durationSec: 1,
    channelIndices: [], channelLabels: [], channelUnits: [],
  }], 0), /positive finite bucket duration/i);
});

test("rejects EDF+D rather than flattening discontinuous record time", async () => {
  const file = makeEDF({
    reserved: "EDF+D",
    signals: [
      { label: "EEG C3", dimension: "uV", physicalMinimum: -100, physicalMaximum: 100 },
    ],
  });
  await assert.rejects(
    parseEDFHeader(file),
    (error) => error?.code === "UNSUPPORTED_FORMAT" && /discontinuous/i.test(error.message),
  );
});

test("clinical FIR and conditional 2x decimation satisfy release invariants", () => {
  const sampleRate = 1000;
  const coefficients = designClinicalDecimationFir(sampleRate);
  assert.equal(coefficients.length, 97);
  assert.ok(Math.abs(coefficients.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
  for (let index = 0; index < coefficients.length; index += 1) {
    assert.ok(Math.abs(coefficients[index] - coefficients.at(-1 - index)) < 1e-15);
  }
  const gainAt = (frequency) => {
    let real = 0;
    let imaginary = 0;
    coefficients.forEach((coefficient, index) => {
      const phase = -2 * Math.PI * frequency * index / sampleRate;
      real += coefficient * Math.cos(phase);
      imaginary += coefficient * Math.sin(phase);
    });
    return Math.hypot(real, imaginary);
  };
  assert.ok(gainAt(200) > 0.98 && gainAt(200) < 1.02);
  assert.ok(gainAt(245) < 0.002);

  assert.equal(clinicalDecimationFactor(999, 10_000, 1000), 1);
  assert.equal(clinicalDecimationFactor(1000, 1999, 1000), 1);
  assert.equal(clinicalDecimationFactor(1000, 2000, 1000), 2);
  assert.equal(
    clinicalDecimationFactor(1000, 2000, 1000.1),
    1,
    "the exact nSamples/nPixels ratio must be used for fractional canvas widths",
  );
  assert.equal(clinicalDecimationFactor(1000, 2001, 1000.1), 2);

  const short = new Float32Array([1, 2, 3]);
  const untouched = decimateClinicalDisplayTrace(short, 1000, 10);
  assert.equal(untouched.factor, 1);
  assert.equal(untouched.data, short);

  const constant = new Float32Array(2000).fill(1);
  const decimated = decimateClinicalDisplayTrace(constant, sampleRate, 500);
  assert.equal(decimated.factor, 2);
  assert.equal(decimated.sampleRate, 500);
  assert.equal(decimated.data.length, 1000);
  assert.equal(decimated.compensatedGroupDelaySamples, 48);
  assert.equal(decimated.retainedSampleTimeCorrectionSec, -0.048);
  assert.ok(decimated.data instanceof Float32Array, "the processed display cache remains single precision");
  assert.ok(decimated.data.every(Number.isFinite));
  assert.ok(Math.abs(decimated.data[100] - 1) < 1e-6);

  const eofImpulse = new Float32Array(2001);
  eofImpulse[eofImpulse.length - 1] = 1;
  const decimatedImpulse = decimateClinicalDisplayTrace(eofImpulse, sampleRate, 500);
  assert.equal(decimatedImpulse.data.length, Math.ceil(eofImpulse.length / 2));
  assert.ok(Math.abs(decimatedImpulse.data.at(-1) - coefficients[48]) < 1e-6);

  const eofNaN = eofImpulse.slice();
  eofNaN[eofNaN.length - 1] = Number.NaN;
  const decimatedNaN = decimateClinicalDisplayTrace(eofNaN, sampleRate, 500);
  assert.ok(Number.isNaN(decimatedNaN.data.at(-1)), "an in-range source NaN must remain a gap");
});

test("2x clinical decimation stays on the recording-global even-sample grid", () => {
  const sampleRate = 1000;
  const global = Float32Array.from(
    { length: 1200 },
    (_, sample) => Math.sin(sample * 0.071) + Math.cos(sample * 0.013) * 0.2,
  );
  const evenStartWindow = global.slice(100, 1101);
  const oddStartWindow = global.slice(101, 1101);
  const evenStart = decimateClinicalDisplayTrace(evenStartWindow, sampleRate, 100, 100);
  const oddStart = decimateClinicalDisplayTrace(oddStartWindow, sampleRate, 100, 101);

  assert.equal(evenStart.retainedInputSampleOffset, 0);
  assert.equal(evenStart.outputStartSampleIndex, 100);
  assert.equal(evenStart.outputStartOffsetSec, 0);
  assert.equal(oddStart.retainedInputSampleOffset, 1);
  assert.equal(oddStart.outputStartSampleIndex, 102);
  assert.equal(oddStart.outputStartOffsetSec, 0.001);
  assert.equal(evenStart.data.length, 501);
  assert.equal(oddStart.data.length, 500);

  // By global sample 150, both 97-tap windows are entirely inside their
  // shared raw input. Every overlapping retained sample must then be exact.
  const evenComparisonStart = (150 - evenStart.outputStartSampleIndex) / 2;
  const oddComparisonStart = (150 - oddStart.outputStartSampleIndex) / 2;
  assert.deepEqual(
    evenStart.data.slice(evenComparisonStart),
    oddStart.data.slice(oddComparisonStart),
  );

  const prepared = prepareClinicalDisplaySignals(
    [evenStartWindow, oddStartWindow],
    [sampleRate, sampleRate],
    100,
    [100, 101],
  );
  assert.deepEqual(prepared.retainedInputSampleOffsets, [0, 1]);
  assert.deepEqual(prepared.outputStartSampleIndices, [100, 102]);
  assert.deepEqual(prepared.outputStartOffsetSecs, [0, 0.001]);
  assert.throws(
    () => prepareClinicalDisplaySignals([evenStartWindow], [sampleRate], 100, [100, 101]),
    /source start sample indices/i,
  );
});

test("detects only synchronized raw flatlines at the 80 percent threshold", () => {
  const rates = [100, 125, 200, 250, 80];
  const channels = rates.map((rate, channelIndex) => {
    const output = new Float32Array(rate * 2);
    for (let index = 0; index < output.length; index += 1) output[index] = index + channelIndex / 10;
    if (channelIndex < 4) {
      for (let index = Math.round(0.4 * rate); index <= Math.round(1.0 * rate); index += 1) {
        output[index] = 7 + channelIndex;
      }
    } else {
      output.fill(Number.NaN);
    }
    return output;
  });
  const intervals = detectRawSynchronizedFlatlines(channels, rates, { startSec: 10 });
  assert.deepEqual(intervals, [{
    startSec: 10.4,
    endSec: 11,
    durationSec: 0.5999999999999996,
    minimumFlatChannelCount: 4,
    totalChannelCount: 5,
  }]);

  const belowThreshold = channels.map((channel, index) =>
    index === 3 ? Float32Array.from(channel, (_, sample) => sample) : channel,
  );
  assert.deepEqual(detectRawSynchronizedFlatlines(belowThreshold, rates), []);
});

test("raw flatline detection aligns mixed channel origins conservatively", () => {
  const rates = [100, 100, 100, 100, 100];
  const origins = [10, 10.1, 9.9, 10.2, 10];
  const channels = rates.map((rate, channelIndex) => {
    const output = Float32Array.from({ length: rate * 2 }, (_, sample) => sample);
    if (channelIndex < 4) {
      const localStart = Math.round((10.5 - origins[channelIndex]) * rate);
      const localEnd = Math.round((11 - origins[channelIndex]) * rate);
      for (let sample = localStart; sample <= localEnd; sample += 1) output[sample] = channelIndex;
    } else {
      output.fill(Number.NaN);
    }
    return output;
  });
  const intervals = detectRawSynchronizedFlatlines(channels, rates, {
    startSec: 99,
    channelStartSecs: origins,
  });
  assert.equal(intervals.length, 1);
  assert.ok(Math.abs(intervals[0].startSec - 10.5) < 1e-9);
  assert.ok(Math.abs(intervals[0].endSec - 11) < 1e-9);
  assert.equal(intervals[0].minimumFlatChannelCount, 4);
  assert.throws(
    () => detectRawSynchronizedFlatlines(channels, rates, { channelStartSecs: [0] }),
    /channel start times/i,
  );
});

test("annotation IDs remain unique without a reload-resetting counter", () => {
  const ids = Array.from({ length: 5000 }, () => makeId("ann"));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^ann-[a-z0-9-]+$/i.test(id)));
  assert.ok(!ids.includes("ann-000001"));
});

test("referential montage retains explicitly excluded inputs while derived montages omit them", () => {
  const data = [
    new Float32Array([1, 2]),
    new Float32Array([3, 4]),
    new Float32Array([5, 6]),
  ];
  const labels = ["LA1", "LA2", "LA3"];
  const excluded = new Set([1]);
  const starts = [4, 4, 4];
  const referential = buildMontage(data, labels, "referential", excluded, [1000, 1000, 1000], starts);
  assert.deepEqual(referential.labels, labels);
  assert.deepEqual(referential.primarySourceIndices, [0, 1, 2]);
  assert.deepEqual(referential.sampleStartSecs, starts);
  assert.equal(referential.data[0], data[0], "referential rows must retain the original sample buffer");
  assert.equal(referential.data[1], data[1]);

  const average = buildMontage(data, labels, "average", excluded, [1000, 1000, 1000], starts);
  assert.deepEqual(average.primarySourceIndices, [0, 2]);
  assert.deepEqual(average.sampleStartSecs, [4, 4]);
  const partiallyAlignedAverage = buildMontage(data, labels, "average", new Set(), [1000, 1000, 1000], [4, 4.001, 4]);
  assert.deepEqual(partiallyAlignedAverage.primarySourceIndices, [0, 2]);
  assert.match(partiallyAlignedAverage.warnings.join("\n"), /excluded.*incompatible.*LA2/i);

  const bipolar = buildMontage(data, labels, "bipolar", excluded, [1000, 1000, 1000], starts);
  assert.deepEqual(bipolar.labels, ["LA1-3"]);
  assert.deepEqual(Array.from(bipolar.data[0]), [4, 4], "MATLAB pairs adjacent retained entries in ChannelMat order");

  const misalignedBipolar = buildMontage(
    data.slice(0, 2),
    labels.slice(0, 2),
    "bipolar",
    new Set(),
    [1000, 1000],
    [4, 4.001],
  );
  assert.deepEqual(misalignedBipolar.labels, ["LA1", "LA2"], "an unsafe derivation falls back to recorded channels");
  assert.match(misalignedBipolar.warnings.join("\n"), /sample start times.*not aligned/i);
});

test("montages preserve polarity, finite gaps, provenance, and the largest aligned average cohort", () => {
  const data = [
    new Float32Array([3, Number.NaN, Number.POSITIVE_INFINITY, 9]),
    new Float32Array([1, 4, 5, 3]),
    new Float32Array([100, 100]),
  ];
  const labels = ["SEEG LA1-REF", "SEEG LA2-REF", "SEEG LB1-REF"];

  const average = buildMontage(data, labels, "average-reference", new Set(), [1000, 1000, 500], [2, 2, 2]);
  assert.deepEqual(average.primarySourceIndices, [0, 1]);
  assert.deepEqual(average.sourceIndices, [[0, 1], [0, 1]]);
  assert.deepEqual(Array.from(average.data[0]), [1, Number.NaN, Number.NaN, 3]);
  assert.deepEqual(Array.from(average.data[1]), [-1, 0, 0, -3]);
  assert.match(average.warnings.join("\n"), /excluded.*LB1/i);

  const bipolar = buildMontage(data.slice(0, 2), ["LA1", "LA2"], "bipolar", new Set(), [1000, 1000], [2, 2]);
  assert.deepEqual(bipolar.labels, ["LA1-2"]);
  assert.deepEqual(bipolar.sourceIndices, [[0, 1]]);
  assert.deepEqual(bipolar.primarySourceIndices, [1]);
  assert.deepEqual(Array.from(bipolar.data[0]), [-2, Number.NaN, Number.NaN, -6]);
});

test("bipolar montage preserves repeated contacts in ChannelMat order", () => {
  const montage = buildMontage(
    [
      new Float32Array([10]),
      new Float32Array([5]),
      new Float32Array([4]),
      new Float32Array([1]),
    ],
    ["LA1", "LA2", "LA2", "LA3"],
    "bipolar",
    new Set(),
    [1000, 1000, 1000, 1000],
    [0, 0, 0, 0],
  );

  assert.deepEqual(montage.labels, ["LA1-2", "LA2-2", "LA2-3"]);
  assert.deepEqual(montage.data.map((channel) => [...channel]), [[-5], [-1], [-3]]);
  assert.deepEqual(montage.warnings, []);
});

test("montage rejects invalid modes and sample-rate metadata", () => {
  const data = [new Float32Array([1])];
  assert.throws(() => buildMontage(data, ["LA1"], "unknown", new Set()), /unsupported montage mode/i);
  assert.throws(() => buildMontage(data, ["LA1"], "referential", new Set(), [0]), /sample rates must be positive and finite/i);
  const emptyAverage = buildMontage(data, ["LA1"], "average", new Set([0]), [1000], [0]);
  assert.deepEqual(emptyAverage.sampleRates, []);
  assert.deepEqual(emptyAverage.sampleStartSecs, []);
});

test("matches MATLAB anatomical acceptance and stable left-right-other ordering", () => {
  const labels = ["RA1", "ECG1", "LA1", "LB2", "RB1", "F3", "X1"];
  assert.deepEqual(labels.map(anatomicalChannelGroup), ["RA", null, "LA", "LB", "RB", null, "X"]);
  assert.deepEqual(orderAnatomicalChannelIndices(labels), [2, 3, 0, 4, 6]);
  assert.deepEqual(
    orderAnatomicalChannelIndices(["C4", "Fp2", "O1", "F7", "Cz", "Fp1", "P3", "T6", "Fz", "ECG1", "T3"]),
    [1, 2, 5, 6, 7, 10],
  );
  assert.deepEqual(orderAnatomicalChannelIndices(["RB2", "LA3", "LA1", "RA2", "LB1", "RA1"]), [1, 2, 4, 0, 3, 5]);
  assert.equal(anatomicalChannelGroup("EEG LA1-REF–EEG LA2-REF"), null);
  assert.equal(anatomicalChannelGroup("SEEG LA1-REF"), null);
  assert.equal(anatomicalChannelGroup("POL RB03"), null);
  assert.equal(anatomicalChannelGroup("Fp1-Fp2"), null);
  assert.deepEqual(orderAnatomicalChannelIndices(["ECG1", "F3", "C4"]), [0, 1, 2], "no valid anatomical contacts preserves source order");
});

test("confines extreme waveform coordinates to exactly one channel row", () => {
  assert.equal(LEGACY_RAW_COUNTS_PER_ROW, 15_000);
  assert.deepEqual(confineTraceYToRow(12, 10, 5), { y: 12, overflow: false });
  assert.deepEqual(confineTraceYToRow(-1_000_000, 10, 5), { y: 10, overflow: true });
  assert.deepEqual(confineTraceYToRow(1_000_000, 10, 5), { y: 15, overflow: true });
  assert.deepEqual(confineTraceYToRow(99, 10, .2), { y: 10.2, overflow: true });
  assert.deepEqual(confineTraceYToRow(Number.NEGATIVE_INFINITY, 10, 5), { y: 10, overflow: true });
  assert.deepEqual(confineTraceYToRow(Number.POSITIVE_INFINITY, 10, 5), { y: 15, overflow: true });
  assert.deepEqual(confineTraceYToRow(Number.NaN, 10, 5), { y: 12.5, overflow: true });
  assert.throws(() => confineTraceYToRow(10, 0, 0), /positive height/i);
});

test("uncalibrated raw DAT remains in source counts", async () => {
  const bytes = new Uint8Array(4);
  const view = new DataView(bytes.buffer);
  view.setInt16(0, 12_345, true);
  view.setInt16(2, -12_345, true);
  const source = await RawDatSource.create(new File([bytes], "legacy.dat"), {
    sampleRate: 2,
    channelCount: 1,
  });
  const window = await source.getWindow(0, 1, [0]);
  assert.equal(source.meta.channelUnits[0], "a.u.");
  assert.deepEqual([...window.data[0]], [12_345, -12_345]);
  assert.match(source.meta.warnings.join("\n"), /raw digital counts/i);
});

test("large raw DAT sessions start with a responsive channel subset", async () => {
  const channelLabels = Array.from({ length: 128 }, (_, index) => `LA${index + 1}`);
  const source = await RawDatSource.create(new File([], "large-session.dat"), {
    sampleRate: 1_250,
    channelCount: channelLabels.length,
    channelLabels,
  });
  assert.equal(source.meta.recommendedDisplayChannels?.length, 18);
  assert.deepEqual(source.meta.recommendedDisplayChannels, Array.from({ length: 18 }, (_, index) => index));
  assert.match(source.meta.warnings.join("\n"), /limited to 18 channels/i);
});

test("calibrated raw DAT applies a strictly positive microvolt scale", async () => {
  const bytes = new Uint8Array(4);
  const view = new DataView(bytes.buffer);
  view.setInt16(0, 1_000, true);
  view.setInt16(2, -1_000, true);
  const file = new File([bytes], "calibrated.dat");
  const source = await RawDatSource.create(file, {
    sampleRate: 2,
    channelCount: 1,
    physicalScale: .195,
  });
  const window = await source.getWindow(0, 1, [0]);
  assert.equal(source.meta.channelUnits[0], "µV");
  assert.deepEqual([...window.data[0]], [195, -195]);
  await assert.rejects(() => RawDatSource.create(file, { sampleRate: 2, channelCount: 1, physicalScale: 0 }), /positive finite/i);
  await assert.rejects(() => RawDatSource.create(file, { sampleRate: 2, channelCount: 1, physicalScale: [1, -1] }), /positive finite/i);
});
