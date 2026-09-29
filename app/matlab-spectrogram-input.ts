/** Input selection in seizure_annotation_tool_update.m, independent of display reduction. */
import { anatomicalChannelGroup, type RecordingMeta } from "./eeg-core.ts";

// anatomicalChannelGroup also accepts labels produced by display montages
// (LA1-2). MATLAB's ChannelMat source grouping accepts only raw contact names.
function sourceContactGroup(label: string) {
  return /^[A-Za-z]+\d+$/.test(label.trim()) ? anatomicalChannelGroup(label) : null;
}

export function matlabSpectrogramInputPlan(
  meta: Pick<RecordingMeta, "channelLabels" | "sampleRates" | "durationSec">,
  primarySourceIndex: number,
  viewStart: number,
  viewDuration: number,
  clickTime: number,
) {
  const sampleRate = meta.sampleRates[primarySourceIndex];
  if (!Number.isInteger(primarySourceIndex) || primarySourceIndex < 0 || primarySourceIndex >= meta.channelLabels.length
    || !Number.isFinite(sampleRate) || !(sampleRate > 0)
    || !Number.isFinite(meta.durationSec) || !(meta.durationSec > 0)
    || !Number.isFinite(viewStart) || viewStart < 0 || !Number.isFinite(viewDuration) || !(viewDuration > 0)
    || !Number.isFinite(clickTime)) return null;
  const group = sourceContactGroup(meta.channelLabels[primarySourceIndex]);
  const sourceIndices = group
    ? meta.channelLabels.flatMap((label, index) => sourceContactGroup(label) === group ? [index] : [])
    : [primarySourceIndex];
  if (sourceIndices.some((index) => meta.sampleRates[index] !== sampleRate)) {
    throw new Error("MATLAB group spectrogram requires equal source sample rates.");
  }
  const firstSourceSample = Math.floor(viewStart * sampleRate);
  // Metadata duration is commonly sampleCount / fs; recover that integer if
  // its round trip lands just below EOF. Do not apply this correction to the
  // requested seek/duration, whose literal floors match MATLAB LoadBinary.
  const sourceLength = meta.durationSec * sampleRate;
  const nearestSourceLength = Math.round(sourceLength);
  const sourceLengthTolerance = Math.min(1e-6, 4 * Number.EPSILON * Math.max(1, sourceLength));
  const sourceEnd = Math.abs(sourceLength - nearestSourceLength) <= sourceLengthTolerance
    ? nearestSourceLength : Math.floor(sourceLength);
  const count = Math.min(Math.floor(viewDuration * sampleRate), sourceEnd - firstSourceSample);
  if (!Number.isSafeInteger(firstSourceSample) || !Number.isSafeInteger(count) || count < 1) return null;
  const origin = viewStart + 1 / sampleRate;
  // MATLAB min(abs(ts - click)) chooses the first sample on an exact tie.
  const left = Math.max(0, Math.min(count - 1, Math.floor((clickTime - origin) * sampleRate)));
  const right = Math.min(count - 1, left + 1);
  const clickIndex = Math.abs(viewStart + (left + 1) / sampleRate - clickTime)
    <= Math.abs(viewStart + (right + 1) / sampleRate - clickTime) ? left : right;
  const halfWindow = Math.round(15 * sampleRate);
  const first = Math.max(0, clickIndex - halfWindow);
  const last = Math.min(count - 1, clickIndex + halfWindow);
  return {
    sourceIndices, sampleRate, sampleCount: last - first + 1,
    firstSourceSample: firstSourceSample + first,
    readStart: (firstSourceSample + first) / sampleRate,
    readDuration: (last - first + 1) / sampleRate,
    dataStart: viewStart + (first + 1) / sampleRate,
    baselineTime: viewStart + (clickIndex + 1) / sampleRate,
    label: group ? `${group} raw group (${sourceIndices.length})` : meta.channelLabels[primarySourceIndex],
  };
}
