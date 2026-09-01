/**
 * Verifies the pure EDF envelope core used by the browser worker. Fixtures are
 * deterministic in-memory EDF files; no filesystem or browser worker is used.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEDFEnvelopeWindow,
  edfEnvelopeTransferList,
} from "../app/edf-envelope.ts";
import { executeEDFEnvelopeBuild } from "../app/edf-envelope-integrity.ts";
import {
  aggregateEnvelopeWindow,
  parseEDFHeader,
  selectEnvelopePyramidLevel,
} from "../app/eeg-core.ts";
import { sha256Blob } from "../app/source-integrity.ts";

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

function makeEDF(signals, recordCount = 2, recordDurationSec = 1) {
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
  offset = writeFixed(header, offset, "EDF+C", 44);
  offset = writeFixed(header, offset, recordCount, 8);
  offset = writeFixed(header, offset, recordDurationSec, 8);
  writeFixed(header, offset, signalCount, 4);

  offset = 256;
  const fields = [
    ["label", 16, ""],
    ["transducer", 80, ""],
    ["dimension", 8, "a.u."],
    ["physicalMinimum", 8, -1_000],
    ["physicalMaximum", 8, 1_000],
    ["digitalMinimum", 8, -1_000],
    ["digitalMaximum", 8, 1_000],
    ["prefilter", 80, ""],
    ["samplesPerRecord", 8, 2],
    ["signalReserved", 32, ""],
  ];
  for (const [key, width, fallback] of fields) {
    for (const signal of signals) offset = writeFixed(header, offset, signal[key] ?? fallback, width);
  }

  const bytesPerRecord = signals.reduce((sum, signal) => sum + signal.samplesPerRecord * 2, 0);
  const data = new Uint8Array(bytesPerRecord * recordCount);
  const view = new DataView(data.buffer);
  for (let record = 0; record < recordCount; record += 1) {
    let signalOffset = record * bytesPerRecord;
    for (const signal of signals) {
      if (signal.annotationTexts) {
        const encoded = new TextEncoder().encode(signal.annotationTexts[record] ?? "");
        assert.ok(encoded.length <= signal.samplesPerRecord * 2);
        data.set(encoded, signalOffset);
      } else {
        const values = signal.records[record];
        for (let sample = 0; sample < signal.samplesPerRecord; sample += 1) {
          view.setInt16(signalOffset + sample * 2, values[sample], true);
        }
      }
      signalOffset += signal.samplesPerRecord * 2;
    }
  }
  return new File([header, data], "worker-envelope.edf", { lastModified: 1 });
}

function fixtureFile() {
  return makeEDF([
    {
      label: "EEG A",
      dimension: "uV",
      samplesPerRecord: 4,
      records: [[0, 10, -20, 30], [40, -50, 60, -70]],
    },
    {
      label: "EDF Annotations",
      dimension: "a.u.",
      samplesPerRecord: 16,
      annotationTexts: ["+0\u0014Marker\u0014\0", "+1\u0014Marker\u0014\0"],
    },
    {
      label: "EEG B",
      dimension: "mV",
      physicalMinimum: -1,
      physicalMaximum: 1,
      samplesPerRecord: 2,
      records: [[5, -5], [15, -15]],
    },
  ]);
}

function longContinuousFixtureFile(recordCount = 3 * 60 * 60, sampleRate = 200) {
  const headerBytes = 512;
  const header = new Uint8Array(headerBytes).fill(0x20);
  let offset = 0;
  offset = writeFixed(header, offset, "0", 8);
  offset = writeFixed(header, offset, "LONG TEST PATIENT", 80);
  offset = writeFixed(header, offset, "THREE HOUR RECORDING", 80);
  offset = writeFixed(header, offset, "01.01.25", 8);
  offset = writeFixed(header, offset, "00.00.00", 8);
  offset = writeFixed(header, offset, headerBytes, 8);
  offset = writeFixed(header, offset, "EDF+C", 44);
  offset = writeFixed(header, offset, recordCount, 8);
  offset = writeFixed(header, offset, 1, 8);
  writeFixed(header, offset, 1, 4);

  offset = 256;
  const signal = {
    label: "EEG Fp1",
    transducer: "",
    dimension: "uV",
    physicalMinimum: -1_000,
    physicalMaximum: 1_000,
    digitalMinimum: -1_000,
    digitalMaximum: 1_000,
    prefilter: "",
    samplesPerRecord: sampleRate,
    signalReserved: "",
  };
  for (const [key, width] of [
    ["label", 16],
    ["transducer", 80],
    ["dimension", 8],
    ["physicalMinimum", 8],
    ["physicalMaximum", 8],
    ["digitalMinimum", 8],
    ["digitalMaximum", 8],
    ["prefilter", 80],
    ["samplesPerRecord", 8],
    ["signalReserved", 32],
  ]) {
    offset = writeFixed(header, offset, signal[key], width);
  }

  const sampleCount = recordCount * sampleRate;
  const data = new Uint8Array(sampleCount * Int16Array.BYTES_PER_ELEMENT);
  const view = new DataView(data.buffer);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    // The two incommensurate components keep every 20-second window visibly
    // non-flat while remaining deterministic and exactly representable as EDF.
    const value = Math.round(180 * Math.sin(sample * .071) + 55 * Math.sin(sample * .013));
    view.setInt16(sample * Int16Array.BYTES_PER_ELEMENT, value, true);
  }
  return new File([header, data], "three-hour-200hz.edf", { lastModified: 1 });
}

test("builds calibrated mixed-rate EDF envelopes in requested display-channel order", async () => {
  const file = fixtureFile();
  const header = await parseEDFHeader(file);
  const progress = [];
  const result = await buildEDFEnvelopeWindow({
    blob: file,
    header,
    startSec: 0,
    durationSec: 2,
    bucketCount: 4,
    channelIndices: [1, 0],
    chunkSizeBytes: header.bytesPerDataRecord,
  }, {
    onProgress: (entry) => progress.push(entry),
  });

  assert.deepEqual(result.window.channelLabels, ["EEG B", "EEG A"]);
  assert.deepEqual(result.window.channelUnits, ["µV", "µV"]);
  assert.deepEqual(result.window.channelIndices, [1, 0]);
  assert.deepEqual(result.window.sampleRates, [2, 2]);
  assert.deepEqual(result.window.channelStartSecs, [0, 0]);
  assert.equal(result.window.bucketDurationSec, 0.5);
  assert.deepEqual([...result.window.minima[0]], [5, -5, 15, -15]);
  assert.deepEqual([...result.window.maxima[0]], [5, -5, 15, -15]);
  assert.deepEqual([...result.window.data[0]], [5, -5, 15, -15]);
  assert.deepEqual([...result.window.minima[1]], [0, -20, -50, -70]);
  assert.deepEqual([...result.window.maxima[1]], [10, 30, 40, 60]);
  assert.deepEqual([...result.window.data[1]], [5, 5, -5, -5]);
  assert.deepEqual([...result.window.gaps[0]], [0, 0, 0, 0]);
  assert.deepEqual([...result.window.gaps[1]], [0, 0, 0, 0]);
  assert.equal(result.metrics.recordsRead, 2);
  assert.equal(result.metrics.samplesDecoded, 12);
  assert.equal(result.metrics.bytesRead, header.bytesPerDataRecord * 2);
  assert.equal(result.metrics.chunksRead, 2);
  assert.deepEqual(progress.map((entry) => entry.phase), [
    "reading", "decoding", "reading", "decoding", "complete",
  ]);
});

test("three-hour cached EDF overview remains finite after zooming to a 20-second window", { timeout: 30_000 }, async () => {
  const file = longContinuousFixtureFile();
  const header = await parseEDFHeader(file);
  const fullSession = await buildEDFEnvelopeWindow({
    blob: file,
    header,
    startSec: 0,
    durationSec: 3 * 60 * 60,
    bucketCount: 65_536,
    channelIndices: [0],
    pyramidMinimumBucketCount: 64,
  });
  const requiredBucketDurationSec = 20 / 2_048;
  assert.ok(
    fullSession.window.bucketDurationSec > requiredBucketDurationSec * 1.05,
    "the cached full-session overview is intentionally too coarse for this zoom",
  );

  // This mirrors the viewer's local 3x read-ahead cache and 4x refinement when
  // the full-session overview cannot serve a 20-second, 2,048-column window.
  const local = await buildEDFEnvelopeWindow({
    blob: file,
    header,
    startSec: 0,
    durationSec: 60,
    bucketCount: 24_576,
    channelIndices: [0],
    pyramidMinimumBucketCount: 64,
  });
  const level = selectEnvelopePyramidLevel(local.pyramidLevels, requiredBucketDurationSec);
  const visible = aggregateEnvelopeWindow(level, 0, 20, 2_048);

  assert.equal(visible.minima[0].filter(Number.isFinite).length, 2_048);
  assert.equal(visible.maxima[0].filter(Number.isFinite).length, 2_048);
  assert.equal(visible.data[0].filter(Number.isFinite).length, 2_048);
  assert.equal(visible.gaps[0].filter(Boolean).length, 0);
});

test("exposes one ordered full-file chunk stream for shared hashing and indexing", async () => {
  const file = fixtureFile();
  const header = await parseEDFHeader(file);
  const chunks = [];
  const result = await buildEDFEnvelopeWindow({
    blob: file,
    header,
    startSec: 0,
    durationSec: 0.5,
    bucketCount: 2,
    channelIndices: [0],
    chunkSizeBytes: header.bytesPerDataRecord,
  }, {
    scanWholeBlob: true,
    onSourceChunk: ({ bytes, byteStart, byteEnd, section }) => {
      chunks.push({ bytes: bytes.slice(), byteStart, byteEnd, section });
    },
  });

  const sections = chunks.map((chunk) => chunk.section);
  const firstRecordChunk = sections.indexOf("records");
  assert.ok(firstRecordChunk > 0);
  assert.ok(sections.slice(0, firstRecordChunk).every((section) => section === "prefix"));
  assert.deepEqual(sections.slice(firstRecordChunk), ["records", "records"]);
  for (let index = 1; index < chunks.length; index += 1) {
    assert.equal(chunks[index].byteStart, chunks[index - 1].byteEnd);
  }
  const reconstructed = new Uint8Array(file.size);
  for (const chunk of chunks) reconstructed.set(chunk.bytes, chunk.byteStart);
  assert.deepEqual(reconstructed, new Uint8Array(await file.arrayBuffer()));
  assert.equal(result.metrics.bytesRead, file.size);
  assert.equal(result.metrics.totalBytes, file.size);
  assert.equal(result.metrics.recordsRead, header.dataRecordCount);
  assert.equal(result.metrics.samplesDecoded, 2);
});

test("honors an already-aborted envelope request", async () => {
  const file = fixtureFile();
  const header = await parseEDFHeader(file);
  const controller = new AbortController();
  controller.abort(new DOMException("superseded", "AbortError"));
  await assert.rejects(
    buildEDFEnvelopeWindow({
      blob: file,
      header,
      startSec: 0,
      durationSec: 2,
      bucketCount: 4,
    }, { signal: controller.signal }),
    (error) => error?.name === "AbortError",
  );
});

test("shares one full-file pass between exact overview, SHA-256, and EDF+ annotations", async () => {
  const file = fixtureFile();
  const header = await parseEDFHeader(file);
  const result = await executeEDFEnvelopeBuild({
    blob: file,
    header,
    startSec: 0,
    durationSec: header.dataRecordCount * header.dataRecordDurationSec,
    bucketCount: 8,
    channelIndices: [0, 1],
    integrity: { sha256: true, edfAnnotations: true },
  });

  assert.equal(result.metrics.bytesRead, file.size);
  assert.equal(result.metrics.totalBytes, file.size);
  assert.equal(result.integrity?.hash, await sha256Blob(file));
  assert.deepEqual(result.integrity?.edfAnnotations?.events, [
    { label: "Marker", timeSec: 0, durationSec: undefined, source: "edf+" },
    { label: "Marker", timeSec: 1, durationSec: undefined, source: "edf+" },
  ]);
  assert.equal(result.window.data.length, 2);
});

test("builds and transfers an exact finest-to-coarsest EDF pyramid in the worker core", async () => {
  const file = fixtureFile();
  const header = await parseEDFHeader(file);
  const progress = [];
  const result = await buildEDFEnvelopeWindow({
    blob: file,
    header,
    startSec: 0,
    durationSec: 2,
    bucketCount: 8,
    channelIndices: [0],
    pyramidMinimumBucketCount: 2,
  }, {
    onProgress: (entry) => progress.push(entry),
  });

  assert.equal(result.pyramidLevels?.[0], result.window);
  assert.deepEqual(result.pyramidLevels?.map((level) => level.data[0].length), [8, 4, 2]);
  assert.deepEqual([...result.pyramidLevels.at(-1).minima[0]], [-20, -70]);
  assert.deepEqual([...result.pyramidLevels.at(-1).maxima[0]], [30, 60]);
  assert.deepEqual(result.pyramidLevels.map((level) => level.channelLabels), [
    ["EEG A"], ["EEG A"], ["EEG A"],
  ]);
  assert.equal(progress.at(-1).phase, "complete");
  assert.equal(progress.at(-1).decodeMs, result.metrics.decodeMs);

  const transfers = edfEnvelopeTransferList(result);
  assert.equal(transfers.length, 12);
  assert.equal(new Set(transfers).size, transfers.length);
  assert.ok(transfers.every((buffer) => buffer instanceof ArrayBuffer && buffer.byteLength > 0));
});

test("rejects invalid EDF pyramid requests before reading source bytes", async () => {
  const file = fixtureFile();
  const header = await parseEDFHeader(file);
  let reads = 0;
  class TrackingFile extends File {
    slice(...args) {
      reads += 1;
      return super.slice(...args);
    }
  }
  const tracked = new TrackingFile([await file.arrayBuffer()], file.name);
  await assert.rejects(
    buildEDFEnvelopeWindow({
      blob: tracked,
      header,
      startSec: 0,
      durationSec: 2,
      bucketCount: 8,
      pyramidMinimumBucketCount: 0,
    }),
    /pyramid minimum bucket count must be a positive/i,
  );
  assert.equal(reads, 0);
});
