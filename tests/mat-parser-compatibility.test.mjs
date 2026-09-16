import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { MatSource, RawDatSource, inspectLegacyMatMetadata, inspectMatRecording, parseLegacyMatMetadata } from "../app/eeg-core.ts";
import { legacyMatFile, matWriter, standaloneMatFile } from "./fixtures/legacy-mat.mjs";

test("reads nested 157-channel legacy metadata with unset fields and empty containers", async () => {
  for (const compressed of [false, true]) {
    for (const littleEndian of [true, false]) {
      const file = legacyMatFile({ compressed, littleEndian });
      const metadata = await parseLegacyMatMetadata(file);
      assert.equal(metadata.sampleRate, 1000);
      assert.equal(metadata.channelCount, 157, "the 158-element offsets array is not a channel count");
      assert.equal(metadata.channelEntryCount, 157);
      assert.deepEqual(metadata.channelLabels, Array.from({ length: 157 }, (_, index) => `SYN${index + 1}`));
      assert.deepEqual(metadata.events, [
        { label: "Synthetic onset", timeSec: 0.001 }, { label: "Synthetic end", timeSec: 0.003 },
      ]);
      assert.deepEqual(metadata.warnings, []);
      const inspected = await inspectMatRecording(file);
      assert.equal(inspected.kind, "legacy", "do not select gains, offsets, or channel locations as EEG");
      assert.deepEqual(inspected.metadata, metadata);
      const bytes = Buffer.alloc(157 * 5 * 2);
      for (let frame = 0; frame < 5; frame += 1) {
        for (let channel = 0; channel < 157; channel += 1) bytes.writeInt16LE(frame * 157 + channel - 300, (frame * 157 + channel) * 2);
      }
      const source = await RawDatSource.create(new File([bytes], "synthetic.dat"), metadata);
      assert.equal(source.meta.channelCount, 157);
      assert.equal(source.meta.durationSec, 0.005);
      const window = await source.getWindow(0.001, 0.003, [0, 99, 100, 156]);
      assert.deepEqual(window.data.map((values) => [...values]), [
        [-143, 14, 171], [-44, 113, 270], [-43, 114, 271], [13, 170, 327],
      ]);
    }
  }
});

test("preserves standalone MAT waveforms with nested empty metadata in both endian formats", async () => {
  for (const compressed of [false, true]) {
    for (const littleEndian of [true, false]) {
      const file = standaloneMatFile({ compressed, littleEndian });
      assert.equal(await inspectLegacyMatMetadata(file), null);
      const result = await inspectMatRecording(file);
      assert.equal(result.kind, "standalone");
      const direct = await MatSource.create(file);
      for (const source of [direct, result.source]) {
        assert.equal(source.meta.sampleRate, 128);
        assert.equal(source.meta.channelCount, 2);
        assert.deepEqual((await source.getWindow(0, 1)).data.map((values) => [...values]), [[1, 2, 3, 4], [10, 20, 30, 40]]);
      }
    }
  }
});

test("detects incomplete legacy containers without guessing fields from other arrays", async () => {
  for (const options of [{ sampleRate: null }, { channelCount: null }, { missingHeader: true }]) {
    const metadata = await inspectLegacyMatMetadata(legacyMatFile(options));
    assert.ok(metadata, "known sessionInfo schema must not fall through to standalone numeric selection");
    if (options.sampleRate === null || options.missingHeader) assert.equal(metadata.sampleRate, undefined);
    if (options.channelCount === null || options.missingHeader) assert.equal(metadata.channelCount, undefined);
    assert.ok(metadata.warnings.length > 0);
  }
});

test("supports padded and unpadded consecutive compressed variables, including big-endian tags", async () => {
  for (const littleEndian of [true, false]) {
    const writer = matWriter(littleEndian);
    // In big-endian files the first three bytes of the next full tag are zero.
    // They must not be mistaken for 1-3 bytes of compressed-stream padding.
    let signal;
    for (let marker = 0; marker < 1000; marker += 1) {
      const candidate = writer.numeric([1, 10, 2, 20, 3, 30, 4, marker], { name: "data", dimensions: [2, 4] });
      if (deflateSync(candidate).length % 8 >= 5) { signal = candidate; break; }
    }
    assert.ok(signal);
    for (const padded of [false, true]) {
      const source = await MatSource.create(writer.file([signal, writer.numeric([512], { name: "Fs" })], "compressed.mat", { compressed: true, padded }));
      assert.equal(source.meta.sampleRate, 512);
      assert.deepEqual([...(await source.getWindow(0, 1)).data[0]], [1, 2, 3, 4]);
    }
  }
});

