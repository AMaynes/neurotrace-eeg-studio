/**
 * Selective Level-5 MAT traversal for directory event indexing. Numeric signal
 * payloads are skipped, not decoded (bounded read-ahead may touch their edges).
 * Compressed elements are streamed through zlib; only character matrices under
 * sessionInfo.sFile.events.label reach the existing MAT decoder. Event times,
 * notes and channel metadata are not needed for MATLAB's label-list search.
 * Called in a cancellable worker, never during waveform rendering.
 */

const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const align8 = (size: number) => Math.ceil(size / 8) * 8;
const knownType = (type: number) => (type >= 1 && type <= 7) || (type >= 9 && type <= 18);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes).replace(/\0[\s\S]*$/, "").trim();

interface Reader {
  position: number;
  read(size: number, short?: boolean): Promise<Uint8Array<ArrayBuffer>>;
  peek(size: number): Promise<Uint8Array>;
  skip(size: number): Promise<void>;
  stream(size: number): ReadableStream<Uint8Array<ArrayBuffer>>;
}

class BlobReader implements Reader {
  position = 0;
  private blob: Blob;
  private buffer = new Uint8Array();
  private bufferStart = 0;
  constructor(blob: Blob) { this.blob = blob; }
  async read(size: number, short = false) {
    if (!short && this.position + size > this.blob.size) throw new Error("Truncated MAT metadata.");
    const bytes = await this.peek(size);
    this.position += bytes.length;
    return bytes;
  }
  async peek(size: number) {
    const length = Math.min(size, this.blob.size - this.position);
    if (!length) return new Uint8Array();
    if (this.position < this.bufferStart || this.position + length > this.bufferStart + this.buffer.length) {
      // MAT metadata consists of thousands of tiny adjacent tags. A bounded
      // read-ahead avoids a separate browser/disk round-trip for every field.
      this.bufferStart = this.position;
      this.buffer = new Uint8Array(await this.blob.slice(this.position, this.position + Math.max(length, 16 * 1024)).arrayBuffer());
    }
    return this.buffer.subarray(this.position - this.bufferStart, this.position - this.bufferStart + length);
  }
  async skip(size: number) {
    if (size < 0 || this.position + size > this.blob.size) throw new Error("Truncated MAT metadata.");
    this.position += size;
  }
  stream(size: number) {
    if (this.position + size > this.blob.size) throw new Error("Truncated compressed MAT element.");
    const stream = this.blob.slice(this.position, this.position + size).stream();
    this.position += size;
    return stream;
  }
}

class StreamReader implements Reader {
  position = 0;
  private pending: Uint8Array = new Uint8Array();
  private done = false;
  private expanded = 0;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(stream: ReadableStream<Uint8Array>) { this.reader = stream.getReader(); }
  private async fill() {
    if (this.pending.length || this.done) return;
    const next = await this.reader.read();
    this.done = next.done;
    this.pending = next.value ?? new Uint8Array();
    this.expanded += this.pending.length;
    if (this.expanded > MAX_EXPANDED_BYTES) throw new Error("Compressed MAT data exceeds the 1 GiB background-search safety limit.");
  }
  async read(size: number, short = false) {
    const bytes = new Uint8Array(size);
    let written = 0;
    while (written < size) {
      await this.fill();
      if (!this.pending.length && this.done) break;
      const take = Math.min(size - written, this.pending.length);
      bytes.set(this.pending.subarray(0, take), written);
      this.pending = this.pending.subarray(take);
      written += take;
      this.position += take;
    }
    if (!short && written !== size) throw new Error("Truncated compressed MAT metadata.");
    return bytes.subarray(0, written);
  }
  async peek(size: number) {
    const bytes = await this.read(size, true);
    this.pending = join([bytes, this.pending]);
    this.position -= bytes.length;
    return bytes;
  }
  async skip(size: number) {
    if (size < 0) throw new Error("Invalid MAT container boundary.");
    while (size) {
      await this.fill();
      if (!this.pending.length && this.done) throw new Error("Truncated compressed MAT metadata.");
      const take = Math.min(size, this.pending.length);
      this.pending = this.pending.subarray(take);
      this.position += take;
      size -= take;
    }
  }
  stream(size: number) {
    return new ReadableStream<Uint8Array<ArrayBuffer>>({ pull: async (controller) => {
      try {
        if (!size) { controller.close(); return; }
        const take = Math.min(size, 64 * 1024);
        controller.enqueue(await this.read(take));
        size -= take;
      } catch (error) { controller.error(error); }
    } });
  }
  async close() { await this.reader.cancel(); }
}

