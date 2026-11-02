/** Bounded, full-view MATLAB processing; reduction happens after filter/montage. */
import { buildMontage, montageInputPolicy, type MontageMode, type SignalReadOptions, type SignalSource, type WindowData } from "./eeg-core.ts";
import type { BipolarMontageKind } from "./bipolar-montage.ts";
import { matlabDisplayChunkInputRange, matlabDisplayDecimationFactor, type MatlabDisplayFactor, type MatlabDisplaySamples } from "./matlab-display-processing.ts";
import { createMatlabDisplayWorkerPool } from "./matlab-display-worker-pool.ts";
import { createMatlabRawFlatlineDetector, detectMatlabTileFlatlines } from "./matlab-raw-flatlines.ts";
import { MATLAB_TILE_BASE, type MatlabDisplayTileCache } from "./matlab-display-tiles.ts";
import { buildCachedMatlabDisplay } from "./matlab-cached-display.ts";
export { createMatlabRawFlatlineDetector } from "./matlab-raw-flatlines.ts";

export interface MatlabDisplayEnvelope {
  minima: Float64Array;
  maxima: Float64Array;
  gaps: Uint8Array;
  startSec: number;
  bucketDurationSec: number;
}

export interface MatlabDisplayWindow {
  data: Float64Array[];
  envelopes: (MatlabDisplayEnvelope | null)[];
  labels: string[];
  units: string[];
  /** Actual MATLAB retained rates, not the screen-envelope bucket rates. */
  sampleRates: number[];
  sourceSampleRates: number[];
  factors: MatlabDisplayFactor[];
  retainedSampleCounts: number[];
  /** Raw traces include MATLAB's 1/fs offset; envelopes have their bucket origin. */
  startSecs: number[];
  sourceStartSampleIndices: number[];
  /** All indices in these fields refer to the recording's channel catalog. */
  sourceIndices: number[][];
  primarySourceIndices: number[];
  warnings: string[];
  flatlineRegions: { startSec: number; endSec: number }[];
  byteLength: number;
}

export interface MatlabDisplayWindowRequest {
  source: SignalSource;
  startSec: number;
  durationSec: number;
  pixelWidth: number;
  channelIndices: readonly number[];
  montage: MontageMode;
  allChannelLabels?: readonly string[];
  bipolarKind?: BipolarMontageKind;
  /** Recording-global source indices or exact names, not chunk-local positions. */
  excludedChannels?: ReadonlySet<number | string>;
}

export interface MatlabDisplayWindowOptions extends SignalReadOptions {
  /** Injectable existing file-worker adapter. It must return calibrated source samples. */
  readWindow?: (
    startSec: number, durationSec: number, channelIndices: readonly number[], options: SignalReadOptions,
  ) => Promise<WindowData>;
  onProgress?: (progress: { completedSamples: number; totalSamples: number; fraction: number }) => void;
  /** Defaults to thirty seconds and ~2 MB of input doubles plus FIR context. */
  maxChunkDurationSec?: number;
  maxChunkBytes?: number;
  /** Explicit test/non-browser fallback only; browser processing requires a worker. */
  fallbackToMainThread?: boolean;
  /** Bounded channel-parallel FIR workers; defaults to at most four. */
  workerCount?: number;
  cache?: MatlabDisplayTileCache;
  /** Immutable completed prefix; missing bins remain NaN until calculated. */
  onPartial?: (window: MatlabDisplayWindow, completedThroughSec: number) => void;
}

interface SourcePlan {
  position: number;
  sourceIndex: number;
  rate: number;
  firstSample: number;
  inputCount: number;
  factor: MatlabDisplayFactor;
  outputCount: number;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("MATLAB display view was superseded", "AbortError");
}

/**
 * Preserves the supplied MATLAB's loaded-window boundaries even when disk reads
 * and FIR work are chunked. It never decimates an existing envelope or subtracts
 * envelopes to form a montage. Every retained sample is computed first, then
 * derived in double precision, then accumulated into bounded display geometry.
 */
