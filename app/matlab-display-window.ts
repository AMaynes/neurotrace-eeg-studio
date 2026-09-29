/** Bounded, full-view MATLAB processing; reduction happens after filter/montage. */
import { buildMontage, type MontageMode, type SignalReadOptions, type SignalSource, type WindowData } from "./eeg-core.ts";
import type { BipolarMontageKind } from "./bipolar-montage.ts";
import { matlabDisplayChunkInputRange, matlabDisplayDecimationFactor, type MatlabDisplayFactor, type MatlabDisplaySamples } from "./matlab-display-processing.ts";
import { createMatlabDisplayWorkerClient } from "./matlab-display-worker-client.ts";

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
 * Exact equal-rate raw flatline detection across overlapping read chunks. A
 * quarter-second delayed event ring permits retroactive qualification of a
 * channel's flat run without keeping the samples or all per-channel intervals.
 * NaNs break runs; the threshold denominator includes every selected channel.
 */
export function createMatlabRawFlatlineDetector(channelCount: number, sampleRate: number, plottedStartSec: number) {
  if (!Number.isSafeInteger(channelCount) || channelCount < 1 || !Number.isFinite(sampleRate) || sampleRate <= 0
    || !Number.isFinite(plottedStartSec)) throw new Error("Invalid streamed raw flatline geometry.");
  const minimumDuration = 0.25;
  const lag = Math.max(1, Math.ceil(minimumDuration * sampleRate));
  const ring = new Int32Array(lag + 2);
  const previous = new Float64Array(channelCount).fill(NaN);
  const runStarts = new Float64Array(channelCount).fill(-1);
  const qualified = new Uint8Array(channelCount);
  const regions: { startSec: number; endSec: number }[] = [];
  let nextInput = 0;
  let nextEvent = 0;
  let activeChannels = 0;
  let regionStart = -1;
  let finished = false;
  const requiredChannels = Math.ceil(channelCount * 0.8);
  const emit = (endSample: number) => {
    if (regionStart >= 0 && (endSample - regionStart) / sampleRate >= minimumDuration) {
      regions.push({ startSec: plottedStartSec + regionStart / sampleRate, endSec: plottedStartSec + endSample / sampleRate });
    }
    regionStart = -1;
  };
  const processEvents = (through: number) => {
    while (nextEvent <= through) {
      const slot = nextEvent % ring.length;
      activeChannels += ring[slot];
      ring[slot] = 0;
      if (activeChannels >= requiredChannels) {
        if (regionStart < 0) regionStart = nextEvent;
      } else if (regionStart >= 0) emit(nextEvent);
      nextEvent++;
    }
  };
  return {
    push(data: readonly MatlabDisplaySamples[], inputStartIndex: number) {
      if (finished) throw new Error("Cannot append to a finished raw flatline detector.");
      if (data.length !== channelCount || data.some((values) => values.length !== data[0].length)
        || !Number.isSafeInteger(inputStartIndex) || inputStartIndex < 0 || inputStartIndex > nextInput) {
        throw new Error("Raw flatline chunks must be aligned and contiguous (overlap is allowed).");
      }
      const count = data[0].length;
      for (let local = Math.max(0, nextInput - inputStartIndex); local < count; local++) {
        const sample = inputStartIndex + local;
        for (let channel = 0; channel < channelCount; channel++) {
          const value = data[channel][local];
          if (Number.isFinite(value) && Number.isFinite(previous[channel]) && value === previous[channel]) {
            if (runStarts[channel] < 0) runStarts[channel] = sample - 1;
            if (!qualified[channel] && (sample - runStarts[channel]) / sampleRate >= minimumDuration) {
              ring[runStarts[channel] % ring.length]++;
              qualified[channel] = 1;
            }
          } else {
            if (qualified[channel]) ring[(sample - 1) % ring.length]--;
            runStarts[channel] = -1;
            qualified[channel] = 0;
          }
          previous[channel] = value;
        }
        nextInput = sample + 1;
        processEvents(sample - lag);
      }
    },
    finish() {
      if (!finished) {
        const lastSample = nextInput - 1;
        if (lastSample >= 0) {
          for (let channel = 0; channel < channelCount; channel++) {
            if (qualified[channel]) ring[lastSample % ring.length]--;
          }
          processEvents(lastSample);
          if (regionStart >= 0) emit(lastSample);
        }
        finished = true;
      }
      return regions;
    },
  };
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
    const inputCount = Math.max(0, Math.min(Math.floor(durationSec * rate), Math.floor(source.meta.durationSec * rate) - firstSample));
    const factor = matlabDisplayDecimationFactor(inputCount, pixelWidth);
    return { position, sourceIndex, rate, firstSample, inputCount, factor, outputCount: Math.ceil(inputCount / factor) };
  });
  if (plans.some((plan) => !Number.isSafeInteger(plan.inputCount) || !Number.isSafeInteger(plan.firstSample))) {
    throw new Error("MATLAB display sample range exceeds safe integer precision.");
  }
  if (montage !== "referential" && plans.some((plan) => plan.rate !== plans[0].rate
    || plan.factor !== plans[0].factor || plan.inputCount !== plans[0].inputCount)) {
    throw new Error("MATLAB-compatible derived montages require equal sample rates and aligned window lengths; mixed-rate signals cannot be combined.");
  }
  const excludedPositions = new Set<number | string>();
  for (const excluded of request.excludedChannels ?? []) {
    if (typeof excluded === "string") excludedPositions.add(excluded);
    else {
      const position = indices.indexOf(excluded);
      if (position >= 0) excludedPositions.add(position);
    }
  }
  const warnings = new Set<string>();
  const sameRawGrid = plans.every((plan) => plan.rate === plans[0].rate && plan.inputCount === plans[0].inputCount);
  const flatlines = sameRawGrid
    ? createMatlabRawFlatlineDetector(plans.length, plans[0].rate, startSec + 1 / plans[0].rate)
    : null;
  if (!sameRawGrid) warnings.add("Synchronized raw flatline markers are unavailable for mixed-rate selections in MATLAB-compatible view.");
  if (montage !== "referential") {
    const unitCounts = new Map<string, number>();
    for (const unit of units) unitCounts.set(unit, (unitCounts.get(unit) ?? 0) + 1);
    const referenceUnit = [...unitCounts].sort((a, b) => b[1] - a[1] || Number(b[0] === "µV") - Number(a[0] === "µV"))[0]?.[0];
    units.forEach((unit, position) => { if (unit !== referenceUnit) excludedPositions.add(position); });
    if (units.some((unit) => unit !== referenceUnit)) warnings.add("Channels with incompatible physical units were excluded from montage arithmetic.");
  }
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
  const groups = new Map<string, SourcePlan[]>();
  for (const plan of plans) {
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
  const client = createMatlabDisplayWorkerClient({ signal: options.signal, fallbackToMainThread: options.fallbackToMainThread ?? false });
  const totalSamples = plans.reduce((sum, plan) => sum + plan.outputCount, 0);
  let completedSamples = 0;
  options.onProgress?.({ completedSamples, totalSamples, fraction: totalSamples ? 0 : 1 });
  try {
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
          // Equal rates/lengths above ensure every selected source is in this
          // group. Promote factor-1 views as well so montage never rounds them.
          const derived = buildMontage(filtered.map((values) => values instanceof Float64Array ? values : Float64Array.from(values)),
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
      }
    }
  } finally {
    client.close();
  }
  checkAborted(options.signal);
  envelopes.forEach((envelope) => {
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
    data, envelopes, labels: template.labels,
    units: template.primarySourceIndices.map((position) => units[position]),
    sampleRates: template.primarySourceIndices.map((position) => outputRates[position]),
    sourceSampleRates: template.primarySourceIndices.map((position) => sourceRates[position]),
    factors: rowPlans.map((plan) => plan.factor), retainedSampleCounts: rowPlans.map((plan) => plan.outputCount),
    startSecs: rowPlans.map((plan, row) => envelopes[row] ? startSec : startSec + 1 / plan.rate),
    sourceStartSampleIndices: rowPlans.map((plan) => plan.firstSample),
    sourceIndices: template.sourceIndices.map((contributors) => contributors.map((position) => indices[position])),
    primarySourceIndices: template.primarySourceIndices.map((position) => indices[position]),
    warnings: [...warnings],
    flatlineRegions: flatlines?.finish() ?? [],
    byteLength: data.reduce((sum, values) => sum + values.byteLength, 0)
      + envelopes.reduce((sum, envelope) => sum + (envelope ? envelope.minima.byteLength + envelope.maxima.byteLength + envelope.gaps.byteLength : 0), 0),
  };
}
