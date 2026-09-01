/** Buzcode TheStateEditor-compatible spectrogram math shared by the worker and tests. */

export const BUZCODE_FFT_SIZE = 3072;
export const BUZCODE_TIME_BANDWIDTH = 3;
export const BUZCODE_TAPER_COUNT = 2 * BUZCODE_TIME_BANDWIDTH - 1;
export const BUZCODE_MAX_COMPUTED_FREQUENCY_HZ = 200;
export const BUZCODE_DEFAULT_DISPLAY_FREQUENCY_HZ = 40;
export const BUZCODE_FREQUENCY_RESOLUTION_HZ = 0.5;
export const BUZCODE_DEFAULT_SMOOTHING_SECONDS = 10;
export const BUZCODE_SMOOTHING_OPTIONS = [0, 5, 10, 15, 20, 30, 45, 60] as const;

export interface SpectrogramComputeRequest {
  data: Float32Array;
  sampleRate: number;
}

export interface SpectrogramComputeMetrics {
  /** Time spent on the worker's signal math, excluding worker startup and drawing. */
  computeMs: number;
  inputSamples: number;
  finiteFrames: number;
  /** Number of finite sample/taper terms considered by the spectral loops. */
  dftTerms: number;
  /** Populated by the browser client after the transferable input copy is made. */
  inputCopyMs?: number;
  /** Populated by the browser client when the worker response arrives. */
  workerRoundTripMs?: number;
}

export interface SpectrogramComputeResult {
  /** Bin-major unsmoothed multitaper powers: `powers[bin * frames + frame]`. */
  powers: Float64Array;
  frequencies: Float64Array;
  /** Frame-center offsets in seconds from the input window start. */
  times: Float64Array;
  frames: number;
  bins: number;
  maxHz: number;
  windowSize: number;
  hop: number;
  fftSize: number;
  tapers: number;
  metrics: SpectrogramComputeMetrics;
}

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function validateRequest(request: SpectrogramComputeRequest) {
  if (!(request.data instanceof Float32Array)) {
    throw new TypeError("Spectrogram input must be a Float32Array.");
  }
  if (request.data.length < 1) {
    throw new RangeError("Spectrogram input must contain at least one sample.");
  }
  if (!Number.isFinite(request.sampleRate) || request.sampleRate < 2) {
    throw new RangeError("Spectrogram sampling rate must be at least 2 Hz.");
  }
}

function estimateAr2(signal: Float32Array) {
  let x1x1 = 0;
  let x1x2 = 0;
  let x2x2 = 0;
  let x1y = 0;
  let x2y = 0;
  let count = 0;
  for (let index = 2; index < signal.length; index += 1) {
    const y = signal[index];
    const x1 = signal[index - 1];
    const x2 = signal[index - 2];
    if (![y, x1, x2].every(Number.isFinite)) continue;
    x1x1 += x1 * x1;
    x1x2 += x1 * x2;
    x2x2 += x2 * x2;
    x1y += x1 * y;
    x2y += x2 * y;
    count += 1;
  }
  const determinant = x1x1 * x2x2 - x1x2 * x1x2;
  if (count < 3 || !Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    return [0, 0] as const;
  }
  return [
    (x1y * x2x2 - x2y * x1x2) / determinant,
    (x2y * x1x1 - x1y * x1x2) / determinant,
  ] as const;
}

/** Matches TheStateEditor's AR(2) whitening policy, using one model for the input. */
function whitenAr2(signal: Float32Array) {
  const [a1, a2] = estimateAr2(signal);
  const whitened = new Float64Array(signal.length);
  whitened.fill(Number.NaN);
  for (let index = 2; index < signal.length; index += 1) {
    const value = signal[index];
    const previous = signal[index - 1];
    const previous2 = signal[index - 2];
    if (![value, previous, previous2].every(Number.isFinite)) continue;
    whitened[index] = value - a1 * previous - a2 * previous2;
  }
  return whitened;
}

function dot(left: Float64Array, right: Float64Array) {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += left[index] * right[index];
  return sum;
}

function normalize(vector: Float64Array) {
  const magnitude = Math.sqrt(Math.max(Number.EPSILON, dot(vector, vector)));
  for (let index = 0; index < vector.length; index += 1) vector[index] /= magnitude;
}

function orthonormalize(vectors: Float64Array[]) {
  for (let column = 0; column < vectors.length; column += 1) {
    const vector = vectors[column];
    for (let previous = 0; previous < column; previous += 1) {
      const projection = dot(vector, vectors[previous]);
      for (let index = 0; index < vector.length; index += 1) {
        vector[index] -= projection * vectors[previous][index];
      }
    }
    normalize(vector);
  }
}

