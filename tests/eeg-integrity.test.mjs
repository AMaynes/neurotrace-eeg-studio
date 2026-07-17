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

test("omits unsafe mixed-rate bipolar derivations", () => {
  const montage = buildMontage(
    [new Float32Array([1, 2, 3, 4]), new Float32Array([1, 2])],
    ["LA1", "LA2"],
    "bipolar",
    new Set(),
    [256, 128],
  );

  assert.equal(montage.data.length, 0);
  assert.match(montage.warnings.join("\n"), /cannot be subtracted without resampling/i);
});
