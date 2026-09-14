import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { RawDatSource, parseLegacyMatMetadata } from "../app/eeg-core.ts";
import { describeRawDatLayout, parseRawDatChannelNames } from "../app/raw-dat-mapping.ts";

// Minimal Level-5 fixtures exercise the PI's nested struct contract without patient data.
const join = (...parts) => Buffer.concat(parts);
function tag(type, bytes) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(type, 0);
  header.writeUInt32LE(bytes.length, 4);
  return join(header, bytes, Buffer.alloc((8 - bytes.length % 8) % 8));
}
function matrix(name, kind, dimensions, ...fields) {
  const flags = Buffer.alloc(8);
  flags.writeUInt32LE(kind);
  const dims = Buffer.alloc(dimensions.length * 4);
  dimensions.forEach((value, index) => dims.writeInt32LE(value, index * 4));
  return tag(14, join(tag(6, flags), tag(5, dims), tag(1, Buffer.from(name)), ...fields));
}
function numeric(values) {
  const bytes = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => bytes.writeDoubleLE(value, index * 8));
  return matrix("", 6, [1, values.length], tag(9, bytes));
}
function string(value) {
  return matrix("", 4, [1, value.length], tag(4, Buffer.from(value, "utf16le")));
}
function struct(name, entries) {
  const keys = Object.keys(entries[0]);
  const width = Math.max(...keys.map((key) => key.length)) + 1;
  const length = Buffer.alloc(4);
  length.writeInt32LE(width);
  const names = Buffer.alloc(keys.length * width);
  keys.forEach((key, index) => names.write(key, index * width));
  return matrix(name, 2, [1, entries.length], tag(5, length), tag(1, names),
    ...entries.flatMap((entry) => keys.map((key) => entry[key])));
}
function sessionMat({ rate = [128], count = [3], labels = ["LA1", "LA2", "RA1"], compressed = false } = {}) {
  const session = struct("sessionInfo", [{
    sFile: struct("", [{ header: struct("", [{ sample_rate: numeric(rate), num_channels: numeric(count) }]) }]),
    ChannelMat: struct("", [{ Channel: struct("", labels.map((name) => ({ Name: string(name) }))) }]),
  }]);
  const header = Buffer.alloc(128);
  header.write("MATLAB 5.0 MAT-file, synthetic DAT mapping test");
  header.writeUInt16LE(0x100, 124);
  header.write("IM", 126);
  return new File([header, compressed ? tag(15, deflateSync(session)) : session], "sessionInfo.mat");
}

test("reads the PI's MAT contract and decodes LoadBinary-style interleaved signed samples", async () => {
  for (const compressed of [false, true]) {
    const metadata = await parseLegacyMatMetadata(sessionMat({ compressed }));
    assert.equal(metadata.sampleRate, 128);
    assert.equal(metadata.channelCount, 3);
    assert.deepEqual(metadata.channelLabels, ["LA1", "LA2", "RA1"]);
    const frames = [[-32768, 1234, 32767], [-123, 0, 256], [32767, -32768, -256], [101, 202, 303]];
    const bytes = Buffer.alloc(frames.length * 3 * 2 + 1);
    frames.flat().forEach((value, index) => bytes.writeInt16LE(value, index * 2));
    const source = await RawDatSource.create(new File([bytes], "synthetic.dat"), metadata);
    const window = await source.getWindow(1 / 128, 2 / 128, [2, 0]);
    assert.deepEqual(window.data.map((data) => [...data]), [[256, -256], [-123, 32767]]);
    assert.deepEqual(window.channelStartSecs, [1 / 128, 1 / 128]);
    assert.equal(source.meta.durationSec, 4 / 128);
    assert.equal(source.meta.details.trailingBytes, 1);
    const end = await source.getWindow(3 / 128, 1, [1]);
    assert.deepEqual([...end.data[0]], [202]);
    assert.notEqual(source.meta.channelUnits[0], "µV", "int16 alone does not imply voltage calibration");
  }
});

test("preserves blank and duplicate MAT channel positions instead of shifting later channels", async () => {
  const metadata = await parseLegacyMatMetadata(sessionMat({ labels: ["LA1", "", "LA1"] }));
  assert.deepEqual(metadata.channelLabels, ["LA1", "", "LA1"]);
  const source = await RawDatSource.create(new File([new Uint8Array(6)], "names.dat"), metadata);
  assert.deepEqual(source.meta.channelLabels, ["LA1", "CH002", "LA1"]);
  assert.match(metadata.warnings.join(" "), /Blank channel names/);
});

test("rejects guessed scalar metadata and incomplete channel-name mappings", async () => {
  for (const count of [[2.5], [3, 4], []]) {
    const metadata = await parseLegacyMatMetadata(sessionMat({ count }));
    assert.equal(metadata.channelCount, undefined);
    assert.match(metadata.warnings.join(" "), /num_channels/);
  }
  for (const rate of [[0], [-128], [128, 256], []]) {
    const metadata = await parseLegacyMatMetadata(sessionMat({ rate }));
    assert.equal(metadata.sampleRate, undefined);
  }
  await assert.rejects(RawDatSource.create(new File([new Uint8Array(6)], "names.dat"), {
    channelCount: 3, sampleRate: 128, channelLabels: ["LA1", "RA1"],
  }), /exactly 3 names/);
});

test("supports pasted MATLAB names and previews only explicitly mapped DAT layouts", () => {
  assert.deepEqual(parseRawDatChannelNames("  {'LA1'}\r\n{'LA2'}\r\n{'RA1'}  "), ["LA1", "LA2", "RA1"]);
  assert.deepEqual(parseRawDatChannelNames("LA1\nLA1\nRA1"), ["LA1", "LA1", "RA1"]);
  assert.deepEqual(parseRawDatChannelNames(""), []);
  assert.throws(() => parseRawDatChannelNames("LA1\n\nRA1"), /Channel 2 has no name/);
  assert.deepEqual(describeRawDatLayout(769, 3, 128), { frames: 128, durationSec: 1, trailingBytes: 1 });
  assert.equal(describeRawDatLayout(768, 0, 128), null);
  assert.equal(describeRawDatLayout(768, 3, 0), null);
  assert.equal(describeRawDatLayout(768, 2.5, 128), null);
});

test("DAT confirmation uses edited names and exposes mapping errors before loading", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /aria-label="DAT channel names"/);
  assert.match(page, /channelLabels: datChannelNames\.labels\.length \? datChannelNames\.labels : undefined/);
  assert.match(page, /if \(datChannelNames\.error\)[\s\S]*?return;/);
  assert.match(page, /Boolean\(datChannelNames\.error\) \|\| !datLayout\?\.frames/);
  assert.match(page, /datLayout\.trailingBytes/);
  assert.match(page, /setDatChannelNamesText\(legacyMetadata\?\.channelLabels\.map/);
  assert.match(page, /channel_labels: \[\.\.\.source\.meta\.channelLabels\]/, "manual names participate in the source interpretation identity");
});