const taperCache = new Map<number, Float64Array[]>();

/**
 * Computes the leading DPSS subspace from the standard Slepian tridiagonal
 * eigenproblem. Averaged multitaper power is invariant to rotations within it.
 */
function dpssTapers(length: number) {
  const cached = taperCache.get(length);
  if (cached) return cached;
  const diagonal = new Float64Array(length);
  const offDiagonal = new Float64Array(Math.max(0, length - 1));
  const half = (length - 1) / 2;
  const cosine = Math.cos((2 * Math.PI * BUZCODE_TIME_BANDWIDTH) / length);
  let lowerBound = Number.POSITIVE_INFINITY;
  for (let index = 0; index < length; index += 1) {
    diagonal[index] = (half - index) ** 2 * cosine;
    const left = index > 0 ? offDiagonal[index - 1] : 0;
    if (index < length - 1) offDiagonal[index] = ((index + 1) * (length - index - 1)) / 2;
    const right = index < length - 1 ? offDiagonal[index] : 0;
    lowerBound = Math.min(lowerBound, diagonal[index] - Math.abs(left) - Math.abs(right));
  }
  const shift = -lowerBound + 1;
  let vectors = Array.from({ length: Math.min(BUZCODE_TAPER_COUNT, length) }, (_, column) => {
    const vector = new Float64Array(length);
    for (let index = 0; index < length; index += 1) {
      vector[index] = Math.sin((Math.PI * (column + 1) * (index + 1)) / (length + 1));
    }
    normalize(vector);
    return vector;
  });

  for (let iteration = 0; iteration < 96; iteration += 1) {
    const next = vectors.map((vector) => {
      const multiplied = new Float64Array(length);
      for (let index = 0; index < length; index += 1) {
        multiplied[index] = (diagonal[index] + shift) * vector[index]
          + (index > 0 ? offDiagonal[index - 1] * vector[index - 1] : 0)
          + (index < length - 1 ? offDiagonal[index] * vector[index + 1] : 0);
      }
      return multiplied;
    });
    orthonormalize(next);
    vectors = next;
  }
  for (const vector of vectors) {
    const firstMaterial = vector.find((value) => Math.abs(value) > 1e-12) ?? 1;
    if (firstMaterial < 0) vector.forEach((value, index) => { vector[index] = -value; });
  }
  taperCache.set(length, vectors);
  return vectors;
}

function fftRadix2(real: Float64Array, imaginary: Float64Array) {
  const length = real.length;
  for (let index = 1, reversed = 0; index < length; index += 1) {
    let bit = length >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index >= reversed) continue;
    [real[index], real[reversed]] = [real[reversed], real[index]];
    [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
  }
  for (let size = 2; size <= length; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let offset = 0; offset < length; offset += size) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let inner = 0; inner < size / 2; inner += 1) {
        const even = offset + inner;
        const odd = even + size / 2;
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
}

/** Exact 3 x 1024 Cooley-Tukey transform for Buzcode's 3072-point FFT. */
function fft3072(input: Float64Array, maximumBin: number) {
  const radixLength = BUZCODE_FFT_SIZE / 3;
  const real = Array.from({ length: 3 }, () => new Float64Array(radixLength));
  const imaginary = Array.from({ length: 3 }, () => new Float64Array(radixLength));
  for (let radix = 0; radix < 3; radix += 1) {
    for (let index = 0; index < radixLength; index += 1) {
      real[radix][index] = input[index * 3 + radix] ?? 0;
    }
    fftRadix2(real[radix], imaginary[radix]);
  }
  const outputReal = new Float64Array(maximumBin + 1);
  const outputImaginary = new Float64Array(maximumBin + 1);
  for (let bin = 0; bin <= maximumBin; bin += 1) {
    const radixBin = bin % radixLength;
    for (let radix = 0; radix < 3; radix += 1) {
      const angle = (-2 * Math.PI * bin * radix) / BUZCODE_FFT_SIZE;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      outputReal[bin] += real[radix][radixBin] * cosine - imaginary[radix][radixBin] * sine;
      outputImaginary[bin] += real[radix][radixBin] * sine + imaginary[radix][radixBin] * cosine;
    }
  }
  return { real: outputReal, imaginary: outputImaginary };
}

