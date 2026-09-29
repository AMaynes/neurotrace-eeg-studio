/**
 * Independent numerical implementation of the supplied MATLAB reviewer's Gabor
 * spectrogram. Reference: awt_freqlist.m (Clerc/Benar, 2007/2008), byte-identical
 * in the two supplied local toolbox trees; SHA-256:
 * 76d751080f09fd3929185f055bfebda5afec8085c359e203db474141dcc0cb1a.
 * Public provenance: buzsakilab/buzcode, commit
 * dffc8d0e30851c564361c3e2bddfec8be953ea79, externalPackages/awt_freqlist.m.
 * The toolbox repository carries GPL-3.0; no toolbox source is bundled here.
 *
 * Preserve the exact N-point circular transform (including positive even-N
 * Nyquist and the unmasked negative-frequency Gaussian tail). Bluestein's
 * convolution padding is internal: it does not zero-pad the signal's DFT.
 */

export const MATLAB_SPECTROGRAM_BINS = 60;
export const MATLAB_SPECTROGRAM_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MATLAB_SPECTROGRAM_MAX_INPUT_BYTES = 128 * 1024 * 1024;
const MATLAB_EPS = 2 ** -52;

export interface MatlabSpectrogramRequest {
  /** Already cropped, synchronized raw group channels; no filtering or resampling. */
  data: readonly (Float32Array | Float64Array)[];
  sampleRate: number;
  /** Plot-axis time of the first supplied sample. */
  dataStart: number;
  /** Plot-axis time of the selected sample, snapped by the caller. */
  baselineTime: number;
}

export interface MatlabSpectrogramResult {
  /** Frequency-major matrices: frequencyIndex * width + sampleIndex. */
  power: Float64Array;
  zScores: Float64Array;
  frequencies: Float64Array;
  /** Seconds relative to dataStart, matching MATLAB timeBins. */
  times: Float64Array;
  dataStart: number;
  sampleRate: number;
  width: number;
  height: number;
  baselineMean: Float64Array;
  baselineStd: Float64Array;
  baselineFrameCount: number;
  usedBaselineFallback: boolean;
  colorLimit: number;
  warnings: string[];
  metrics: { computeMs: number; inputBytes: number; outputBytes: number; inputCopyMs?: number; workerRoundTripMs?: number };
}

/** Cheap shape/size guard also runs before the client copies any input. */
export function validateMatlabSpectrogramRequest(request: MatlabSpectrogramRequest) {
  const { data, sampleRate, dataStart, baselineTime } = request;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(dataStart) || !Number.isFinite(baselineTime)) {
    throw new RangeError("MATLAB spectrogram requires finite times and a positive sample rate.");
  }
  const samples = data[0]?.length ?? 0;
  if (!data.length || samples < 3 || data.some((channel) =>
    !(channel instanceof Float32Array || channel instanceof Float64Array) || channel.length !== samples)) {
    throw new RangeError("MATLAB spectrogram requires synchronized group channels with at least 3 samples each.");
  }
  const inputBytes = data.reduce((sum, channel) => sum + channel.byteLength, 0);
  const outputBytes = samples * MATLAB_SPECTROGRAM_BINS * 16 + samples * 8 + MATLAB_SPECTROGRAM_BINS * 24;
  if (inputBytes > MATLAB_SPECTROGRAM_MAX_INPUT_BYTES || outputBytes > MATLAB_SPECTROGRAM_MAX_OUTPUT_BYTES) {
    throw new RangeError("Exact MATLAB spectrogram exceeds its memory budget. Zoom in or choose a smaller channel group.");
  }
  return { samples, inputBytes, outputBytes };
}

function frequencyGrid() {
  const maximumLog = Math.log10(150);
  return Float64Array.from({ length: MATLAB_SPECTROGRAM_BINS }, (_, index) =>
    index === MATLAB_SPECTROGRAM_BINS - 1 ? 150 : 10 ** (index * maximumLog / (MATLAB_SPECTROGRAM_BINS - 1)));
}

