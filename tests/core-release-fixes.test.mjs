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
  anatomicalChannelGroup,
  buildMontage,
  clinicalDecimationFactor,
  confineTraceYToRow,
  decimateClinicalDisplayTrace,
  designClinicalDecimationFir,
  detectEnvelopeSynchronizedFlatlines,
  detectRawSynchronizedFlatlines,
  makeId,
  normalizeEDFPhysicalDimension,
  orderAnatomicalChannelIndices,
  parseEDFHeader,
  prepareClinicalDisplaySignals,
} from "../app/eeg-core.ts";

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

test("referential montage retains QC-marked channels while derived montages exclude them", () => {
  const data = [
    new Float32Array([1, 2]),
    new Float32Array([3, 4]),
    new Float32Array([5, 6]),
  ];
  const labels = ["LA1", "LA2", "LA3"];
  const bad = new Set([1]);
  const starts = [4, 4, 4];
  const referential = buildMontage(data, labels, "referential", bad, [1000, 1000, 1000], starts);
  assert.deepEqual(referential.labels, labels);
  assert.deepEqual(referential.primarySourceIndices, [0, 1, 2]);
  assert.deepEqual(referential.sampleStartSecs, starts);
  assert.equal(referential.data[0], data[0], "referential rows must retain the original sample buffer");
  assert.equal(referential.data[1], data[1]);

  const average = buildMontage(data, labels, "average", bad, [1000, 1000, 1000], starts);
  assert.deepEqual(average.primarySourceIndices, [0, 2]);
  assert.deepEqual(average.sampleStartSecs, [4, 4]);
  assert.throws(
    () => buildMontage(data, labels, "average", new Set(), [1000, 1000, 1000], [4, 4.001, 4]),
    /aligned sample start times/i,
  );

  const bipolar = buildMontage(data, labels, "bipolar", bad, [1000, 1000, 1000], starts);
  assert.equal(bipolar.data.length, 0, "a bad LA2 contact must not be bridged from LA1 to LA3");

  const misalignedBipolar = buildMontage(
    data.slice(0, 2),
    labels.slice(0, 2),
    "bipolar",
    new Set(),
    [1000, 1000],
    [4, 4.001],
  );
  assert.equal(misalignedBipolar.data.length, 0);
  assert.match(misalignedBipolar.warnings.join("\n"), /sample start times.*not aligned/i);
});

test("orders legacy contact channels left then right while applying MATLAB group exclusions", () => {
  const labels = ["RA1", "ECG1", "LA1", "LB2", "RB1", "F3", "X1"];
  assert.deepEqual(labels.map(anatomicalChannelGroup), ["RA", null, "LA", "LB", "RB", null, "X"]);
  assert.deepEqual(orderAnatomicalChannelIndices(labels), [2, 3, 0, 4, 6, 1, 5]);
  assert.equal(anatomicalChannelGroup("EEG LA1-REF–EEG LA2-REF"), "LA");
  assert.equal(anatomicalChannelGroup("Fp1-Fp2"), "FP");
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
