import type { MatlabDisplayWindow, MatlabDisplayWindowOptions } from "./matlab-display-window.ts";
import { accumulateMatlabSummary, emptyMatlabSummary, MATLAB_TILE_BASE, summarizeMatlabTile,
  type MatlabDisplayTileCache, type MatlabDisplayTile } from "./matlab-display-tiles.ts";

interface Segment { start: number; count: number; stable: boolean; key: string }
export interface MatlabTileSamples {
  rows: Float64Array[];
  flatlines: MatlabDisplayTile["flatlines"];
}

/** Globally aligned bins preserve every retained extremum at every cached zoom. */
export async function buildCachedMatlabDisplay(parameters: {
  metadata: MatlabDisplayWindow;
  cache: MatlabDisplayTileCache;
  scope: string;
  firstSample: number;
  outputCount: number;
  rate: number;
  startSec: number;
  durationSec: number;
  pixelWidth: number;
  tileSize: number;
  /** Read now; returned closure filters it after the next bounded read starts. */
  load: (start: number, count: number, stable: boolean) => Promise<() => Promise<MatlabTileSamples>>;
  options: MatlabDisplayWindowOptions;
}): Promise<MatlabDisplayWindow> {
  const { metadata, cache, scope, firstSample, outputCount, rate, startSec, durationSec, pixelWidth, tileSize, load, options } = parameters;
  const phase = firstSample % 2;
  const first = (firstSample - phase) / 2, end = first + outputCount;
  const binSize = 2 ** Math.floor(Math.log2(outputCount / pixelWidth));
  const firstBin = Math.floor(first / binSize), binCount = Math.ceil(end / binSize) - firstBin;
  const summary = emptyMatlabSummary(metadata.data.length, binCount);
  const envelopeStart = startSec + ((firstBin * binSize - first) * 2 + 1) / rate;
  const flatlines: MatlabDisplayTile["flatlines"] = [];
  const segments: Segment[] = [];
  for (let start = first; start < end;) {
    const tileStart = Math.floor(start / tileSize) * tileSize;
    const count = Math.min(end, tileStart + tileSize) - start;
    // Only the unchanged FIR interior is cacheable. Recompute both loaded-window
    // edges, including the MATLAB repeated causal tail, on every navigation.
    const stable = start === tileStart && count === tileSize && start >= first + 16 && start + count <= end - 16;
    segments.push({ start, count, stable, key: `${scope}:${tileSize}:${tileStart}` });
    start += count;
  }
  const check = () => options.signal?.throwIfAborted();
  let completed = 0, lastPublish = -Infinity, lastYield = performance.now();
  const snapshot = (complete: boolean): MatlabDisplayWindow => {
    const data = summary.last.map((values) => values.slice());
    const envelopes = data.map((_, row) => {
      const minima = summary.minima[row].slice(), maxima = summary.maxima[row].slice(), gaps = summary.gaps[row].slice();
      for (let i = 0; i < binCount; i++) if (!Number.isFinite(minima[i])) { minima[i] = NaN; maxima[i] = NaN; gaps[i] = 1; }
      return { minima, maxima, gaps, startSec: envelopeStart, bucketDurationSec: binSize * 2 / rate };
    });
    const merged: MatlabDisplayTile["flatlines"] = [];
    if (complete) for (const region of flatlines) {
      const previous = merged[merged.length - 1];
      if (previous && region.startSample <= previous.endSample) previous.endSample = Math.max(previous.endSample, region.endSample);
      else merged.push({ ...region });
    }
    return { ...metadata, data, envelopes, startSecs: data.map(() => envelopeStart),
      flatlineRegions: merged.filter((region) => (region.endSample - region.startSample) / rate >= 0.25)
        .map((region) => ({ startSec: startSec + (region.startSample - firstSample + 1) / rate,
          endSec: startSec + (region.endSample - firstSample + 1) / rate })),
      byteLength: data.length * binCount * 25,
    };
  };
  // Exactly one read may run ahead. Resolve failures into a value immediately,
  // so cancellation while filtering cannot leave an unhandled rejected read.
  const prepare = (segment: Segment) => {
    const cached = segment.stable ? cache.get(segment.key) : undefined;
    return cached ? Promise.resolve({ tile: cached }) : load(segment.start, segment.count, segment.stable)
      .then((process) => ({ process }), (error: unknown) => ({ error }));
  };
  let pending = prepare(segments[0]);
  for (let i = 0; i < segments.length; i++) {
    check();
    const segment = segments[i];
    const prepared = await pending;
    check();
    if ("error" in prepared) throw prepared.error;
    // Start one following read while this tile is filtered by the worker pool.
    if (i + 1 < segments.length) pending = prepare(segments[i + 1]);
    let tile = "tile" in prepared ? prepared.tile : undefined;
    const samples = "process" in prepared ? await prepared.process() : undefined;
    check();
    if (samples && segment.stable) {
      tile = summarizeMatlabTile(samples.rows, samples.flatlines);
      cache.set(segment.key, tile);
    }
    if (tile) {
      const level = tile.levels[Math.min(tile.levels.length - 1, Math.log2(binSize / MATLAB_TILE_BASE))];
      const stride = tileSize / level.binCount;
      for (let row = 0; row < summary.last.length; row++) for (let j = 0; j < level.binCount; j++) {
        const bin = Math.floor((segment.start + j * stride) / binSize) - firstBin;
        const index = row * level.binCount + j;
        accumulateMatlabSummary(summary, row, bin, level.minima[index], level.maxima[index], level.last[index], level.gaps[index]);
      }
      flatlines.push(...tile.flatlines);
    } else if (samples) {
      samples.rows.forEach((values, row) => {
        for (let j = 0; j < values.length; j++) {
          const bin = Math.floor((segment.start + j) / binSize) - firstBin, value = values[j];
          accumulateMatlabSummary(summary, row, bin, value, value, value, Number(!Number.isFinite(value)));
        }
      });
      flatlines.push(...samples.flatlines);
    }
    completed += segment.count;
    options.onProgress?.({ completedSamples: completed * metadata.data.length,
      totalSamples: outputCount * metadata.data.length, fraction: completed / outputCount });
    if (options.onPartial && completed < outputCount && performance.now() - lastPublish >= 200) {
      lastPublish = performance.now();
      // The last bin may straddle the completed prefix; keep it visibly pending.
      const through = Math.max(startSec, envelopeStart + Math.floor((segment.start + segment.count) / binSize - firstBin) * binSize * 2 / rate);
      options.onPartial(snapshot(false), Math.min(startSec + durationSec, through));
    }
    // Cache hits resolve as microtasks. Yield explicitly so a large cached
    // montage cannot monopolize the UI or prevent a newer seek from cancelling.
    if (!("tile" in prepared)) lastYield = performance.now(); // File/worker awaits already yielded.
    else if (performance.now() - lastYield >= 16) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
  check();
  return snapshot(true);
}
