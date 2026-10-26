/**
 * Overview & Purpose
 * Verifies EDF+ event decoding and montage safety rules.
 *
 * Architectural Relationships
 * Called by: Node's built-in test runner.
 * Calls: Public signal-domain operations from app/eeg-core.ts.
 *
 * External Resources
 * None; fixtures are deterministic in-memory data.
 *
 * Notes
 * Tests avoid filesystem and timing dependencies.
 */


import assert from "node:assert/strict";
import test from "node:test";

import { buildMontage, parseEDFAnnotations } from "../app/eeg-core.ts";

test("decodes EDF+ TAL annotations and ignores record timekeeping entries", async () => {
  const bytes = new Uint8Array(128);
  const tal = new TextEncoder().encode("+0\u0014\u0014\0+12.5\u00151.25\u0014Button push\u0014\0+18\u0014ASM given\u0014\0");
  bytes.set(tal);
  const signal = {
    index: 0,
    label: "EDF Annotations",
    transducer: "",
    physicalDimension: "",
    physicalMinimum: -1,
    physicalMaximum: 1,
    digitalMinimum: -32768,
    digitalMaximum: 32767,
    prefilter: "",
    samplesPerRecord: 64,
    sampleRate: 64,
    reserved: "",
    isAnnotation: true,
    byteOffsetInRecord: 0,
  };
  const header = {
    version: "0",
    patientIdentification: "",
    recordingIdentification: "",
    startDateText: "",
    startTimeText: "",
    headerBytes: 0,
    reserved: "EDF+C",
    declaredDataRecordCount: 1,
    dataRecordCount: 1,
    dataRecordDurationSec: 1,
    signalCount: 1,
    signals: [signal],
    bytesPerDataRecord: 128,
    isEDFPlus: true,
    isDiscontinuous: false,
    warnings: [],
  };

  const parsed = await parseEDFAnnotations(new Blob([bytes]), header);
  assert.deepEqual(parsed.events, [
    { label: "Button push", timeSec: 12.5, durationSec: 1.25, source: "edf+" },
    { label: "ASM given", timeSec: 18, durationSec: undefined, source: "edf+" },
  ]);
  assert.deepEqual(parsed.warnings, []);
});

test("omits unsafe mixed-rate bipolar arithmetic and falls back to recorded channels", () => {
  const montage = buildMontage(
    [new Float32Array([1, 2, 3, 4]), new Float32Array([1, 2])],
    ["LA1", "LA2"],
    "bipolar",
    new Set(),
    [256, 128],
  );

  assert.deepEqual(montage.labels, ["LA1", "LA2"]);
  assert.equal(montage.data.length, 2);
  assert.match(montage.warnings.join("\n"), /cannot be subtracted without resampling/i);
});

test("EDF label discovery reads only sparse annotations, even for a multi-gigabyte recording", async () => {
  const recordCount = 600;
  const recordBytes = 8 * 1024 * 1024;
  const annotationBytes = 64;
  const headerBytes = 768;
  const ranges = [];
  // A virtual 4.7 GiB recording: any attempt to read EEG bytes fails, without
  // allocating that payload in the regression test.
  const file = { slice(start, end) {
    const record = Math.floor((start - headerBytes) / recordBytes);
    assert.equal(start, headerBytes + record * recordBytes + recordBytes - annotationBytes);
    assert.equal(end - start, annotationBytes);
    ranges.push([start, end]);
    const bytes = new Uint8Array(annotationBytes);
    bytes.set(new TextEncoder().encode(`+${record}\x14Marker β\x14\0`));
    return new Blob([bytes]);
  } };
  const header = { headerBytes, dataRecordCount: recordCount, bytesPerDataRecord: recordBytes,
    signals: [{ isAnnotation: false }, { isAnnotation: true, samplesPerRecord: annotationBytes / 2,
      byteOffsetInRecord: recordBytes - annotationBytes }] };
  const parsed = await parseEDFAnnotations(file, header);
  assert.equal(parsed.events.length, recordCount);
  assert.equal(parsed.events[0].label, "Marker β");
  assert.equal(parsed.events.at(-1).timeSec, recordCount - 1);
  assert.equal(ranges.reduce((sum, [start, end]) => sum + end - start, 0), 38_400);
  assert.deepEqual(parsed.warnings, []);
});

test("batched EDF annotations retain record boundaries, deduplicate, and sort multiple channels", async () => {
  const encoder = new TextEncoder();
  const tal = (text) => {
    const bytes = new Uint8Array(64);
    bytes.set(encoder.encode(text));
    return bytes;
  };
  const file = new Blob([
    tal("+10\x14Repeated\x14\0+2\x152\x14Interval\x14\0"),
    tal("+10\x14Repeated\x14\0+1\x14First\x14\0"),
    tal("+0\x14\x14\0"), tal("+10\x14Repeated\x14\0"),
  ]);
  const header = { headerBytes: 0, dataRecordCount: 2, bytesPerDataRecord: 128,
    signals: [0, 64].map((offset) => ({ isAnnotation: true, samplesPerRecord: 32, byteOffsetInRecord: offset })) };
  const parsed = await parseEDFAnnotations(file, header);
  assert.deepEqual(parsed.events.map((event) => [event.label, event.timeSec, event.durationSec]), [
    ["First", 1, undefined], ["Interval", 2, 2], ["Repeated", 10, undefined],
  ]);
});

test("EDF metadata reads honor cancellation and reject truncated annotations", async () => {
  const header = { headerBytes: 0, dataRecordCount: 1, bytesPerDataRecord: 128,
    signals: [{ isAnnotation: true, samplesPerRecord: 64, byteOffsetInRecord: 0 }] };
  const controller = new AbortController();
  const file = { slice() { controller.abort(); return new Blob([new Uint8Array(128)]); } };
  await assert.rejects(parseEDFAnnotations(file, header, { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(parseEDFAnnotations(new Blob([new Uint8Array(64)]), header), /annotation data is incomplete/);
});