export async function buildMatlabDisplayWindow(
  request: MatlabDisplayWindowRequest,
  options: MatlabDisplayWindowOptions = {},
): Promise<MatlabDisplayWindow> {
  checkAborted(options.signal);
  const { source, startSec, durationSec, pixelWidth, montage } = request;
  if (!Number.isFinite(startSec) || startSec < 0 || !Number.isFinite(durationSec) || durationSec <= 0
    || !Number.isFinite(pixelWidth) || pixelWidth <= 0) {
    throw new Error("MATLAB display requires a non-negative start and positive finite duration and pixel width.");
  }
  const indices = [...request.channelIndices];
  if (!indices.length || new Set(indices).size !== indices.length
    || indices.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= source.meta.channelCount)) {
    throw new Error("MATLAB display requires unique, valid source channels.");
  }
  const labels = indices.map((index) => source.meta.channelLabels[index]);
  const units = indices.map((index) => source.meta.channelUnits[index]);
  const plans: SourcePlan[] = indices.map((sourceIndex, position) => {
    const rate = source.meta.sampleRates[sourceIndex];
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("MATLAB display requires positive finite source rates.");
    const firstSample = Math.floor(startSec * rate);
    // Duration metadata often comes from sampleCount / rate. Undo only its
    // round-trip noise at EOF (e.g. 1001 / 1000 * 1000 < 1001). Requested start
    // and duration deliberately retain MATLAB's literal floor convention.
    const sourceLength = source.meta.durationSec * rate;
    const nearestSourceLength = Math.round(sourceLength);
    const sourceLengthTolerance = Math.min(1e-6, Number.EPSILON * Math.max(1, sourceLength) * 4);
    const sourceEnd = Math.abs(sourceLength - nearestSourceLength) <= sourceLengthTolerance
      ? nearestSourceLength : Math.floor(sourceLength);
    const inputCount = Math.max(0, Math.min(Math.floor(durationSec * rate), sourceEnd - firstSample));
    const factor = matlabDisplayDecimationFactor(inputCount, pixelWidth);
    return { position, sourceIndex, rate, firstSample, inputCount, factor, outputCount: Math.ceil(inputCount / factor) };
  });
  if (plans.some((plan) => !Number.isSafeInteger(plan.inputCount) || !Number.isSafeInteger(plan.firstSample))) {
    throw new Error("MATLAB display sample range exceeds safe integer precision.");
  }
  const explicitExclusions = new Set<number | string>();
  for (const excluded of request.excludedChannels ?? []) {
    if (typeof excluded === "string") explicitExclusions.add(excluded);
    else {
      const position = indices.indexOf(excluded);
      if (position >= 0) explicitExclusions.add(position);
    }
  }
  const { excludedPositions, warnings: inputWarnings } = montageInputPolicy(labels, units, montage, explicitExclusions);
  const excludedNames = new Set([...excludedPositions].filter((value): value is string => typeof value === "string")
    .map((label) => label.trim().toLowerCase()));
  const activePlans = montage === "referential" ? plans : plans.filter((plan) =>
    !excludedPositions.has(plan.position) && !excludedNames.has(labels[plan.position].trim().toLowerCase()));
  // Excluded auxiliary channels may have entirely different rates. They must
  // neither block the EEG montage nor consume FIR/read work for that montage.
  if (montage !== "referential" && activePlans.some((plan) => plan.rate !== activePlans[0].rate
    || plan.factor !== activePlans[0].factor || plan.inputCount !== activePlans[0].inputCount)) {
    throw new Error("MATLAB-compatible derived montages require equal sample rates and aligned window lengths; mixed-rate signals cannot be combined.");
  }
  const warnings = new Set<string>(inputWarnings);
  const sameRawGrid = activePlans.every((plan) => plan.rate === activePlans[0].rate && plan.inputCount === activePlans[0].inputCount);
  const flatlines = activePlans.length && sameRawGrid
    ? createMatlabRawFlatlineDetector(activePlans.length, activePlans[0].rate, startSec + 1 / activePlans[0].rate)
    : null;
  if (!sameRawGrid) warnings.add("Synchronized raw flatline markers are unavailable for mixed-rate selections in MATLAB-compatible view.");
  const montageOptions = {
    allChannelLabels: request.allChannelLabels ?? source.meta.channelLabels,
    sourceChannelIndices: indices,
    bipolarKind: request.bipolarKind,
    channelUnits: units,
  };
  const sourceRates = plans.map((plan) => plan.rate);
  const outputRates = plans.map((plan) => plan.rate / plan.factor);
  const firstTimes = plans.map((plan) => startSec + 1 / plan.rate);
  const template = buildMontage(plans.map(() => new Float64Array()), labels, montage, excludedPositions, outputRates, firstTimes, montageOptions);
  for (const warning of template.warnings) warnings.add(warning);
  const bucketCount = Math.max(1, Math.ceil(pixelWidth));
  const rowPlans = template.primarySourceIndices.map((position) => plans[position]);
  const envelopes = rowPlans.map((plan): MatlabDisplayEnvelope | null => plan.outputCount > pixelWidth * 1.5 ? {
    minima: new Float64Array(bucketCount).fill(Infinity),
    maxima: new Float64Array(bucketCount).fill(-Infinity),
    gaps: new Uint8Array(bucketCount),
    startSec,
    bucketDurationSec: durationSec / bucketCount,
  } : null);
  const data = rowPlans.map((plan, row) => new Float64Array(envelopes[row] ? bucketCount : plan.outputCount).fill(NaN));
  const finalize = (partial = false): MatlabDisplayWindow => {
    const outputData = partial ? data.map((values) => values.slice()) : data;
    const outputEnvelopes = partial ? envelopes.map((envelope) => envelope ? { ...envelope,
      minima: envelope.minima.slice(), maxima: envelope.maxima.slice(), gaps: envelope.gaps.slice() } : null) : envelopes;
    outputEnvelopes.forEach((envelope) => {
      if (!envelope) return;
      for (let bucket = 0; bucket < bucketCount; bucket += 1) {
        if (!Number.isFinite(envelope.minima[bucket]) || !Number.isFinite(envelope.maxima[bucket])) {
          envelope.minima[bucket] = NaN;
          envelope.maxima[bucket] = NaN;
          envelope.gaps[bucket] = 1;
        }
      }
    });
    return {
      data: outputData, envelopes: outputEnvelopes, labels: template.labels,
      units: template.primarySourceIndices.map((position) => units[position]),
      sampleRates: template.primarySourceIndices.map((position) => outputRates[position]),
      sourceSampleRates: template.primarySourceIndices.map((position) => sourceRates[position]),
      factors: rowPlans.map((plan) => plan.factor), retainedSampleCounts: rowPlans.map((plan) => plan.outputCount),
      startSecs: rowPlans.map((plan, row) => envelopes[row] ? startSec : startSec + 1 / plan.rate),
      sourceStartSampleIndices: rowPlans.map((plan) => plan.firstSample),
      sourceIndices: template.sourceIndices.map((contributors) => contributors.map((position) => indices[position])),
      primarySourceIndices: template.primarySourceIndices.map((position) => indices[position]),
      warnings: [...warnings],
      flatlineRegions: partial ? [] : flatlines?.finish() ?? [],
      byteLength: data.reduce((sum, values) => sum + values.byteLength, 0)
        + envelopes.reduce((sum, envelope) => sum + (envelope ? envelope.minima.byteLength + envelope.maxima.byteLength + envelope.gaps.byteLength : 0), 0),
    };
  };
  // A montage with no usable rows cannot show a waveform. In particular, do
  // not decode/filter six hours just to return an empty result or start a
  // processing worker for a window containing no whole input samples.
  const totalSamples = template.labels.length ? activePlans.reduce((sum, plan) => sum + plan.outputCount, 0) : 0;
  if (!totalSamples) {
    options.onProgress?.({ completedSamples: 0, totalSamples: 0, fraction: 1 });
    checkAborted(options.signal);
    return finalize();
  }
  const groups = new Map<string, SourcePlan[]>();
  for (const plan of activePlans) {
    const key = `${plan.rate}:${plan.inputCount}:${plan.factor}`;
    const group = groups.get(key) ?? [];
    group.push(plan);
    groups.set(key, group);
  }
  const durationLimit = options.maxChunkDurationSec ?? 30;
  const byteLimit = options.maxChunkBytes ?? 2 * 1024 * 1024;
  if (!Number.isFinite(durationLimit) || durationLimit <= 0 || !Number.isFinite(byteLimit) || byteLimit < 1024) {
    throw new Error("MATLAB display chunk limits must be positive, with at least 1024 bytes.");
  }
  const readWindow = options.readWindow ?? ((start, duration, channels, readOptions) => source.getWindow(start, duration, channels, readOptions));
  const client = createMatlabDisplayWorkerPool({ signal: options.signal, fallbackToMainThread: options.fallbackToMainThread ?? false, workerCount: options.workerCount, channelCount: activePlans.length });
  let completedSamples = 0;
  let lastPartial = -Infinity;
  try {
    options.onProgress?.({ completedSamples, totalSamples, fraction: 0 });
    const firstPlan = activePlans[0];
    if (options.cache && sameRawGrid && firstPlan.factor === 2
      && firstPlan.outputCount / pixelWidth >= MATLAB_TILE_BASE
      && durationLimit * firstPlan.rate / 2 >= MATLAB_TILE_BASE
      && byteLimit / (8 * activePlans.length) >= MATLAB_TILE_BASE * 2 + 64) {
      const phase = firstPlan.firstSample % 2;
      const firstGlobalOutput = (firstPlan.firstSample - phase) / 2;
      const sourceLength = source.meta.durationSec * firstPlan.rate;
      const roundedLength = Math.round(sourceLength);
      const sourceEnd = Math.abs(sourceLength - roundedLength) <= Math.min(1e-6, Number.EPSILON * Math.max(1, sourceLength) * 4)
        ? roundedLength : Math.floor(sourceLength);
      const maximumTile = Math.max(MATLAB_TILE_BASE, Math.min(durationLimit * firstPlan.rate / 2,
        (byteLimit / (8 * activePlans.length) - 64) / 2));
      const tileSize = 2 ** Math.floor(Math.log2(maximumTile));
      const scope = options.cache.scope(source, [indices, labels, units, montage, request.bipolarKind,
        [...excludedPositions], montageOptions.allChannelLabels, firstPlan.rate, phase]);
      return await buildCachedMatlabDisplay({ metadata: finalize(), cache: options.cache, scope,
        firstSample: firstPlan.firstSample, outputCount: firstPlan.outputCount, rate: firstPlan.rate,
        startSec, durationSec, pixelWidth, tileSize, options,
        load: async (globalStart, count, stable) => {
          checkAborted(options.signal);
          const inputFirst = stable ? phase : firstPlan.firstSample;
          const inputCount = stable ? sourceEnd - phase : firstPlan.inputCount;
          const outputStart = stable ? globalStart : globalStart - firstGlobalOutput;
          const range = matlabDisplayChunkInputRange(inputCount, 2, outputStart, count);
          const coreFirst = phase + globalStart * 2;
          const coreEnd = Math.min(inputFirst + inputCount - 1, coreFirst + count * 2);
          // Two qualification intervals cover runs and synchronized-region
          // duration on both sides of a tile; view boundaries still truncate.
          const halo = 2 * Math.ceil(0.25 * firstPlan.rate) + 4;
          const readFirst = Math.max(inputFirst, Math.min(inputFirst + range.firstSample, coreFirst - halo));
          const readEnd = Math.min(inputFirst + inputCount, Math.max(inputFirst + range.endSample, coreEnd + halo + 1));
          const window = await readWindow(readFirst / firstPlan.rate, (readEnd - readFirst + 1) / firstPlan.rate,
            activePlans.map((entry) => entry.sourceIndex), { signal: options.signal });
          checkAborted(options.signal);
          const raw = activePlans.map((entry) => {
            const position = window.channelIndices.indexOf(entry.sourceIndex);
            if (position < 0 || Math.abs(window.sampleRates[position] - entry.rate) > 1e-9) {
              throw new Error("Source read returned missing or incompatible MATLAB display channels.");
            }
            const offset = readFirst - Math.round(window.channelStartSecs[position] * entry.rate);
            if (offset < 0 || offset + readEnd - readFirst > window.data[position].length) {
              throw new Error("Source read did not cover the exact MATLAB display sample range.");
            }
            return window.data[position].subarray(offset, offset + readEnd - readFirst);
          });
          return async () => {
            checkAborted(options.signal);
            const tileFlatlines = detectMatlabTileFlatlines(raw, firstPlan.rate).map((region) => ({
              startSample: Math.max(coreFirst, readFirst + region.startSample),
              endSample: Math.min(coreEnd, readFirst + region.endSample),
            })).filter((region) => region.endSample > region.startSample);
            const filtered = await client.process(raw.map((values) => ({
              data: values.subarray(inputFirst + range.firstSample - readFirst, inputFirst + range.endSample - readFirst),
              options: { inputSampleCount: inputCount, factor: 2, inputStartIndex: range.firstSample,
                outputStartIndex: outputStart, outputSampleCount: count },
            })));
            checkAborted(options.signal);
            let rows: Float64Array[];
            if (montage === "referential") rows = filtered.map((values) => values instanceof Float64Array ? values : Float64Array.from(values));
            else {
              const montageData = plans.map(() => new Float64Array());
              filtered.forEach((values, position) => { montageData[activePlans[position].position] = Float64Array.from(values); });
              const derived = buildMontage(montageData, labels, montage, excludedPositions, outputRates, firstTimes, montageOptions);
              if (derived.labels.length !== template.labels.length || derived.labels.some((label, row) => label !== template.labels[row])) {
                throw new Error("MATLAB montage changed identity between display chunks.");
              }
              rows = derived.data.map((values) => values instanceof Float64Array ? values : Float64Array.from(values));
            }
            return { rows, flatlines: tileFlatlines };
          };
        },
      });
    }
    for (const group of groups.values()) {
      const plan = group[0];
      const maximumOutputs = Math.max(1, Math.min(
        Math.floor(durationLimit * plan.rate / plan.factor),
        Math.floor((byteLimit / (8 * group.length) - 64) / plan.factor),
      ));
      for (let outputStart = 0; outputStart < plan.outputCount; outputStart += maximumOutputs) {
        checkAborted(options.signal);
        const count = Math.min(maximumOutputs, plan.outputCount - outputStart);
        const range = matlabDisplayChunkInputRange(plan.inputCount, plan.factor, outputStart, count);
        const absoluteFirst = plan.firstSample + range.firstSample;
        // One trailing input sample covers floating-point time-to-index rounding
        // in file sources. Exact coverage is sliced using returned timestamps.
        const window = await readWindow(absoluteFirst / plan.rate, (range.endSample - range.firstSample + 1) / plan.rate,
          group.map((entry) => entry.sourceIndex), { signal: options.signal });
        checkAborted(options.signal);
        const chunks = group.map((entry) => {
          const position = window.channelIndices.indexOf(entry.sourceIndex);
          if (position < 0 || Math.abs(window.sampleRates[position] - entry.rate) > 1e-9) {
            throw new Error("Source read returned missing or incompatible MATLAB display channels.");
          }
          const offset = absoluteFirst - Math.round(window.channelStartSecs[position] * entry.rate);
          const length = range.endSample - range.firstSample;
          if (offset < 0 || offset + length > window.data[position].length) {
            throw new Error("Source read did not cover the exact MATLAB display sample range.");
          }
          return { data: window.data[position].subarray(offset, offset + length), options: {
            inputSampleCount: entry.inputCount, factor: entry.factor, inputStartIndex: range.firstSample,
            outputStartIndex: outputStart, outputSampleCount: count,
          } };
        });
        // Feed each source sample once, before FIR/montage, despite read halos.
        flatlines?.push(chunks.map((chunk) => chunk.data), range.firstSample);
        const filtered = await client.process(chunks);
        checkAborted(options.signal);
        let rows: { row: number; values: MatlabDisplaySamples }[];
        if (montage === "referential") {
          rows = filtered.map((values, position) => ({ row: group[position].position, values }));
        } else {
          // Keep positions in the complete selection, including excluded rows,
          // so source identities and fixed pairs survive omitted read channels.
          const montageData: Float64Array[] = plans.map(() => new Float64Array());
          filtered.forEach((values, position) => {
            montageData[group[position].position] = values instanceof Float64Array ? values : Float64Array.from(values);
          });
          const derived = buildMontage(montageData,
            labels, montage, excludedPositions, outputRates,
            firstTimes.map((time, position) => time + outputStart / outputRates[position]), montageOptions);
          if (derived.labels.length !== template.labels.length || derived.labels.some((label, row) => label !== template.labels[row])) {
            throw new Error("MATLAB montage changed identity between display chunks.");
          }
          rows = derived.data.map((values, row) => ({ row, values }));
          for (const warning of derived.warnings) warnings.add(warning);
        }
        for (const { row, values } of rows) {
          const envelope = envelopes[row];
          if (!envelope) data[row].set(values, outputStart);
          else {
            const rowPlan = rowPlans[row];
            for (let sample = 0; sample < values.length; sample += 1) {
              const value = values[sample];
              const relativeTime = ((outputStart + sample) * rowPlan.factor + 1) / rowPlan.rate;
              const bucket = Math.max(0, Math.min(bucketCount - 1, Math.floor(relativeTime / durationSec * bucketCount)));
              if (!Number.isFinite(value)) envelope.gaps[bucket] = 1;
              else {
                envelope.minima[bucket] = Math.min(envelope.minima[bucket], value);
                envelope.maxima[bucket] = Math.max(envelope.maxima[bucket], value);
                data[row][bucket] = value; // An actual retained sample, never a fabricated mean.
              }
            }
          }
        }
        completedSamples += count * group.length;
        options.onProgress?.({ completedSamples, totalSamples, fraction: totalSamples ? completedSamples / totalSamples : 1 });
        checkAborted(options.signal);
        if (options.onPartial && sameRawGrid && completedSamples < totalSamples && performance.now() - lastPartial >= 200) {
          lastPartial = performance.now();
          const through = (outputStart + count) * plan.factor / plan.rate;
          const completedTime = envelopes[0] ? Math.floor(through / durationSec * bucketCount) * durationSec / bucketCount : through;
          options.onPartial(finalize(true), startSec + completedTime);
        }
      }
    }
  } finally {
    client.close();
  }
  checkAborted(options.signal);
  return finalize();
}