class Radix2Plan {
  readonly size: number;
  private readonly cosine: Float64Array;
  private readonly sine: Float64Array;
  constructor(size: number) {
    this.size = size;
    this.cosine = new Float64Array(size / 2);
    this.sine = new Float64Array(size / 2);
    for (let index = 0; index < size / 2; index += 1) {
      this.cosine[index] = Math.cos(2 * Math.PI * index / size);
      this.sine[index] = Math.sin(2 * Math.PI * index / size);
    }
  }
  transform(real: Float64Array, imaginary: Float64Array, inverse = false) {
    const n = this.size;
    for (let index = 1, reversed = 0; index < n; index += 1) {
      let bit = n >> 1;
      while (reversed & bit) { reversed ^= bit; bit >>= 1; }
      reversed ^= bit;
      if (index < reversed) {
        [real[index], real[reversed]] = [real[reversed], real[index]];
        [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
      }
    }
    for (let span = 2; span <= n; span *= 2) {
      const half = span / 2;
      const stride = n / span;
      for (let start = 0; start < n; start += span) {
        for (let index = 0; index < half; index += 1) {
          const a = start + index;
          const b = a + half;
          const cosine = this.cosine[index * stride];
          const sine = this.sine[index * stride] * (inverse ? 1 : -1);
          const realProduct = real[b] * cosine - imaginary[b] * sine;
          const imaginaryProduct = real[b] * sine + imaginary[b] * cosine;
          real[b] = real[a] - realProduct;
          imaginary[b] = imaginary[a] - imaginaryProduct;
          real[a] += realProduct;
          imaginary[a] += imaginaryProduct;
        }
      }
    }
    if (inverse) for (let index = 0; index < n; index += 1) {
      real[index] /= n;
      imaginary[index] /= n;
    }
  }
}

/** Reuses chirps, convolution kernel FFT, and scratch space for all 60 bins. */
class ExactDftPlan {
  readonly size: number;
  private readonly radix: Radix2Plan;
  private readonly direct: boolean;
  private readonly cosine: Float64Array;
  private readonly sine: Float64Array;
  private readonly kernelReal: Float64Array;
  private readonly kernelImaginary: Float64Array;
  private readonly scratchReal: Float64Array;
  private readonly scratchImaginary: Float64Array;
  constructor(size: number) {
    this.size = size;
    this.direct = (size & (size - 1)) === 0;
    let workSize = size;
    if (!this.direct) { workSize = 1; while (workSize < 2 * size - 1) workSize *= 2; }
    this.radix = new Radix2Plan(workSize);
    this.cosine = new Float64Array(this.direct ? 0 : size);
    this.sine = new Float64Array(this.direct ? 0 : size);
    this.kernelReal = new Float64Array(this.direct ? 0 : workSize);
    this.kernelImaginary = new Float64Array(this.direct ? 0 : workSize);
    this.scratchReal = new Float64Array(this.direct ? 0 : workSize);
    this.scratchImaginary = new Float64Array(this.direct ? 0 : workSize);
    if (!this.direct) {
      for (let index = 0; index < size; index += 1) {
        const angle = Math.PI * ((index * index) % (2 * size)) / size;
        this.cosine[index] = this.kernelReal[index] = Math.cos(angle);
        this.sine[index] = this.kernelImaginary[index] = Math.sin(angle);
        if (index) {
          this.kernelReal[workSize - index] = this.cosine[index];
          this.kernelImaginary[workSize - index] = this.sine[index];
        }
      }
      this.radix.transform(this.kernelReal, this.kernelImaginary);
    }
  }
  transform(real: Float64Array, imaginary: Float64Array, inverse = false) {
    if (this.direct) { this.radix.transform(real, imaginary, inverse); return; }
    const { scratchReal: re, scratchImaginary: im, cosine, sine } = this;
    re.fill(0); im.fill(0);
    for (let index = 0; index < this.size; index += 1) {
      const inputImaginary = imaginary[index] * (inverse ? -1 : 1);
      re[index] = real[index] * cosine[index] + inputImaginary * sine[index];
      im[index] = inputImaginary * cosine[index] - real[index] * sine[index];
    }
    this.radix.transform(re, im);
    for (let index = 0; index < re.length; index += 1) {
      const productReal = re[index] * this.kernelReal[index] - im[index] * this.kernelImaginary[index];
      im[index] = re[index] * this.kernelImaginary[index] + im[index] * this.kernelReal[index];
      re[index] = productReal;
    }
    this.radix.transform(re, im, true);
    for (let index = 0; index < this.size; index += 1) {
      real[index] = (re[index] * cosine[index] + im[index] * sine[index]) / (inverse ? this.size : 1);
      imaginary[index] = (im[index] * cosine[index] - re[index] * sine[index]) * (inverse ? -1 / this.size : 1);
    }
  }
}

function validGaborScale(samples: number, rate: number, frequency: number) {
  const scale = 5 / frequency;
  // Compare scales, as awt_freqlist does, including both endpoints.
  return scale >= 5 / (rate * 5 / 5.5) && scale <= 5 / (5 * rate / samples);
}

function gaborBin(plan: ExactDftPlan, fftReal: Float64Array, fftImaginary: Float64Array,
  rate: number, frequency: number, real: Float64Array, imaginary: Float64Array) {
  const scale = 5 / frequency;
  const factor = (4 * Math.PI) ** 0.25 * Math.sqrt(scale);
  for (let index = 0; index < real.length; index += 1) {
    const omega = (index <= Math.floor(real.length / 2) ? index : index - real.length) * rate / real.length;
    const displacement = scale * omega - 5;
    const response = factor * Math.exp(-0.5 * displacement * displacement);
    real[index] = fftReal[index] * response;
    imaginary[index] = fftImaginary[index] * response;
  }
  plan.transform(real, imaginary, true);
}

/** One exact complex bin; also exposes phase for independent numerical audits. */
export function computeMatlabGaborCoefficients(data: Float32Array | Float64Array, sampleRate: number, frequency: number) {
  validateMatlabSpectrogramRequest({ data: [data], sampleRate, dataStart: 0, baselineTime: 0 });
  if (!(frequency > 0) || !Number.isFinite(frequency)) throw new RangeError("Gabor frequency must be positive and finite.");
  if (data.some((value) => !Number.isFinite(value))) throw new RangeError("MATLAB spectrogram cannot compute through missing/non-finite samples.");
  const real = new Float64Array(data.length);
  const imaginary = new Float64Array(data.length);
  const validScale = validGaborScale(data.length, sampleRate, frequency);
  if (!validScale) return { real, imaginary, validScale };
  const fftReal = Float64Array.from(data);
  const fftImaginary = new Float64Array(data.length);
  const plan = new ExactDftPlan(data.length);
  plan.transform(fftReal, fftImaginary);
  gaborBin(plan, fftReal, fftImaginary, sampleRate, frequency, real, imaginary);
  return { real, imaginary, validScale };
}

/** MATLAB prctile's midpoint-rank interpolation, with endpoint clamping. */
export function matlabPercentile(values: Float64Array, percentile: number) {
  const sorted = values.slice().sort();
  if (!sorted.length) return Number.NaN;
  const rank = Math.max(0, Math.min(sorted.length - 1, sorted.length * percentile / 100 - 0.5));
  const lower = Math.floor(rank);
  const fraction = rank - lower;
  return sorted[lower] + fraction * (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]);
}