test("continues rejecting nonempty malformed nested matrices and unnamed empty top-level matrices", async () => {
  const writer = matWriter();
  const malformed = writer.tag(14, writer.tag(6, writer.integers([6, 0])));
  for (const element of [writer.unset(), writer.struct("sessionInfo", [{ sFile: malformed }])]) {
    await assert.rejects(inspectMatRecording(writer.file([element], "malformed.mat")), /missing flags, dimensions, or name/);
  }
  const shortData = writer.matrix("data", 6, [2, 4], writer.tag(9, Buffer.alloc(8)));
  await assert.rejects(MatSource.create(writer.file([shortData], "truncated.mat")), /shorter than its declared dimensions/);
});

test("combined MAT inspection reads the full standalone file only once", async () => {
  const file = standaloneMatFile({ compressed: true });
  let reads = 0;
  const read = file.arrayBuffer.bind(file);
  file.arrayBuffer = () => { reads += 1; return read(); };
  assert.equal((await inspectMatRecording(file)).kind, "standalone");
  assert.equal(reads, 1);
});

test("opens real standalone signals alongside legacy metadata without selecting larger header arrays", async () => {
  for (const compressed of [false, true]) {
    for (const littleEndian of [true, false]) {
      const file = legacyMatFile({ standaloneSignal: true, compressed, littleEndian });
      assert.equal(await inspectLegacyMatMetadata(file), null);
      const inspected = await inspectMatRecording(file);
      assert.equal(inspected.kind, "standalone", "sessionInfo presence does not override actual independent signals");
      const direct = await MatSource.create(file);
      for (const source of [inspected.source, direct]) {
        assert.equal(source.matrixName, "recordedSamples", "arbitrarily named signal beats larger legacy gain/offset arrays");
        assert.equal(source.meta.sampleRate, 128);
        assert.equal(source.meta.channelCount, 2);
        assert.deepEqual((await source.getWindow(0, 1)).data.map((values) => [...values]), [[1, 2, 3, 4], [10, 20, 30, 40]]);
      }
    }
  }
  await assert.rejects(MatSource.create(legacyMatFile()), { code: "NO_SIGNAL_MATRIX" },
    "direct standalone creation must never turn metadata arrays into EEG");
});

test("preserves real signals within sessionInfo outside the acquisition metadata branches", async () => {
  const file = legacyMatFile({ standaloneSignal: "nested", compressed: true });
  assert.equal(await inspectLegacyMatMetadata(file), null);
  const inspected = await inspectMatRecording(file);
  assert.equal(inspected.kind, "standalone");
  assert.equal(inspected.source.matrixName, "sessionInfo.recordedSamples");
  assert.deepEqual((await inspected.source.getWindow(0, 1)).data.map((values) => [...values]), [[1, 2, 3, 4], [10, 20, 30, 40]]);
});

test("reports Channel struct count independently from rows in channel-name text", async () => {
  const writer = matWriter();
  const nameRows = writer.matrix("", 4, [2, 1], writer.tag(4, Buffer.from("AB", "utf16le")));
  const session = writer.struct("sessionInfo", [{
    sFile: writer.struct("", [{ header: writer.struct("", [{ sample_rate: writer.numeric([128]), num_channels: writer.numeric([2]) }]) }]),
    ChannelMat: writer.struct("", [{ Channel: writer.struct("", [{ Name: nameRows }]) }]),
  }]);
  const metadata = await parseLegacyMatMetadata(writer.file([session], "invalid-channel-shape.mat"));
  assert.equal(metadata.channelCount, 2);
  assert.equal(metadata.channelEntryCount, 1);
  assert.deepEqual(metadata.channelLabels, ["A", "B"]);
  assert.match(metadata.warnings.join(" "), /contains 1 Channel structure entries/);
});
