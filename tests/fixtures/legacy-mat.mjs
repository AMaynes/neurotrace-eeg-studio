import { deflateSync } from "node:zlib";

// Patient-free Level-5 writers cover nested acquisition metadata and MATLAB's
// zero-byte miMATRIX representation for unset fields/cells.
export function matWriter(littleEndian = true) {
  const endian = littleEndian ? "LE" : "BE";
  const concat = (...parts) => Buffer.concat(parts);
  function integers(values, signed = false) {
    const bytes = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => bytes[`write${signed ? "Int" : "UInt"}32${endian}`](value, index * 4));
    return bytes;
  }
  function tag(type, bytes, { padded = true, small = true } = {}) {
    if (small && bytes.length > 0 && bytes.length <= 4 && type !== 14 && type !== 15) {
      const result = Buffer.alloc(8);
      result[`writeUInt32${endian}`]((bytes.length << 16) | type);
      bytes.copy(result, 4);
      return result;
    }
    return concat(integers([type, bytes.length]), bytes,
      Buffer.alloc(padded ? (8 - bytes.length % 8) % 8 : 0));
  }
  function matrix(name, kind, dimensions, ...contents) {
    return tag(14, concat(tag(6, integers([kind, 0])), tag(5, integers(dimensions, true)),
      tag(1, Buffer.from(name)), ...contents));
  }
  function numeric(values, { name = "", dimensions = [1, values.length] } = {}) {
    const bytes = Buffer.alloc(values.length * 8);
    values.forEach((value, index) => bytes[`writeDouble${endian}`](value, index * 8));
    return matrix(name, 6, dimensions, tag(9, bytes));
  }
  function string(value, name = "") {
    const bytes = Buffer.alloc(value.length * 2);
    Array.from(value).forEach((character, index) => bytes[`writeUInt16${endian}`](character.charCodeAt(0), index * 2));
    return matrix(name, 4, [1, value.length], tag(4, bytes));
  }
  function struct(name, entries, keys = Object.keys(entries[0] ?? {})) {
    const width = Math.max(1, ...keys.map((key) => key.length + 1));
    const names = Buffer.alloc(keys.length * width);
    keys.forEach((key, index) => names.write(key, index * width));
    return matrix(name, 2, [1, entries.length], tag(5, integers([width], true)), tag(1, names),
      ...entries.flatMap((entry) => keys.map((key) => entry[key])));
  }
  function cell(values, name = "") {
    return matrix(name, 1, [1, values.length], ...values);
  }
  function file(elements, name, { compressed = false, padded = false } = {}) {
    const header = Buffer.alloc(128);
    header.write("MATLAB 5.0 MAT-file, synthetic compatibility test (no patient data)");
    header[`writeUInt16${endian}`](0x100, 124);
    header.write(littleEndian ? "IM" : "MI", 126);
    return new File([header, ...elements.map((element) => compressed
      ? tag(15, deflateSync(element), { padded }) : element)], name);
  }
  return { integers, tag, matrix, numeric, string, struct, cell, file, unset: () => tag(14, Buffer.alloc(0)) };
}

export function legacyMatFile({
  name = "synthetic.mat", sampleRate = 1000, channelCount = 157,
  labels = Array.from({ length: 157 }, (_, index) => `SYN${index + 1}`),
  compressed = false, littleEndian = true, unsetFields = true, missingHeader = false,
  standaloneSignal = false,
} = {}) {
  const writer = matWriter(littleEndian);
  const { numeric, string, struct, cell } = writer;
  const empty = unsetFields ? writer.unset : () => numeric([]);
  const header = {
    device: string("Synthetic amplifier"), version: numeric([2]),
    ctl: struct("", [{ unused: empty(), values: cell([empty(), numeric([])]) }]),
    ...(sampleRate === null ? {} : { sample_rate: numeric([sampleRate]) }),
    ...(channelCount === null ? {} : { num_channels: numeric([channelCount]) }),
    logs: struct("", [{ entries: cell([]) }]),
    channel_gains: numeric(Array(157).fill(1)),
    channel_digoffset: numeric(Array(158).fill(0)),
    patient: struct("", [{}]),
  };
  const session = struct("sessionInfo", [{
    sFile: struct("", [{
      filename: string("N:\\Unavailable\\Synthetic\\synthetic.EEG"),
      format: string("EEG-NK"), byteorder: string("n"),
      condition: empty(), prop: struct("", []), epochs: cell([]),
      events: struct("", [
        { label: string("Synthetic onset"), times: numeric([0.001]), color: numeric([1, 0, 0]), unused: empty() },
        { label: string("Synthetic end"), times: numeric([0.003, 0.004]), color: numeric([0, 1, 0]), unused: cell([empty()]) },
      ]),
      ...(missingHeader ? {} : { header: struct("", [header]) }),
      channelflag: numeric(Array(labels.length).fill(1)),
    }]),
    ChannelMat: struct("", [{
      Comment: string("Synthetic metadata"), MegRefCoef: empty(), Projector: struct("", []),
      TransfMeg: cell([empty(), numeric([])]), HeadPoints: struct("", [{ Loc: numeric([]) }]),
      Channel: struct("", labels.map((label) => ({
        Name: string(label), Comment: empty(), Type: string("SEEG"), Group: string("SYN"),
        Loc: numeric([0, 0, 0], { dimensions: [3, 1] }), Orient: numeric([]), Weight: numeric([1]),
      }))),
      IntraElectrodes: struct("", []), History: cell([empty(), string("Synthetic")]),
    }]),
    ...(standaloneSignal === "nested" ? {
      recordedSamples: numeric([1, 10, 2, 20, 3, 30, 4, 40], { dimensions: [2, 4] }),
    } : {}),
  }]);
  const elements = standaloneSignal ? [session,
    numeric([128], { name: "Fs" }),
    ...(standaloneSignal === "nested" ? [] : [numeric([1, 10, 2, 20, 3, 30, 4, 40], { name: "recordedSamples", dimensions: [2, 4] })]),
  ] : [session];
  return writer.file(elements, name, { compressed });
}

export function standaloneMatFile({ name = "standalone.mat", compressed = false, littleEndian = true } = {}) {
  const writer = matWriter(littleEndian);
  return writer.file([
    writer.numeric([128], { name: "Fs" }),
    writer.numeric([1, 10, 2, 20, 3, 30, 4, 40], { name: "data", dimensions: [2, 4] }),
    writer.struct("notes", [{ unused: writer.unset(), cells: writer.cell([writer.unset(), writer.string("test")]) }]),
  ], name, { compressed });
}
