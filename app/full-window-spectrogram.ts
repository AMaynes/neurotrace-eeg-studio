/** Bounded full-window Gabor analysis. Runs entirely in a terminable worker. */
import { computeMatlabSpectrogram, computeMatlabSpectrogramPower, matlabPercentile, type MatlabSpectrogramResult } from "./matlab-spectrogram.ts";
import type { MatlabSpectrogramInputPlan } from "./matlab-spectrogram-input.ts";

export const SPECTROGRAM_MAX_TILE_SAMPLES = 65_536;
export const SPECTROGRAM_MAX_COLUMNS = 2_048;
export const SPECTROGRAM_TILE_INPUT_BYTES = 32 * 1024 * 1024;
const EPS = 2 ** -52;
type Samples = Float32Array | Float64Array;
export type SpectrogramSampleReader = (offset: number, count: number) => Promise<Samples[]>;

/** Keep FFT scratch, raw-group input, and frequency matrices bounded at any zoom. */
export function spectrogramTileSize(channels: number) {
  const limit = Math.min(SPECTROGRAM_MAX_TILE_SAMPLES, Math.floor(SPECTROGRAM_TILE_INPUT_BYTES / (channels * 8)));
  if (!(channels > 0) || !Number.isInteger(channels) || limit < 4) throw new RangeError("Spectrogram channel group exceeds its tile budget.");
  return 2 ** Math.floor(Math.log2(limit));
}

function validateSamples(data: Samples[], channels: number, count: number) {
  if (data.length !== channels || data.some((values) =>
    !(values instanceof Float32Array || values instanceof Float64Array) || values.length !== count)) {
    throw new Error("Spectrogram source read did not cover the requested samples.");
  }
}

/** Periodic halo matches the full-window transform's circular boundary convention. */
async function readCircular(reader: SpectrogramSampleReader, offset: number, count: number, length: number, channels: number) {
  const output = Array.from({ length: channels }, () => new Float64Array(count));
  let written = 0;
  while (written < count) {
    const start = ((offset + written) % length + length) % length;
    const take = Math.min(count - written, length - start);
    const data = await reader(start, take);
    validateSamples(data, channels, take);
    data.forEach((values, channel) => output[channel].set(values, written));
    written += take;
  }
  return output;
}

/**
 * Small views use the unchanged exact N-point MATLAB equations. Large views
 * use overlapped Gabor tiles (up to 8 seconds of context on each side), discard
 * halos, and average log-power into <=2048 time cells. No raw resampling, STFT,
 * independent tile Z-scores, or 30-second crop. This is an explicitly labeled
 * overview, not a claim of bit-identical full-length circular FFT output.
 */