export function computeMatlabSpectrogram(request: MatlabSpectrogramRequest): MatlabSpectrogramResult {
  const started = performance.now();
  const { samples, inputBytes, outputBytes } = validateMatlabSpectrogramRequest(request);
  const { sampleRate, dataStart, baselineTime } = request;
  const frequencies = frequencyGrid();
  const times = Float64Array.from({ length: samples }, (_, index) => index / sampleRate);
  const power = new Float64Array(samples * frequencies.length);
  const zScores = new Float64Array(power.length);
  const plan = new ExactDftPlan(samples);
  const real = new Float64Array(samples);
  const imaginary = new Float64Array(samples);
  let invalidBins = 0;
  for (const frequency of frequencies) if (!validGaborScale(samples, sampleRate, frequency)) invalidBins += 1;
  for (const channel of request.data) {
    if (channel.some((value) => !Number.isFinite(value))) throw new RangeError("MATLAB spectrogram cannot compute through missing/non-finite samples. Choose a gap-free window.");
    const fftReal = Float64Array.from(channel);
    const fftImaginary = new Float64Array(samples);
    plan.transform(fftReal, fftImaginary);
    for (let bin = 0; bin < frequencies.length; bin += 1) {
      if (!validGaborScale(samples, sampleRate, frequencies[bin])) continue;
      gaborBin(plan, fftReal, fftImaginary, sampleRate, frequencies[bin], real, imaginary);
      for (let index = 0; index < samples; index += 1) {
        power[bin * samples + index] += real[index] ** 2 + imaginary[index] ** 2;
      }
    }
  }
  let baselineFrameCount = 0;
  // MATLAB subtracts sample indices before dividing. Snap only floating point
  // subtraction roundoff so a clicked sample never includes itself in baseline.
  const baselinePosition = (baselineTime - dataStart) * sampleRate;
  const nearest = Math.round(baselinePosition);
  const tolerance = 8 * Number.EPSILON * Math.max(1, Math.abs(baselineTime), Math.abs(dataStart)) * sampleRate;
  const clickRelative = (Math.abs(baselinePosition - nearest) <= tolerance ? nearest : baselinePosition) / sampleRate;
  while (baselineFrameCount < samples && times[baselineFrameCount] < clickRelative) baselineFrameCount += 1;
  const usedBaselineFallback = baselineFrameCount < 5;
  if (usedBaselineFallback) baselineFrameCount = Math.round(samples / 2) - 1;
  const baselineMean = new Float64Array(frequencies.length);
  const baselineStd = new Float64Array(frequencies.length);
  for (let bin = 0; bin < frequencies.length; bin += 1) {
    const offset = bin * samples;
    let baselineOrigin = 0;
    let centeredSum = 0;
    for (let index = 0; index < samples; index += 1) {
      const position = offset + index;
      power[position] /= request.data.length;
      if (!Number.isFinite(power[position])) throw new RangeError("Spectrogram power exceeds the supported numeric range.");
      zScores[position] = 10 * Math.log10(power[position] + MATLAB_EPS);
      if (index === 0) baselineOrigin = zScores[position];
      if (index < baselineFrameCount) centeredSum += zScores[position] - baselineOrigin;
    }
    // Center before summing: an exactly constant log-power baseline must not
    // acquire a false variance from accumulating the large negative dB floor.
    const mean = baselineOrigin + centeredSum / baselineFrameCount;
    let squares = 0;
    for (let index = 0; index < baselineFrameCount; index += 1) squares += (zScores[offset + index] - mean) ** 2;
    const deviation = Math.max(MATLAB_EPS, Math.sqrt(squares / Math.max(1, baselineFrameCount - 1)));
    baselineMean[bin] = mean;
    baselineStd[bin] = deviation;
    for (let index = 0; index < samples; index += 1) {
      const score = (zScores[offset + index] - mean) / deviation;
      if (!Number.isFinite(score)) throw new RangeError("Spectrogram baseline normalization exceeds the supported numeric range.");
      zScores[offset + index] = score;
    }
  }
  const absoluteScores = Float64Array.from(zScores, Math.abs);
  const colorLimit = Math.max(1, matlabPercentile(absoluteScores, 98));
  if (!Number.isFinite(colorLimit)) throw new RangeError("Spectrogram color range is not finite.");
  const warnings: string[] = [];
  if (150 > sampleRate / 2) warnings.push("The MATLAB frequency axis extends to 150 Hz, above this recording's Nyquist frequency; those bins are retained to match its algorithm.");
  if (invalidBins) warnings.push(`${invalidBins} frequency bins lie outside awt_freqlist's valid scale interval and remain zero-power, matching MATLAB.`);
  return { power, zScores, frequencies, times, dataStart, sampleRate, width: samples, height: frequencies.length,
    baselineMean, baselineStd, baselineFrameCount, usedBaselineFallback, colorLimit, warnings,
    metrics: { computeMs: Math.max(0, performance.now() - started), inputBytes, outputBytes } };
}

export function matlabSpectrogramTransferList(result: MatlabSpectrogramResult): ArrayBuffer[] {
  return [result.power, result.zScores, result.frequencies, result.times, result.baselineMean, result.baselineStd]
    .map((array) => array.buffer as ArrayBuffer);
}
