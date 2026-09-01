/** Exact parity and worker-wiring checks for file-backed sample windows. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildEDFFileWindow,
  buildFileWindow,
  buildRawDatFileWindow,
  FILE_WINDOW_HOST_IS_LITTLE_ENDIAN,
  fileWindowTransferList,
} from "../app/file-window.ts";
import { EDFSource, RawDatSource } from "../app/eeg-core.ts";

function putFixed(target, start, width, value) {
  const encoded = new TextEncoder().encode(String(value).padEnd(width, " ").slice(0, width));
  target.set(encoded, start);
}

function makeMixedRateEDF() {
  const signals = [
    {
      label: "EEG A",
      dimension: "uV",
      physicalMinimum: -100,
      physicalMaximum: 100,
      digitalMinimum: -100,
      digitalMaximum: 100,
      samplesPerRecord: 4,
      records: [[0, 10, -20, 30], [40, -50, 60, -70]],
    },
    {
      label: "EDF Annotations",
      dimension: "a.u.",
      physicalMinimum: -32768,
      physicalMaximum: 32767,
      digitalMinimum: -32768,
      digitalMaximum: 32767,
      samplesPerRecord: 4,
      records: [[0, 0, 0, 0], [0, 0, 0, 0]],
    },
    {
      label: "EEG B",
      dimension: "mV",
      physicalMinimum: -1,
      physicalMaximum: 1,
      digitalMinimum: -100,
      digitalMaximum: 100,
      samplesPerRecord: 2,
      records: [[5, -5], [15, -15]],
    },
  ];
  const signalCount = signals.length;
  const headerBytes = 256 + signalCount * 256;
  const header = new Uint8Array(headerBytes);
  header.fill(32);
  putFixed(header, 0, 8, "0");
  putFixed(header, 8, 80, "patient");
  putFixed(header, 88, 80, "recording");
  putFixed(header, 168, 8, "01.01.24");
  putFixed(header, 176, 8, "00.00.00");
  putFixed(header, 184, 8, headerBytes);
  putFixed(header, 192, 44, "EDF+C");
  putFixed(header, 236, 8, 2);
  putFixed(header, 244, 8, 1);
  putFixed(header, 252, 4, signalCount);

  let fieldOffset = 256;
  const writeField = (width, values) => {
    values.forEach((value, index) => putFixed(header, fieldOffset + index * width, width, value));
    fieldOffset += width * signalCount;
  };
  writeField(16, signals.map((signal) => signal.label));
  writeField(80, signals.map(() => ""));
  writeField(8, signals.map((signal) => signal.dimension));
  writeField(8, signals.map((signal) => signal.physicalMinimum));
  writeField(8, signals.map((signal) => signal.physicalMaximum));
  writeField(8, signals.map((signal) => signal.digitalMinimum));
  writeField(8, signals.map((signal) => signal.digitalMaximum));
  writeField(80, signals.map(() => ""));
  writeField(8, signals.map((signal) => signal.samplesPerRecord));
  writeField(32, signals.map(() => ""));

  const bytesPerRecord = signals.reduce((sum, signal) => sum + signal.samplesPerRecord * 2, 0);
  const data = new Uint8Array(bytesPerRecord * 2);
  const view = new DataView(data.buffer);
  for (let record = 0; record < 2; record += 1) {
    let byteOffset = record * bytesPerRecord;
    for (const signal of signals) {
      for (const digital of signal.records[record]) {
        view.setInt16(byteOffset, digital, true);
        byteOffset += 2;
      }
    }
  }
  return new File([header, data], "mixed-rate.edf", { lastModified: 1 });
}

function rawDatBlob(frames) {
  const channelCount = frames[0]?.length ?? 0;
  const bytes = new Uint8Array(frames.length * channelCount * 2);
  const view = new DataView(bytes.buffer);
  frames.forEach((frame, frameIndex) => frame.forEach((value, channelIndex) => {
    view.setInt16((frameIndex * channelCount + channelIndex) * 2, value, true);
  }));
  return new Blob([bytes]);
}

function assertWindowExactlyMatches(actual, expected) {
  assert.deepEqual(
    actual.data.map((channel) => [...channel]),
    expected.data.map((channel) => [...channel]),
  );
  assert.deepEqual(actual.sampleRates, expected.sampleRates);
  assert.deepEqual(actual.channelStartSecs, expected.channelStartSecs);
  assert.equal(actual.startSec, expected.startSec);
  assert.equal(actual.durationSec, expected.durationSec);
  assert.deepEqual(actual.channelIndices, expected.channelIndices);
  assert.deepEqual(actual.channelLabels, expected.channelLabels);
  assert.deepEqual(actual.channelUnits, expected.channelUnits);
}

test("EDF worker core exactly matches mixed-rate calibrated source windows", async () => {
  const file = makeMixedRateEDF();
  const source = await EDFSource.create(file, { parseAnnotations: false });
  const expected = await source.getWindow(0.25, 1.2, [1, 0]);
  const updates = [];
  const result = await buildEDFFileWindow({
    format: "edf",
    blob: file,
    header: source.header,
    startSec: 0.25,
    durationSec: 1.2,
    channelIndices: [1, 0],
    chunkSizeBytes: source.header.bytesPerDataRecord,
  }, {
    onProgress: (update) => updates.push(update),
  });

  assertWindowExactlyMatches(result.window, expected);
  assert.deepEqual(result.window.sampleRates, [2, 4]);
  assert.deepEqual(result.window.channelStartSecs, [0, 0.25]);
  assert.deepEqual([...result.window.data[0]], [50, -50, 150]);
  assert.deepEqual([...result.window.data[1]], [10, -20, 30, 40, -50]);
  assert.equal(result.metrics.backend, "direct");
  assert.equal(
    result.metrics.decoder,
    FILE_WINDOW_HOST_IS_LITTLE_ENDIAN ? "int16-array" : "data-view",
  );
  assert.equal(result.metrics.bytesRead, source.header.bytesPerDataRecord * 2);
  assert.equal(result.metrics.totalBytes, source.header.bytesPerDataRecord * 2);
  assert.equal(result.metrics.samplesDecoded, 8);
  assert.equal(result.metrics.totalSamples, 8);
  assert.equal(result.metrics.chunksRead, 2);
  assert.ok(result.metrics.readMs >= 0);
  assert.ok(result.metrics.decodeMs >= 0);
  assert.ok(result.metrics.elapsedMs >= result.metrics.readMs);
  assert.deepEqual(updates.map((update) => update.phase), [
    "reading", "decoding", "reading", "decoding", "complete",
  ]);
  assert.equal(updates.at(-1).bytesRead, result.metrics.bytesRead);
  assert.equal(updates.at(-1).samplesDecoded, result.metrics.samplesDecoded);
});

test("EDF native and portable decoders return byte-for-byte-equal Float32 output", async () => {
  const file = makeMixedRateEDF();
  const source = await EDFSource.create(file, { parseAnnotations: false });
  const request = {
    format: "edf",
    blob: file,
    header: source.header,
    startSec: -2,
    durationSec: 99,
    channelIndices: [0, 1],
  };
  const automatic = await buildEDFFileWindow(request);
  const portable = await buildEDFFileWindow(request, { decoder: "portable-data-view" });
  assert.equal(portable.metrics.decoder, "data-view");
  assert.deepEqual(
    automatic.window.data.map((channel) => new Uint8Array(channel.buffer)),
    portable.window.data.map((channel) => new Uint8Array(channel.buffer)),
  );
});

test("Raw DAT worker core exactly matches calibrated selected source windows", async () => {
  const frames = [
    [1, 100, -10],
    [3, 90, -20],
    [-5, 80, -30],
    [7, 70, -40],
    [9, 60, -50],
    [11, 50, -60],
    [13, 40, -70],
    [15, 30, -80],
  ];
  const blob = rawDatBlob(frames);
  const file = new File([blob], "calibrated.dat");
  const source = await RawDatSource.create(file, {
    sampleRate: 4,
    channelCount: 3,
    channelLabels: ["A", "B", "C"],
    channelUnits: ["µV", "mV", "count"],
    physicalScale: [2, 0.5, 1],
    physicalOffset: [1, -10, 5],
  });
  const expected = await source.getWindow(0.25, 1.25, [2, 0]);
  const updates = [];
  const result = await buildRawDatFileWindow({
    format: "raw-dat",
    ...source.envelopeWorkerSource,
    startSec: 0.25,
    durationSec: 1.25,
    channelIndices: [2, 0],
    chunkSizeBytes: 12,
  }, {
    onProgress: (update) => updates.push(update),
  });

  assertWindowExactlyMatches(result.window, expected);
  assert.deepEqual([...result.window.data[0]], [-15, -25, -35, -45, -55]);
  assert.deepEqual([...result.window.data[1]], [7, -9, 15, 19, 23]);
  assert.equal(result.metrics.bytesRead, 30);
  assert.equal(result.metrics.totalBytes, 30);
  assert.equal(result.metrics.samplesDecoded, 10);
  assert.equal(result.metrics.totalSamples, 10);
  assert.equal(result.metrics.chunksRead, 3);
  assert.deepEqual(updates.map((update) => update.phase), [
    "reading", "decoding", "reading", "decoding", "reading", "decoding", "complete",
  ]);
});

test("unified builder preserves empty selection semantics and aborts before I/O", async () => {
  class TrackingBlob extends Blob {
    reads = 0;
    slice(...args) {
      this.reads += 1;
      return super.slice(...args);
    }
  }
  const blob = new TrackingBlob([rawDatBlob([[1, 2], [3, 4]])]);
  const request = {
    format: "raw-dat",
    blob,
    sampleRate: 2,
    channelCount: 2,
    channelLabels: ["A", "B"],
    channelUnits: ["count", "count"],
    physicalScales: [1, 1],
    physicalOffsets: [0, 0],
    startSec: 0,
    durationSec: 1,
    channelIndices: [],
  };
  const empty = await buildFileWindow(request);
  assert.deepEqual(empty.window.data, []);
  assert.equal(empty.window.durationSec, 1);
  assert.equal(empty.metrics.bytesRead, 0);
  assert.equal(empty.metrics.totalBytes, 0);
  assert.equal(blob.reads, 0);

  const controller = new AbortController();
  controller.abort(new DOMException("superseded", "AbortError"));
  await assert.rejects(
    buildFileWindow({ ...request, channelIndices: [0] }, { signal: controller.signal }),
    (error) => error?.name === "AbortError",
  );
  assert.equal(blob.reads, 0);
});

test("file window result transfers each decoded channel exactly once", async () => {
  const blob = rawDatBlob([[1, 2, 3], [4, 5, 6]]);
  const result = await buildRawDatFileWindow({
    format: "raw-dat",
    blob,
    sampleRate: 2,
    channelCount: 3,
    channelLabels: ["A", "B", "C"],
    channelUnits: ["count", "count", "count"],
    physicalScales: [1, 1, 1],
    physicalOffsets: [0, 0, 0],
    startSec: 0,
    durationSec: 1,
    channelIndices: [2, 0],
  });
  const transfer = fileWindowTransferList(result);
  assert.equal(transfer.length, 2);
  assert.equal(new Set(transfer).size, 2);
  assert.ok(transfer.every((buffer) => buffer instanceof ArrayBuffer && buffer.byteLength > 0));
});

test("unified worker transfers arrays, reports progress, and terminates on abort", async () => {
  const client = await readFile(new URL("../app/file-window-worker-client.ts", import.meta.url), "utf8");
  const worker = await readFile(new URL("../app/file-window-worker.ts", import.meta.url), "utf8");
  assert.match(client, /new Worker\(new URL\("\.\/file-window-worker\.ts"/);
  assert.match(client, /const onAbort = \(\) => finish\(\(\) => reject\(abortReason/);
  assert.match(client, /worker\.terminate\(\)/);
  assert.match(worker, /fileWindowTransferList\(result\)/);
  assert.match(worker, /type: "progress"/);
  assert.match(worker, /backend: "worker"/);
});
