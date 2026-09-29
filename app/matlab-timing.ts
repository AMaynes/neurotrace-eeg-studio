/** MATLAB ts_EEG = (1:N)/Fs + requested window start; decimation retains 1, 1+D, … . */
function validateMatlabTimeGrid(requestedStartSec: number, sourceRate: number, decimationFactor: number) {
  if (!Number.isFinite(requestedStartSec)) throw new RangeError("MATLAB window start must be finite.");
  if (!(sourceRate > 0) || !Number.isFinite(sourceRate)) throw new RangeError("MATLAB source rate must be positive and finite.");
  if (!Number.isSafeInteger(decimationFactor) || decimationFactor < 1) {
    throw new RangeError("MATLAB decimation factor must be a positive safe integer.");
  }
}

/** First retained sample is at start + 1/Fs, even when start is off the source grid. */
export function matlabSampleTime(
  requestedStartSec: number,
  sourceRate: number,
  displaySampleIndex: number,
  decimationFactor = 1,
): number {
  validateMatlabTimeGrid(requestedStartSec, sourceRate, decimationFactor);
  if (!Number.isSafeInteger(displaySampleIndex) || displaySampleIndex < 0) {
    throw new RangeError("MATLAB display sample index must be a non-negative safe integer.");
  }
  const retainedSampleNumber = 1 + displaySampleIndex * decimationFactor;
  const time = requestedStartSec + retainedSampleNumber / sourceRate;
  if (!Number.isSafeInteger(retainedSampleNumber) || !Number.isFinite(time)) {
    throw new RangeError("MATLAB sample time exceeds the representable grid.");
  }
  return time;
}

/**
 * Snap to the MATLAB plotting grid, not the absolute zero-origin source grid.
 * Pass factor 1 to snap at source resolution, or the displayed decimation factor
 * to snap only to retained samples. The grid extends both ways; callers own
 * recording/window bounds and availability checks.
 */
export function matlabSampleSnap(
  timeSec: number,
  requestedStartSec: number,
  sourceRate: number,
  decimationFactor = 1,
): number {
  validateMatlabTimeGrid(requestedStartSec, sourceRate, decimationFactor);
  if (!Number.isFinite(timeSec)) throw new RangeError("MATLAB snap time must be finite.");
  const origin = requestedStartSec + 1 / sourceRate;
  const index = Math.round((timeSec - origin) * sourceRate / decimationFactor);
  const result = origin + index * decimationFactor / sourceRate;
  if (!Number.isSafeInteger(index) || !Number.isFinite(result)) {
    throw new RangeError("MATLAB snap time exceeds the representable grid.");
  }
  return result;
}