export async function computeFullWindowSpectrogram(
  plan: MatlabSpectrogramInputPlan,
  readSamples: SpectrogramSampleReader,
  onProgress: (completedSamples: number, totalSamples: number) => void = () => {},
): Promise<MatlabSpectrogramResult> {
  const started = performance.now();
  const { sampleCount: total, sourceIndices, sampleRate, dataStart, baselineTime } = plan;
  if (!Number.isSafeInteger(total) || total < 3 || !Number.isFinite(sampleRate) || sampleRate <= 0
    || !Number.isFinite(dataStart) || !Number.isFinite(baselineTime)) throw new RangeError("Spectrogram requires at least three samples and valid timing.");
  const tileSize = spectrogramTileSize(sourceIndices.length);
  if (total <= tileSize) {
    const data = await readSamples(0, total);
    validateSamples(data, sourceIndices.length, total);
    const result = computeMatlabSpectrogram({ data, sampleRate, dataStart, baselineTime });
    onProgress(total, total);
    return result;
  }
  const halo = Math.min(Math.ceil(8 * sampleRate), Math.floor(tileSize / 4));
  const coreSize = tileSize - 2 * halo;
  const width = Math.min(SPECTROGRAM_MAX_COLUMNS, total);
  // Input planning has already snapped the click to a source sample.
  const clicked = Math.max(0, Math.min(total - 1, Math.round((baselineTime - dataStart) * sampleRate)));
  const usedBaselineFallback = clicked < 5;
  const baselineEnd = usedBaselineFallback ? Math.round(total / 2) - 1 : clicked;
  let frequencies: Float64Array = new Float64Array();
  let power = new Float64Array(), logSum = new Float64Array();
  let baselineMean = new Float64Array(), baselineM2 = new Float64Array();
  let baselineFrameCount = 0, inputBytes = 0, computeMs = 0;
  const counts = new Float64Array(width);
  const warnings = new Set<string>();
  for (let from = 0; from < total; from += coreSize) {
    const take = Math.min(coreSize, total - from);
    // Fixed power-of-two FFT size even for the final partial tile.
    const data = await readCircular(readSamples, from - halo, tileSize, total, sourceIndices.length);
    inputBytes += data.reduce((sum, values) => sum + values.byteLength, 0);
    if (data.some((values) => values.some((value) => !Number.isFinite(value)))) {
      warnings.add("Tiles containing missing samples are left blank; gaps are never filled with invented signal.");
      onProgress(from + take, total);
      continue;
    }
    const tile = computeMatlabSpectrogramPower({ data, sampleRate, dataStart: 0, baselineTime: 0 });
    computeMs += tile.metrics.computeMs;
    tile.warnings.forEach((warning) => warnings.add(warning));
    if (!frequencies.length) {
      frequencies = tile.frequencies;
      power = new Float64Array(width * tile.height);
      logSum = new Float64Array(power.length);
      baselineMean = new Float64Array(tile.height);
      baselineM2 = new Float64Array(tile.height);
    }
    const preCount = Math.max(0, Math.min(take, baselineEnd - from));
    for (let bin = 0; bin < tile.height; bin++) {
      let mean = baselineMean[bin], m2 = baselineM2[bin], n = baselineFrameCount;
      for (let index = 0; index < take; index++) {
        const column = Math.min(width - 1, Math.floor((from + index) * width / total));
        const value = tile.power[bin * tile.width + halo + index];
        const log = 10 * Math.log10(value + EPS);
        const withinTileColumn = index - Math.max(0, Math.ceil(column * total / width) - from) + 1;
        const count = counts[column] + withinTileColumn;
        const position = bin * width + column;
        power[position] += (value - power[position]) / count;
        logSum[position] += (log - logSum[position]) / count;
        if (index < preCount) {
          n++;
          const delta = log - mean;
          mean += delta / n;
          m2 += delta * (log - mean);
        }
      }
      baselineMean[bin] = mean; baselineM2[bin] = m2;
    }
    for (let index = 0; index < take; index++) counts[Math.min(width - 1, Math.floor((from + index) * width / total))]++;
    baselineFrameCount += preCount;
    onProgress(from + take, total);
  }
  if (!frequencies.length || baselineFrameCount < 2) throw new Error("Spectrogram has insufficient gap-free baseline samples in this window.");
  const baselineStd = Float64Array.from(baselineM2, (m2) => Math.max(EPS, Math.sqrt(Math.max(0, m2) / (baselineFrameCount - 1))));
  const zScores = new Float64Array(power.length);
  for (let bin = 0; bin < frequencies.length; bin++) for (let column = 0; column < width; column++) {
    const position = bin * width + column;
    const expected = Math.ceil((column + 1) * total / width) - Math.ceil(column * total / width);
    if (counts[column] !== expected) { power[position] = zScores[position] = NaN; continue; }
    zScores[position] = (logSum[position] - baselineMean[bin]) / baselineStd[bin];
  }
  const absolute = Float64Array.from(zScores.filter(Number.isFinite), Math.abs);
  const colorLimit = Math.max(1, matlabPercentile(absolute, 98));
  if (!Number.isFinite(colorLimit)) throw new Error("Spectrogram has no complete time cells to display.");
  const times = Float64Array.from({ length: width }, (_, column) => (column + .5) * total / (width * sampleRate));
  const outputBytes = [power, zScores, frequencies, times, baselineMean, baselineStd].reduce((sum, a) => sum + a.byteLength, 0);
  return { power, zScores, frequencies, times, dataStart: dataStart - 1 / sampleRate, sampleRate,
    width, height: frequencies.length, baselineMean, baselineStd, baselineFrameCount, usedBaselineFallback,
    colorLimit, warnings: [...warnings], tiled: true,
    metrics: { inputBytes, outputBytes, computeMs, workerRoundTripMs: performance.now() - started } };
}