function join(chunks: Uint8Array[]) {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

/** Bounds every tag before allocation; small tags carry their payload inline. */
async function tag(reader: Reader, end: number, little: boolean) {
  if (reader.position >= end) return null;
  const raw = await reader.read(Math.min(8, end - reader.position), true);
  if (!raw.length) {
    if (Number.isFinite(end)) throw new Error("Truncated MAT container.");
    return null;
  }
  if (raw.every((byte) => byte === 0)) {
    // Zero padding is legal only at the end. Do not silently hide following
    // event matrices when a malformed tag precedes them.
    while (reader.position < end) {
      const tail = await reader.read(Math.min(64 * 1024, end - reader.position), true);
      if (!tail.length) {
        if (Number.isFinite(end)) throw new Error("Truncated MAT container.");
        break;
      }
      if (tail.some((byte) => byte !== 0)) throw new Error("Invalid MAT tag before remaining metadata.");
    }
    return null;
  }
  if (raw.length !== 8) throw new Error("Truncated MAT tag.");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const word = view.getUint32(0, little);
  const small = word >>> 16;
  const type = small ? word & 0xffff : word;
  const size = small || view.getUint32(4, little);
  if (!knownType(type) || (small && small > 4) || (!small && reader.position + size > end)) throw new Error("Invalid MAT tag bounds.");
  return { raw, type, size, small: Boolean(small) };
}

async function field(reader: Reader, end: number, little: boolean) {
  const item = await tag(reader, end, little);
  if (!item || item.size > 1024 * 1024) throw new Error("Invalid MAT structure metadata.");
  const payload = item.small ? item.raw.subarray(4, 4 + item.size) : await reader.read(item.size);
  const padding = item.small ? new Uint8Array() : await reader.read(Math.min(align8(item.size) - item.size, end - reader.position));
  return { type: item.type, payload, raw: join([item.raw, ...(item.small ? [] : [payload, padding])]) };
}

function integers(item: { type: number; payload: Uint8Array }, little: boolean) {
  const width = [1, 2].includes(item.type) ? 1 : [3, 4].includes(item.type) ? 2 : [5, 6].includes(item.type) ? 4 : 0;
  if (!width || item.payload.length % width) throw new Error("Invalid MAT integer metadata.");
  const view = new DataView(item.payload.buffer, item.payload.byteOffset, item.payload.length);
  return Array.from({ length: item.payload.length / width }, (_, i) => width === 1 ? view.getUint8(i)
    : width === 2 ? view.getUint16(i * width, little) : view.getInt32(i * width, little));
}

/** Keep wrapper support, then follow only the known session/event/label fields. */
function containsEventLabels(path: string) {
  const parts = path.replace(/\[\d+\]/g, "").toLowerCase().split(".");
  const start = parts.indexOf("sessioninfo");
  if (start === -1) return true;
  return /^sessioninfo(?:\.sfile(?:\.events(?:\.label)?)?)?$/.test(parts.slice(start).join("."));
}

/** Extract only the event label list, not one expanded marker per timestamp. */
export async function visitMatEventLabelMatrices(file: File, visit: (bytes: Uint8Array, prefix: string, little: boolean) => Promise<void>) {
  const reader = new BlobReader(file);
  const header = await reader.read(128);
  if (!/MATLAB\s+(?:5\.0|Level 5)\s+MAT-file/i.test(text(header))) throw new Error("Background event search supports Level-5 MAT metadata; this MAT format cannot be checked.");
  const endian = String.fromCharCode(header[126], header[127]);
  if (endian !== "IM" && endian !== "MI") throw new Error("Invalid MAT byte order.");
  const little = endian === "IM";
  let metadataBytes = 0;

  async function matrix(input: Reader, end: number, prefix: string, depth: number) {
    if (depth > 24) throw new Error("MAT metadata nesting exceeds the search safety limit.");
    if (input.position === end && prefix) return; // MATLAB's unset-field representation.
    const flags = await field(input, end, little);
    const dimensions = await field(input, end, little);
    const nameField = await field(input, end, little);
    const ownName = text(nameField.payload);
    const name = ownName ? prefix ? `${prefix}.${ownName}` : ownName : prefix;
    const flagWords = integers(flags, little);
    if (!flagWords.length) throw new Error("Missing MAT array flags.");
    const kind = flagWords[0] & 0xff;
    const shape = integers(dimensions, little);
    const count = shape.reduce((product, value) => product * value, 1);
    if (!shape.length || shape.some((value) => value < 0) || !Number.isSafeInteger(count)) throw new Error("Invalid MAT dimensions.");
    if (!containsEventLabels(name)) { await input.skip(end - input.position); return; }
    if (kind === 4 && /(?:^|\.)sessionInfo(?:\[\d+\])?\.sFile(?:\[\d+\])?\.events(?:\[\d+\])?\.label(?:\[\d+\])*$/i.test(name)) {
      const remaining = end - input.position;
      metadataBytes += flags.raw.length + dimensions.raw.length + nameField.raw.length + remaining;
      if (metadataBytes > MAX_METADATA_BYTES) throw new Error("Event metadata exceeds the 64 MiB background-search safety limit.");
      await visit(join([flags.raw, dimensions.raw, nameField.raw, await input.read(remaining)]), prefix, little);
      return;
    }
    if (kind !== 1 && kind !== 2) { await input.skip(end - input.position); return; }
    let names: string[] = [];
    if (kind === 2) {
      const width = integers(await field(input, end, little), little)[0];
      const namesField = await field(input, end, little);
      if (!(width > 0) || namesField.payload.length % width) throw new Error("Invalid MAT field names.");
      names = Array.from({ length: namesField.payload.length / width }, (_, index) => text(namesField.payload.subarray(index * width, (index + 1) * width)));
    }
    let index = 0;
    while (input.position < end) {
      const child = await tag(input, end, little);
      if (!child) break;
      const childEnd = input.position + (child.small ? 0 : child.size);
      const container = kind === 2 ? Math.floor(index / Math.max(1, names.length)) : index;
      const path = count > 1 ? `${name}[${container}]` : name;
      if (child.type === 14 && !child.small) {
        const childPath = kind === 2 ? `${path}.${names[index % names.length]}` : path;
        // Child byte lengths let us seek past large times/notes/ChannelMat
        // arrays without parsing their elements or allocating marker objects.
        if (containsEventLabels(childPath)) await matrix(input, childEnd, childPath, depth + 1);
        index += 1;
      }
      await input.skip(childEnd - input.position);
      if (!child.small) await input.skip(Math.min(align8(child.size) - child.size, end - input.position));
    }
    if (index !== count * (kind === 2 ? names.length : 1)) throw new Error("Incomplete MAT structure or cell metadata.");
    await input.skip(end - input.position);
  }

  async function elements(input: Reader, end: number, depth: number): Promise<void> {
    if (depth > 24) throw new Error("Compressed MAT nesting exceeds the search safety limit.");
    while (input.position < end) {
      const item = await tag(input, end, little);
      if (!item) break;
      if (item.type === 15 && !item.small) {
        const expanded = new StreamReader(input.stream(item.size).pipeThrough(new DecompressionStream("deflate")));
        try { await elements(expanded, Infinity, depth + 1); } finally { await expanded.close(); }
        // Accept both standard unpadded compressed elements and padded writers.
        const padding = align8(item.size) - item.size;
        const next = await input.peek(8);
        const immediate = next.length === 8 && knownType(new DataView(next.buffer, next.byteOffset, 8).getUint32(0, little));
        if (!immediate && next.subarray(0, padding).every((byte) => byte === 0)) await input.skip(Math.min(padding, next.length));
      } else if (!item.small) {
        const itemEnd = input.position + item.size;
        if (item.type === 14) await matrix(input, itemEnd, "", depth + 1);
        await input.skip(itemEnd - input.position);
        await input.skip(Math.min(align8(item.size) - item.size, end - input.position));
      }
    }
  }
  await elements(reader, file.size, 0);
}
