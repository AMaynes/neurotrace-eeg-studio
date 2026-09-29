/**
 * Literal display processing from seizure_annotation_tool_update.m, lines
 * 353–367 and 541–558. This intentionally retains the reference's quirks:
 * cutoff 0.2 cycles/input sample (not the commented 100 Hz), window-relative
 * 2× sampling, causal zero initialization, and repeated causal end values.
 * No input sample, FIR accumulator, or filtered result is rounded to Float32.
 */

export type MatlabDisplaySamples = Float32Array | Float64Array;
export type MatlabDisplayFactor = 1 | 2;

export const MATLAB_DISPLAY_FIR_ORDER = 64;
export const MATLAB_DISPLAY_FIR_DELAY = MATLAB_DISPLAY_FIR_ORDER / 2;

export function designMatlabDisplayFir(): Float64Array {
  const coefficients = new Float64Array(MATLAB_DISPLAY_FIR_ORDER + 1);
  let sum = 0;
  for (let tap = 0; tap < coefficients.length; tap += 1) {
    const n = tap - MATLAB_DISPLAY_FIR_DELAY;
    const x = 2 * 0.2 * n;
    const ideal = x === 0 ? 2 * 0.2 : Math.sin(Math.PI * x) / (Math.PI * n);
    const window = 0.5 * (1 - Math.cos(2 * Math.PI * tap / MATLAB_DISPLAY_FIR_ORDER));
    coefficients[tap] = ideal * window;
    sum += coefficients[tap];
  }
  for (let tap = 0; tap < coefficients.length; tap += 1) coefficients[tap] /= sum;
  return coefficients;
}

const FIR_COEFFICIENTS = designMatlabDisplayFir();

function requireNonnegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
}

function requireFactor(factor: number): asserts factor is MatlabDisplayFactor {
  if (factor !== 1 && factor !== 2) throw new Error("MATLAB display factor must be 1 or 2.");
}

/** Positive pixel widths use the same rounding as MATLAB round(). */
export function matlabDisplayDecimationFactor(sampleCount: number, axisWidthPixels: number): MatlabDisplayFactor {
  requireNonnegativeInteger(sampleCount, "Input sample count");
  if (!Number.isFinite(axisWidthPixels) || axisWidthPixels < 0) {
    throw new Error("Axis width must be finite and non-negative.");
  }
  const nPixels = Math.max(Math.round(axisWidthPixels), 1000);
  return Math.min(2, Math.max(1, Math.floor(sampleCount / nPixels))) as MatlabDisplayFactor;
}

export interface MatlabDisplayChunkOptions {
  /** Length of the entire loaded MATLAB window, not this worker/read chunk. */
  inputSampleCount: number;
  factor: MatlabDisplayFactor;
  /** First supplied sample's index relative to the entire loaded window. */
  inputStartIndex?: number;
  /** First requested output's index within dPlot. */
  outputStartIndex?: number;
  outputSampleCount?: number;
}

function causalIndex(inputSampleCount: number, factor: MatlabDisplayFactor, outputIndex: number): number {
  const retainedInputIndex = outputIndex * factor;
  if (factor === 1 || MATLAB_DISPLAY_FIR_DELAY >= inputSampleCount) return retainedInputIndex;
  return Math.min(retainedInputIndex + MATLAB_DISPLAY_FIR_DELAY, inputSampleCount - 1);
}

/**
 * Exact source coverage needed for a chunk of dPlot. Read chunks may overlap by
 * up to 64 samples; boundaries remain relative to the full loaded window. This
 * permits bounded worker/file reads without resetting filter state, changing
 * the retained-sample parity, or applying the repeated tail at each chunk.
 */
export function matlabDisplayChunkInputRange(
  inputSampleCount: number,
  factor: MatlabDisplayFactor,
  outputStartIndex: number,
  outputSampleCount: number,
): { firstSample: number; endSample: number } {
  requireNonnegativeInteger(inputSampleCount, "Input sample count");
  requireFactor(factor);
  requireNonnegativeInteger(outputStartIndex, "Output start index");
  requireNonnegativeInteger(outputSampleCount, "Output sample count");
  if (outputStartIndex + outputSampleCount > Math.ceil(inputSampleCount / factor)) {
    throw new Error("Requested output chunk exceeds the loaded window.");
  }
  if (outputSampleCount === 0) {
    const firstSample = Math.min(inputSampleCount, outputStartIndex * factor);
    return { firstSample, endSample: firstSample };
  }
  const firstCausal = causalIndex(inputSampleCount, factor, outputStartIndex);
  const lastCausal = causalIndex(inputSampleCount, factor, outputStartIndex + outputSampleCount - 1);
  return {
    firstSample: Math.max(0, firstCausal - (factor === 2 ? MATLAB_DISPLAY_FIR_ORDER : 0)),
    endSample: lastCausal + 1,
  };
}

