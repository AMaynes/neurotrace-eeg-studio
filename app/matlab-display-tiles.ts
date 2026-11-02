/** Post-FIR, post-montage summaries. Never derive a montage from raw extrema. */
export const MATLAB_TILE_BASE = 128;
export const MATLAB_TILE_CACHE_BYTES = 192 * 1024 * 1024;

export interface MatlabSummary {
  minima: Float64Array[];
  maxima: Float64Array[];
  last: Float64Array[];
  gaps: Uint8Array[];
}
export interface MatlabDisplayTile {
  levels: { minima: Float64Array; maxima: Float64Array; last: Float64Array; gaps: Uint8Array; binCount: number }[];
  flatlines: { startSample: number; endSample: number }[];
  byteLength: number;
}

export function emptyMatlabSummary(rows: number, count: number): MatlabSummary {
  return {
    minima: Array.from({ length: rows }, () => new Float64Array(count).fill(Infinity)),
    maxima: Array.from({ length: rows }, () => new Float64Array(count).fill(-Infinity)),
    last: Array.from({ length: rows }, () => new Float64Array(count).fill(NaN)),
    gaps: Array.from({ length: rows }, () => new Uint8Array(count)),
  };
}

export function accumulateMatlabSummary(target: MatlabSummary, row: number, bucket: number,
  minimum: number, maximum: number, last: number, gap: number) {
  if (Number.isFinite(minimum)) target.minima[row][bucket] = Math.min(target.minima[row][bucket], minimum);
  if (Number.isFinite(maximum)) target.maxima[row][bucket] = Math.max(target.maxima[row][bucket], maximum);
  if (Number.isFinite(last)) target.last[row][bucket] = last;
  target.gaps[row][bucket] |= gap;
}

export function summarizeMatlabTile(rows: readonly Float64Array[], flatlines: MatlabDisplayTile["flatlines"]): MatlabDisplayTile {
  const count = rows[0]?.length ?? 0;
  if (count < MATLAB_TILE_BASE || count % MATLAB_TILE_BASE || !Number.isInteger(Math.log2(count / MATLAB_TILE_BASE))
    || rows.some((row) => row.length !== count)) throw new Error("Invalid MATLAB summary tile geometry.");
  const allocateLevel = (binCount: number) => ({ binCount,
    minima: new Float64Array(rows.length * binCount), maxima: new Float64Array(rows.length * binCount),
    last: new Float64Array(rows.length * binCount), gaps: new Uint8Array(rows.length * binCount) });
  // Pack all channels in four buffers per level. A large recording must not
  // retain millions of tiny per-channel ArrayBuffers in addition to its budget.
  const first = allocateLevel(count / MATLAB_TILE_BASE);
  rows.forEach((values, row) => {
    for (let bucket = 0; bucket < first.binCount; bucket++) {
      let minimum = Infinity, maximum = -Infinity, last = NaN, gap = 0;
      const end = (bucket + 1) * MATLAB_TILE_BASE;
      for (let i = bucket * MATLAB_TILE_BASE; i < end; i++) {
        const value = values[i];
        if (!Number.isFinite(value)) gap = 1;
        else { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); last = value; }
      }
      const index = row * first.binCount + bucket;
      first.minima[index] = minimum; first.maxima[index] = maximum; first.last[index] = last; first.gaps[index] = gap;
    }
  });
  const levels = [first];
  for (let length = count / MATLAB_TILE_BASE / 2; length >= 1; length /= 2) {
    const previous = levels[levels.length - 1];
    const next = allocateLevel(length);
    rows.forEach((_, row) => {
      for (let i = 0; i < length; i++) {
        const index = row * length + i, left = row * previous.binCount + i * 2, right = left + 1;
        next.minima[index] = Math.min(previous.minima[left], previous.minima[right]);
        next.maxima[index] = Math.max(previous.maxima[left], previous.maxima[right]);
        next.last[index] = Number.isFinite(previous.last[right]) ? previous.last[right] : previous.last[left];
        next.gaps[index] = previous.gaps[left] | previous.gaps[right];
      }
    });
    levels.push(next);
  }
  const byteLength = levels.reduce((total, level) => total + level.last.length * 25, 0)
    + flatlines.length * 16;
  return { levels, flatlines, byteLength };
}

/** Source identities are weak; entries keep summaries only, never recordings. */
export function createMatlabDisplayTileCache(budget = MATLAB_TILE_CACHE_BYTES) {
  if (!Number.isFinite(budget) || budget < 0) throw new Error("Invalid MATLAB tile cache budget.");
  const scopes = new WeakMap<object, Map<string, string>>();
  const entries = new Map<string, MatlabDisplayTile>();
  let nextId = 0, bytes = 0;
  return {
    scope(source: object, configuration: unknown) {
      let configurations = scopes.get(source);
      if (!configurations) { configurations = new Map(); scopes.set(source, configurations); }
      const key = JSON.stringify(configuration);
      let id = configurations.get(key);
      if (!id) id = String(++nextId);
      configurations.delete(key); configurations.set(key, id);
      // Only short scope IDs are repeated in tile keys. Limit metadata retained
      // by a live source even if a user tries many different channel selections.
      while (configurations.size > 32) configurations.delete(configurations.keys().next().value!);
      return id;
    },
    get(key: string) {
      const value = entries.get(key);
      if (value) { entries.delete(key); entries.set(key, value); }
      return value;
    },
    set(key: string, value: MatlabDisplayTile) {
      const old = entries.get(key);
      if (old) { bytes -= old.byteLength; entries.delete(key); }
      if (value.byteLength > budget) return;
      entries.set(key, value); bytes += value.byteLength;
      while (bytes > budget) {
        const first = entries.entries().next().value!;
        entries.delete(first[0]); bytes -= first[1].byteLength;
      }
    },
    clear() { entries.clear(); bytes = 0; },
    get byteLength() { return bytes; },
    get size() { return entries.size; },
  };
}

export type MatlabDisplayTileCache = ReturnType<typeof createMatlabDisplayTileCache>;
