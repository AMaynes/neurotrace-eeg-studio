/** Recording-aligned waveform blocks. Panning never changes a retained sample's grid or processing context. */
import { buildMontage, type DisplayFilterSettings } from "./eeg-core.ts";
import { processDisplaySignalsOffThread } from "./display-processing-worker-client.ts";
import { matlabDisplayChunkInputRange, matlabDisplayDecimationFactor } from "./matlab-display-processing.ts";
import { createMatlabDisplayWorkerPool } from "./matlab-display-worker-pool.ts";
import { detectMatlabTileFlatlines } from "./matlab-raw-flatlines.ts";
import { accumulateMatlabSummary, emptyMatlabSummary, summarizeMatlabTile, MATLAB_TILE_BASE, type MatlabDisplayTile } from "./matlab-display-tiles.ts";
import { robustTraceBaseline } from "./waveform-geometry.ts";
import type { MatlabDisplayWindow, MatlabDisplayWindowOptions, MatlabDisplayWindowRequest } from "./matlab-display-window.ts";

type Flatline = { startSec: number; endSec: number };
type SampleBlock = { data: Float64Array[]; flatlines: Flatline[]; byteLength: number };
type SummaryBlock = { summary: MatlabDisplayTile; flatlines: Flatline[]; byteLength: number };

function boundedCache<T extends { byteLength: number }>(budget: number) {
  const entries = new Map<string, T>();
  let bytes = 0;
  return {
    get(key: string) {
      const value = entries.get(key);
      if (value) { entries.delete(key); entries.set(key, value); }
      return value;
    },
    set(key: string, value: T) {
      const old = entries.get(key);
      if (old) { bytes -= old.byteLength; entries.delete(key); }
      if (value.byteLength > budget) return;
      entries.set(key, value); bytes += value.byteLength;
      while (bytes > budget) {
        const [oldest, entry] = entries.entries().next().value!;
        entries.delete(oldest); bytes -= entry.byteLength;
      }
    },
    get byteLength() { return bytes; },
    get size() { return entries.size; },
  };
}

/** Exact blocks and coarse summaries have separate budgets; source identities remain weak. */
export function createRecordingDisplayCache(sampleBytes = 48 * 1024 * 1024, summaryBytes = 128 * 1024 * 1024) {
  if (![sampleBytes, summaryBytes].every(value => Number.isFinite(value) && value >= 0)) throw new Error("Invalid waveform cache budget.");
  const scopes = new WeakMap<object, Map<string, string>>();
  const centers = new Map<string, number[]>();
  let nextId = 0;
  return {
    samples: boundedCache<SampleBlock>(sampleBytes),
    summaries: boundedCache<SummaryBlock>(summaryBytes),
    centers,
    scope(source: object, settings: unknown) {
      let configurations = scopes.get(source);
      if (!configurations) { configurations = new Map(); scopes.set(source, configurations); }
      const key = JSON.stringify(settings);
      let id = configurations.get(key);
      if (!id) { id = String(++nextId); configurations.set(key, id); }
      while (configurations.size > 32) configurations.delete(configurations.keys().next().value!);
      return id;
    },
  };
}
export type RecordingDisplayCache = ReturnType<typeof createRecordingDisplayCache>;

function sourceFrames(duration: number, rate: number) {
  const value = duration * rate, nearest = Math.round(value);
  return Math.abs(value - nearest) < Math.min(1e-6, 8 * Number.EPSILON * Math.max(1, value)) ? nearest : Math.floor(value);
}

/**
 * Prepare fixed source blocks, keeping FIR phase and filter padding anchored to
 * the recording. Cached blocks are placed before any missing block is awaited.
 * The first recording block supplies one immutable vertical reference per row.
 */