function rawFrequencyBins(sampleRate: number) {
  const nyquist = sampleRate / 2;
  const exclusiveMaximum = Math.min(BUZCODE_MAX_COMPUTED_FREQUENCY_HZ, nyquist);
  const maximumBin = Math.min(
    BUZCODE_FFT_SIZE / 2,
    Math.ceil((exclusiveMaximum * BUZCODE_FFT_SIZE) / sampleRate) - 1,
  );
  const bins: number[] = [];
  for (let bin = 1; bin <= maximumBin; bin += 1) {
    const frequency = (bin * sampleRate) / BUZCODE_FFT_SIZE;
    if (frequency > 0 && frequency < exclusiveMaximum) bins.push(bin);
  }
  return bins;
}

function buzcodeFrequencyGroups(sampleRate: number, rawBins: readonly number[]) {
  const betweenTwoAndFour = rawBins.reduce((count, bin) => {
    const frequency = (bin * sampleRate) / BUZCODE_FFT_SIZE;
    return count + (frequency >= 2 && frequency <= 4 ? 1 : 0);
  }, 0);
  const groupSize = Math.max(1, Math.round(betweenTwoAndFour / (2 / BUZCODE_FREQUENCY_RESOLUTION_HZ)));
  const groups: number[][] = [];
  for (let index = 0; index + groupSize < rawBins.length; index += groupSize) {
    groups.push(rawBins.slice(index, index + groupSize));
  }
  if (!groups.length && rawBins.length) groups.push([...rawBins]);
  return groups;
}

/**
 * Recreates TheStateEditor's signal path: AR(2) whitening, one-second
 * non-overlapping windows, NW=3/five-taper DPSS power, a 3072-point FFT,
 * 0-200 Hz computation, and approximately 0.5 Hz display grouping.
 */
export function computeSpectrogram(request: SpectrogramComputeRequest): SpectrogramComputeResult {
  validateRequest(request);
  const startedAt = nowMs();
  const { data, sampleRate } = request;
  const windowSize = Math.max(1, Math.round(sampleRate));
  const hop = windowSize;
  const frames = data.length < windowSize ? 1 : Math.floor((data.length - windowSize) / hop) + 1;
  const rawBins = rawFrequencyBins(sampleRate);
  const groups = buzcodeFrequencyGroups(sampleRate, rawBins);
  const frequencies = Float64Array.from(groups.map((group) => (
    group.reduce((sum, bin) => sum + (bin * sampleRate) / BUZCODE_FFT_SIZE, 0) / group.length
  )));
  const bins = frequencies.length;
  const powers = new Float64Array(bins * frames);
  powers.fill(Number.NaN);
  const times = Float64Array.from({ length: frames }, (_, frame) => (frame * hop + windowSize / 2) / sampleRate);
  const whitened = whitenAr2(data);
  const tapers = dpssTapers(windowSize);
  const maximumRawBin = rawBins.at(-1) ?? 0;
  let finiteFrames = 0;
  let dftTerms = 0;

  for (let frame = 0; frame < frames; frame += 1) {
    const frameOffset = frame * hop;
    const effectiveLength = Math.min(windowSize, BUZCODE_FFT_SIZE, Math.max(0, data.length - frameOffset));
    let finiteSamples = 0;
    for (let sample = 0; sample < effectiveLength; sample += 1) {
      if (Number.isFinite(whitened[frameOffset + sample])) finiteSamples += 1;
    }
    if (effectiveLength < 1 || finiteSamples / windowSize < 0.75) continue;
    finiteFrames += 1;
    const rawPower = new Float64Array(maximumRawBin + 1);
    const coverageGain = effectiveLength / finiteSamples;
    for (const taper of tapers) {
      const tapered = new Float64Array(BUZCODE_FFT_SIZE);
      for (let sample = 0; sample < effectiveLength; sample += 1) {
        const sourceValue = whitened[frameOffset + sample];
        if (!Number.isFinite(sourceValue)) continue;
        tapered[sample] = sourceValue * taper[sample] * coverageGain;
        dftTerms += 1;
      }
      const transformed = fft3072(tapered, maximumRawBin);
      for (const rawBin of rawBins) {
        const re = transformed.real[rawBin];
        const im = transformed.imaginary[rawBin];
        rawPower[rawBin] += (2 / BUZCODE_FFT_SIZE) * (re * re + im * im) / tapers.length;
      }
    }
    for (let groupedBin = 0; groupedBin < groups.length; groupedBin += 1) {
      const group = groups[groupedBin];
      let power = 0;
      for (const rawBin of group) power += rawPower[rawBin];
      powers[groupedBin * frames + frame] = power / group.length;
    }
  }

  return {
    powers,
    frequencies,
    times,
    frames,
    bins,
    maxHz: frequencies.at(-1) ?? 0,
    windowSize,
    hop,
    fftSize: BUZCODE_FFT_SIZE,
    tapers: tapers.length,
    metrics: {
      computeMs: Math.max(0, nowMs() - startedAt),
      inputSamples: data.length,
      finiteFrames,
      dftTerms,
    },
  };
}