/**
 * Computes only retained outputs, in double precision, without allocating the
 * full causal or shifted intermediate arrays. Cost is at most 65 multiply-adds
 * per output, and additional memory is just this output chunk. Caller-owned
 * input is read-only. Run long requests in a terminable worker; this synchronous
 * pure function does not pretend to make main-thread cancellation responsive.
 */
export function filterMatlabDisplayChunk(
  input: MatlabDisplaySamples,
  options: MatlabDisplayChunkOptions,
): MatlabDisplaySamples {
  const { inputSampleCount, factor } = options;
  const inputStartIndex = options.inputStartIndex ?? 0;
  const outputStartIndex = options.outputStartIndex ?? 0;
  const outputSampleCount = options.outputSampleCount ?? Math.ceil(inputSampleCount / factor) - outputStartIndex;
  requireNonnegativeInteger(inputStartIndex, "Input start index");
  const range = matlabDisplayChunkInputRange(inputSampleCount, factor, outputStartIndex, outputSampleCount);
  if (inputStartIndex + input.length > inputSampleCount
    || (outputSampleCount > 0 && (inputStartIndex > range.firstSample || inputStartIndex + input.length < range.endSample))) {
    throw new Error("Supplied input does not cover the MATLAB output chunk's source range.");
  }
  if (factor === 1) {
    const first = range.firstSample - inputStartIndex;
    return first === 0 && outputSampleCount === input.length
      ? input
      : input.subarray(first, first + outputSampleCount);
  }
  const output = new Float64Array(outputSampleCount);
  let previousCausalIndex = -1;
  let value = 0;
  for (let index = 0; index < output.length; index += 1) {
    const sourceIndex = causalIndex(inputSampleCount, factor, outputStartIndex + index);
    if (sourceIndex !== previousCausalIndex) {
      value = 0;
      const lastTap = Math.min(MATLAB_DISPLAY_FIR_ORDER, sourceIndex);
      for (let tap = 0; tap <= lastTap; tap += 1) {
        value += FIR_COEFFICIENTS[tap] * input[sourceIndex - tap - inputStartIndex];
      }
      previousCausalIndex = sourceIndex;
    }
    output[index] = value;
  }
  return output;
}

/** Factor 1 is a value-preserving, zero-copy identity; factor 2 returns doubles. */
export function filterMatlabDisplayTrace(input: MatlabDisplaySamples, factor: MatlabDisplayFactor): MatlabDisplaySamples {
  return filterMatlabDisplayChunk(input, { inputSampleCount: input.length, factor });
}

export interface MatlabDisplayTrace {
  data: MatlabDisplaySamples;
  factor: MatlabDisplayFactor;
  sampleRate: number;
  /** First retained sample's absolute source index, before the time-axis offset. */
  outputStartSampleIndex: number;
  /** MATLAB ts_EEG starts at 1/fs, even when dPlot is downsampled by two. */
  sampleTimeOffsetSec: number;
  compensatedGroupDelaySamples: number;
}

export function processMatlabDisplayTrace(
  input: MatlabDisplaySamples,
  sampleRate: number,
  axisWidthPixels: number,
  sourceStartSampleIndex = 0,
): MatlabDisplayTrace {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("Source sample rate must be positive and finite.");
  requireNonnegativeInteger(sourceStartSampleIndex, "Source start sample index");
  const factor = matlabDisplayDecimationFactor(input.length, axisWidthPixels);
  return {
    data: filterMatlabDisplayTrace(input, factor),
    factor,
    sampleRate: sampleRate / factor,
    // Do not align to the global even-sample grid: MATLAB retains d(1:2:end).
    outputStartSampleIndex: sourceStartSampleIndex,
    sampleTimeOffsetSec: 1 / sampleRate,
    compensatedGroupDelaySamples: factor === 2 && MATLAB_DISPLAY_FIR_DELAY < input.length ? MATLAB_DISPLAY_FIR_DELAY : 0,
  };
}