export async function buildRecordingDisplayWindow(request: MatlabDisplayWindowRequest,
  options: MatlabDisplayWindowOptions = {}): Promise<MatlabDisplayWindow> {
  const { source, startSec, durationSec, pixelWidth, montage } = request;
  const check = () => options.signal?.throwIfAborted();
  check();
  if (![startSec, durationSec, pixelWidth].every(Number.isFinite) || durationSec <= 0 || pixelWidth <= 0) {
    throw new Error("Waveform requires a finite start and positive duration and width.");
  }
  const indices = [...request.channelIndices];
  if (!indices.length || new Set(indices).size !== indices.length || indices.some(index => !Number.isSafeInteger(index)
    || index < 0 || index >= source.meta.channelCount)) throw new Error("Waveform channels are invalid.");
  const labels = indices.map(index => source.meta.channelLabels[index]);
  const units = indices.map(index => source.meta.channelUnits[index]);
  const rates = indices.map(index => source.meta.sampleRates[index]);
  if (rates.some(rate => !Number.isFinite(rate) || rate <= 0)) throw new Error("Waveform sample rates are invalid.");
  const filters: DisplayFilterSettings = request.displayFilters ?? { enabled: false, highPassHz: 0, lowPassHz: 200, notchHz: 0 };
  const factors = rates.map(rate => filters.enabled ? 1 : matlabDisplayDecimationFactor(Math.floor(durationSec * rate), pixelWidth));
  const outputRates = rates.map((rate, row) => rate / factors[row]);
  const times = rates.map(rate => 1 / rate);
  const excluded = new Set<number | string>();
  for (const value of request.excludedChannels ?? []) {
    if (typeof value === "string") excluded.add(value);
    else if (indices.includes(value)) excluded.add(indices.indexOf(value));
  }
  const montageOptions = { allChannelLabels: request.allChannelLabels ?? source.meta.channelLabels,
    sourceChannelIndices: indices, channelUnits: units, bipolarKind: request.bipolarKind };
  const template = buildMontage(indices.map(() => new Float64Array()), labels, montage, excluded, outputRates, times, montageOptions);
  const warnings = new Set(template.warnings);
  const cache = options.recordingCache ?? createRecordingDisplayCache();
  const active = new Set(template.sourceIndices.flat());
  const rateGroups = new Map<number, number[]>();
  for (const position of active) {
    const group = rateGroups.get(rates[position]) ?? [];
    group.push(position); rateGroups.set(rates[position], group);
  }
  if (montage !== "referential" && rateGroups.size > 1) throw new Error("Derived waveform channels require matching sample rates.");
  if (rateGroups.size > 1) warnings.add("Synchronized raw flatline markers are unavailable for mixed-rate selections.");
  const data: Float64Array[] = template.labels.map(() => new Float64Array());
  const envelopes: MatlabDisplayWindow["envelopes"] = template.labels.map(() => null);
  const startSecs: number[] = [], sampleStarts: number[] = [], baselines: number[] = [];
  const retainedCounts: number[] = [];
  const flatlines: Flatline[] = [];
  const jobs: { count: number; apply(block: SampleBlock | SummaryBlock): void; load(): Promise<SampleBlock> }[] = [];
  let pool: ReturnType<typeof createMatlabDisplayWorkerPool> | undefined;
  const snapshot = (): MatlabDisplayWindow => ({ data: data.map(row => row.slice()),
    envelopes: envelopes.map(envelope => {
      if (!envelope) return null;
      const minima = envelope.minima.slice(), maxima = envelope.maxima.slice(), gaps = envelope.gaps.slice();
      for (let i = 0; i < minima.length; i++) if (!Number.isFinite(minima[i])) { minima[i] = NaN; maxima[i] = NaN; gaps[i] = 1; }
      return { ...envelope, minima, maxima, gaps };
    }),
    recordingAnchored: true, labels: template.labels, units: template.primarySourceIndices.map(position => units[position]),
    sampleRates: template.primarySourceIndices.map(position => outputRates[position]),
    sourceSampleRates: template.primarySourceIndices.map(position => rates[position]),
    factors: template.primarySourceIndices.map(position => factors[position]), retainedSampleCounts: retainedCounts,
    startSecs, sourceStartSampleIndices: sampleStarts, sourceIndices: template.sourceIndices.map(row => row.map(position => indices[position])),
    primarySourceIndices: template.primarySourceIndices.map(position => indices[position]), traceBaselines: baselines,
    warnings: [...warnings], flatlineRegions: [...flatlines],
    byteLength: data.reduce((sum, row) => sum + row.byteLength, 0)
      + envelopes.reduce((sum, envelope) => sum + (envelope ? envelope.minima.byteLength + envelope.maxima.byteLength + envelope.gaps.byteLength : 0), 0) });
  try {
    for (const [rate, positions] of rateGroups) {
      const factor = factors[positions[0]], totalFrames = sourceFrames(source.meta.durationSec, rate);
      const totalOutputs = Math.ceil(totalFrames / factor);
      if (!Number.isSafeInteger(totalFrames) || totalFrames <= 0) throw new Error("Waveform source length is invalid.");
      const rows = template.primarySourceIndices.flatMap((position, row) => positions.includes(position) ? [row] : []);
      const blockBytes = options.maxChunkBytes ?? 8 * 1024 * 1024;
      const blockSeconds = options.maxChunkDurationSec ?? 120;
      if (!(blockBytes >= 1024) || !Number.isFinite(blockBytes) || !(blockSeconds > 0) || !Number.isFinite(blockSeconds)) {
        throw new Error("Waveform block limits are invalid.");
      }
      const tileSize = 2 ** Math.floor(Math.log2(Math.max(1,
        Math.min(32768, blockBytes / (8 * positions.length), blockSeconds * rate / factor))));
      // A fixed output grid makes both the first/last visible bins and EOF independent of the viewport origin.
      const nominalCount = Math.max(1, Math.ceil(durationSec * rate / factor));
      const maxBins = Math.max(1, Math.min(pixelWidth, Math.floor(64 * 1024 * 1024 / (25 * Math.max(1, template.labels.length)))));
      const binSize = 2 ** Math.max(0, Math.floor(Math.log2(nominalCount / maxBins)));
      const firstBin = Math.max(0, Math.floor(startSec * rate / factor / binSize));
      const endBin = Math.max(firstBin, Math.ceil(Math.min(source.meta.durationSec, startSec + durationSec) * rate / factor / binSize));
      const count = endBin - firstBin;
      const summary = emptyMatlabSummary(rows.length, count);
      const origin = firstBin * binSize * factor / rate + 1 / rate;
      rows.forEach((row, local) => {
        data[row] = summary.last[local]; startSecs[row] = origin; sampleStarts[row] = firstBin * binSize * factor;
        retainedCounts[row] = Math.max(0, Math.min(totalOutputs, endBin * binSize) - firstBin * binSize);
        envelopes[row] = binSize > 1 ? { minima: summary.minima[local], maxima: summary.maxima[local], gaps: summary.gaps[local],
          startSec: origin, bucketDurationSec: binSize * factor / rate } : null;
      });
      const scope = cache.scope(source, [indices, montage, request.bipolarKind, [...excluded], rate, factor, tileSize,
        filters.enabled ? filters : false, montageOptions.allChannelLabels, units]);
      const keyFor = (tile: number) => `${scope}:${tile}`;
      const readWindow = options.readWindow ?? ((start, duration, channels, readOptions) => source.getWindow(start, duration, channels, readOptions));
      const load = async (tile: number): Promise<SampleBlock> => {
        check();
        const cached = cache.samples.get(keyFor(tile));
        if (cached) return cached;
        const first = tile * tileSize, length = Math.min(tileSize, totalOutputs - first);
        const range = matlabDisplayChunkInputRange(totalFrames, factor, first, length);
        const padding = filters.enabled ? Math.ceil(rate * Math.min(12, Math.max(2, filters.highPassHz > 0 ? 3 / filters.highPassHz : 2)))
          : Math.ceil(rate * .5);
        const readFirst = Math.max(0, range.firstSample - padding), readEnd = Math.min(totalFrames, range.endSample + padding);
        if ((readEnd - readFirst) * positions.length * 8 > 64 * 1024 * 1024) throw new Error("Selected channels exceed the bounded waveform processing budget.");
        const input = await readWindow(readFirst / rate, (readEnd - readFirst + .25) / rate,
          positions.map(position => indices[position]), { signal: options.signal });
        check();
        const raw = positions.map(position => {
          const index = input.channelIndices.indexOf(indices[position]);
          if (index < 0 || input.sampleRates[index] !== rate) throw new Error("Waveform source returned incompatible channels.");
          const offset = readFirst - Math.round(input.channelStartSecs[index] * rate);
          if (offset < 0 || offset + readEnd - readFirst > input.data[index].length) throw new Error("Waveform source did not cover the requested block.");
          return input.data[index].subarray(offset, offset + readEnd - readFirst);
        });
        let samples: Float64Array[];
        if (filters.enabled) {
          const prepared = await processDisplaySignalsOffThread({ data: raw, sampleRates: positions.map(() => rate), filters,
            pixelCount: readEnd - readFirst, sourceStartSampleIndices: positions.map(() => readFirst) },
          { signal: options.signal, fallbackToMainThread: options.fallbackToMainThread });
          samples = prepared.data.map(values => Float64Array.from(values.subarray(first - readFirst, first - readFirst + length)));
        } else if (factor === 1) {
          samples = raw.map(values => Float64Array.from(values.subarray(first - readFirst, first - readFirst + length)));
        } else {
          pool ??= createMatlabDisplayWorkerPool({ signal: options.signal, fallbackToMainThread: options.fallbackToMainThread,
            workerCount: options.workerCount, channelCount: positions.length });
          const filtered = await pool.process(raw.map(values => ({ data: values.subarray(range.firstSample - readFirst, range.endSample - readFirst),
            options: { inputSampleCount: totalFrames, factor, inputStartIndex: range.firstSample, outputStartIndex: first, outputSampleCount: length } })));
          samples = filtered.map(values => values instanceof Float64Array ? values : Float64Array.from(values));
        }
        check();
        let output: Float64Array[];
        if (montage === "referential") output = rows.map(row => samples[positions.indexOf(template.primarySourceIndices[row])]);
        else {
          const inputs: Float64Array[] = indices.map(() => new Float64Array());
          positions.forEach((position, local) => { inputs[position] = samples[local]; });
          const derived = buildMontage(inputs, labels, montage, excluded, outputRates, times, montageOptions);
          if (derived.labels.join("\0") !== template.labels.join("\0")) throw new Error("Waveform montage changed between blocks.");
          output = rows.map(row => Float64Array.from(derived.data[row]));
        }
        const blockFlatlines = rateGroups.size === 1 ? detectMatlabTileFlatlines(raw, rate).flatMap(region => {
          const startSample = Math.max(first * factor, readFirst + region.startSample);
          const endSample = Math.min((first + length) * factor, readFirst + region.endSample);
          return endSample > startSample ? [{ startSec: (startSample + 1) / rate, endSec: (endSample + 1) / rate }] : [];
        }) : [];
        const block = { data: output, flatlines: blockFlatlines, byteLength: output.reduce((sum, row) => sum + row.byteLength, 0) };
        cache.samples.set(keyFor(tile), block);
        if (length === tileSize && tileSize >= MATLAB_TILE_BASE) {
          const tileSummary = summarizeMatlabTile(output, []);
          cache.summaries.set(keyFor(tile), { summary: tileSummary, flatlines: blockFlatlines, byteLength: tileSummary.byteLength });
        }
        return block;
      };
      let centers = cache.centers.get(scope);
      if (!centers) {
        const anchor = await load(0);
        centers = anchor.data.map(values => robustTraceBaseline(values));
        cache.centers.set(scope, centers);
        while (cache.centers.size > 64) cache.centers.delete(cache.centers.keys().next().value!);
      }
      rows.forEach((row, local) => { baselines[row] = centers![local]; });
      const firstOutput = firstBin * binSize, endOutput = Math.min(totalOutputs, endBin * binSize);
      for (let tile = Math.floor(firstOutput / tileSize); tile * tileSize < endOutput; tile++) {
        const first = tile * tileSize;
        const apply = (block: SampleBlock | SummaryBlock) => {
          if ("data" in block) block.data.forEach((values, row) => {
            for (let i = Math.max(0, firstOutput - first); i < values.length && first + i < endOutput; i++) {
              const value = values[i], bin = Math.floor((first + i) / binSize) - firstBin;
              accumulateMatlabSummary(summary, row, bin, value, value, value, Number(!Number.isFinite(value)));
            }
          });
          else {
            const level = block.summary.levels[Math.min(block.summary.levels.length - 1, Math.log2(binSize / MATLAB_TILE_BASE))];
            const stride = tileSize / level.binCount;
            for (let row = 0; row < rows.length; row++) for (let i = 0; i < level.binCount; i++) {
              const global = first + i * stride;
              if (global < firstOutput || global >= endOutput) continue;
              const bin = Math.floor(global / binSize) - firstBin, index = row * level.binCount + i;
              accumulateMatlabSummary(summary, row, bin, level.minima[index], level.maxima[index], level.last[index], level.gaps[index]);
            }
          }
          flatlines.push(...block.flatlines);
        };
        const cached = binSize >= MATLAB_TILE_BASE ? cache.summaries.get(keyFor(tile)) ?? cache.samples.get(keyFor(tile)) : cache.samples.get(keyFor(tile));
        if (cached) apply(cached);
        else jobs.push({ count: Math.max(0, Math.min(first + tileSize, endOutput) - Math.max(first, firstOutput)) * rows.length,
          apply, load: () => load(tile) });
      }
    }
    // Publish every cached island together, even when the missing block is to its left.
    const totalSamples = retainedCounts.reduce((sum, count) => sum + count, 0);
    let completed = totalSamples - jobs.reduce((sum, job) => sum + job.count, 0), lastPartial = -Infinity;
    const fraction = () => totalSamples ? completed / totalSamples : 1;
    options.onProgress?.({ completedSamples: completed, totalSamples, fraction: fraction() });
    if (jobs.length && data.some(row => row.some(Number.isFinite))) {
      options.onPartial?.(snapshot(), startSec + durationSec * fraction());
    }
    for (const job of jobs) {
      check();
      job.apply(await job.load());
      check();
      completed += job.count;
      options.onProgress?.({ completedSamples: completed, totalSamples, fraction: fraction() });
      if (completed < totalSamples && performance.now() - lastPartial >= 200) {
        lastPartial = performance.now();
        options.onPartial?.(snapshot(), startSec + durationSec * fraction());
      }
    }
    check();
    return snapshot();
  } finally { pool?.close(); }
}