function hanning(length: number) {
  if (length <= 1) return Float64Array.of(1);
  return Float64Array.from({ length }, (_, index) => (
    0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (length - 1))
  ));
}

function convolveTrimmed(values: Float64Array, window: Float64Array, normalize: boolean) {
  const result = new Float64Array(values.length);
  const frontTrim = Math.floor(window.length / 2);
  const divisor = normalize ? window.reduce((sum, value) => sum + value, 0) : 1;
  for (let output = 0; output < values.length; output += 1) {
    let sum = 0;
    let hasFinite = false;
    for (let windowIndex = 0; windowIndex < window.length; windowIndex += 1) {
      const sourceIndex = output + frontTrim - windowIndex;
      if (sourceIndex < 0 || sourceIndex >= values.length) continue;
      const value = values[sourceIndex];
      if (!Number.isFinite(value)) continue;
      sum += value * window[windowIndex];
      hasFinite = true;
    }
    result[output] = hasFinite && divisor > 0 ? sum / divisor : Number.NaN;
  }
  return result;
}

/** Applies TheStateEditor's selectable time smoothing, then log10 power. */
export function displaySpectrogramPowers(result: SpectrogramComputeResult, smoothingSeconds: number) {
  const displayed = new Float64Array(result.powers.length);
  const window = smoothingSeconds > 0 ? hanning(Math.max(1, Math.round(smoothingSeconds))) : null;
  for (let bin = 0; bin < result.bins; bin += 1) {
    const source = result.powers.slice(bin * result.frames, (bin + 1) * result.frames);
    const smoothed = window ? convolveTrimmed(source, window, true) : source;
    for (let frame = 0; frame < result.frames; frame += 1) {
      const value = smoothed[frame];
      displayed[bin * result.frames + frame] = Number.isFinite(value)
        ? Math.log10(Math.max(Number.EPSILON, value))
        : Number.NaN;
    }
  }
  return displayed;
}

function percentile(values: readonly number[], percentage: number) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return Number.NaN;
  const position = Math.max(0, Math.min(sorted.length - 1, (percentage / 100) * (sorted.length - 1)));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const ratio = position - lower;
  return sorted[lower] * (1 - ratio) + sorted[upper] * ratio;
}

/** Returns TheStateEditor's normalized 5-10 Hz / 0.5-4 Hz overlay. */
export function thetaRatioOverlay(result: SpectrogramComputeResult, smoothingSeconds: number) {
  const ratio = new Float64Array(result.frames);
  ratio.fill(Number.NaN);
  const thetaBins = [...result.frequencies].flatMap((frequency, index) => frequency >= 5 && frequency <= 10 ? [index] : []);
  const deltaBins = [...result.frequencies].flatMap((frequency, index) => frequency >= 0.5 && frequency <= 4 ? [index] : []);
  for (let frame = 0; frame < result.frames; frame += 1) {
    let theta = 0;
    let thetaCount = 0;
    let delta = 0;
    let deltaCount = 0;
    for (const bin of thetaBins) {
      const value = result.powers[bin * result.frames + frame];
      if (Number.isFinite(value)) { theta += value; thetaCount += 1; }
    }
    for (const bin of deltaBins) {
      const value = result.powers[bin * result.frames + frame];
      if (Number.isFinite(value)) { delta += value; deltaCount += 1; }
    }
    if (thetaCount && deltaCount && delta > 0) ratio[frame] = (theta / thetaCount) / (delta / deltaCount);
  }
  const smoothed = smoothingSeconds > 0
    ? convolveTrimmed(ratio, hanning(Math.max(1, Math.round(smoothingSeconds))), false)
    : ratio;
  const finite = [...smoothed].filter(Number.isFinite);
  const low = percentile(finite, 1);
  const high = percentile(finite, 99);
  const normalized = new Float64Array(smoothed.length);
  normalized.fill(Number.NaN);
  if (!Number.isFinite(low) || !Number.isFinite(high) || high === 0) return normalized;
  for (let index = 0; index < smoothed.length; index += 1) {
    if (Number.isFinite(smoothed[index])) normalized[index] = (smoothed[index] - low) / high;
  }
  return normalized;
}

export function spectrogramTransferList(result: SpectrogramComputeResult): Transferable[] {
  return [result.powers.buffer, result.frequencies.buffer, result.times.buffer];
}
