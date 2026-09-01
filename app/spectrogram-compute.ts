/** Pure spectrogram computation shared by the browser worker and focused tests. */

export const SPECTROGRAM_BIN_COUNT = 56;
export const SPECTROGRAM_MAX_FRAME_COUNT = 90;
export const SPECTROGRAM_MAX_FREQUENCY_HZ = 150;

export interface SpectrogramComputeRequest {
  data: Float32Array;
  sampleRate: number;
}

export interface SpectrogramComputeMetrics {
  /** Time spent on the worker's signal math, excluding worker startup and drawing. */
  computeMs: number;
  inputSamples: number;
  finiteFrames: number;
  /** Number of finite sample/bin terms considered by the DFT loops. */
  dftTerms: number;
  /** Populated by the browser client after the transferable input copy is made. */
  inputCopyMs?: number;
  /** Populated by the browser client when the worker response arrives. */
  workerRoundTripMs?: number;
}

export interface SpectrogramComputeResult {
  /** Bin-major log10 powers: `powers[bin * frames + frame]`. */
  powers: Float64Array;
  frames: number;
  bins: number;
  maxHz: number;
  windowSize: number;
  hop: number;
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

/**
 * Reproduces the viewer's existing Hann-windowed, log-spaced DFT exactly, but
 * stores its small result in one transferable bin-major typed array.
 */
export function computeSpectrogram(request: SpectrogramComputeRequest): SpectrogramComputeResult {
  validateRequest(request);
  const startedAt = nowMs();
  const { data, sampleRate } = request;
  const nominalWindowSize = Math.min(256, 2 ** Math.floor(Math.log2(Math.max(32, sampleRate))));
  const windowSize = Math.max(1, Math.min(data.length, nominalWindowSize));
  const targetHop = Math.max(1, Math.floor(windowSize / 4));
  const possibleFrames = Math.max(1, Math.floor((data.length - windowSize) / targetHop) + 1);
  const frames = Math.min(SPECTROGRAM_MAX_FRAME_COUNT, possibleFrames);
  const hop = frames > 1
    ? Math.max(1, Math.floor((data.length - windowSize) / (frames - 1)))
    : 1;
  const maxHz = Math.min(SPECTROGRAM_MAX_FREQUENCY_HZ, sampleRate / 2);
  const bins = SPECTROGRAM_BIN_COUNT;
  const powers = new Float64Array(bins * frames);
  powers.fill(Number.NaN);
  let finiteFrames = 0;
  let dftTerms = 0;

  for (let frame = 0; frame < frames; frame += 1) {
    const offset = Math.min(Math.max(0, data.length - windowSize), frame * hop);
    let finiteSamples = 0;
    let mean = 0;
    for (let sample = 0; sample < windowSize; sample += 1) {
      const value = data[offset + sample];
      if (!Number.isFinite(value)) continue;
      mean += value;
      finiteSamples += 1;
    }
    if (finiteSamples / windowSize < 0.75) continue;
    finiteFrames += 1;
    mean /= finiteSamples;
    const coverageGain = windowSize / finiteSamples;
    for (let bin = 0; bin < bins; bin += 1) {
      const frequency = Math.exp(Math.log(1) + (bin / (bins - 1)) * Math.log(Math.max(1.01, maxHz)));
      let re = 0;
      let im = 0;
      for (let sample = 0; sample < windowSize; sample += 1) {
        const sourceValue = data[offset + sample];
        if (!Number.isFinite(sourceValue)) continue;
        const value = sourceValue - mean;
        const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * sample) / Math.max(1, windowSize - 1));
        const angle = (2 * Math.PI * frequency * sample) / sampleRate;
        re += value * hann * Math.cos(angle);
        im -= value * hann * Math.sin(angle);
        dftTerms += 1;
      }
      re *= coverageGain;
      im *= coverageGain;
      powers[bin * frames + frame] = Math.log10(re * re + im * im + 1e-9);
    }
  }

  return {
    powers,
    frames,
    bins,
    maxHz,
    windowSize,
    hop,
    metrics: {
      computeMs: Math.max(0, nowMs() - startedAt),
      inputSamples: data.length,
      finiteFrames,
      dftTerms,
    },
  };
}

export function spectrogramTransferList(result: SpectrogramComputeResult): Transferable[] {
  return [result.powers.buffer];
}
