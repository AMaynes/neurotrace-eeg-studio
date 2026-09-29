/** Input selection in seizure_annotation_tool_update.m, independent of display reduction. */
import { anatomicalChannelGroup, type RecordingMeta } from "./eeg-core.ts";

export function matlabSpectrogramInputPlan(
  meta: Pick<RecordingMeta, "channelLabels" | "sampleRates" | "durationSec">,
  primarySourceIndex: number,
  viewStart: number,
  viewDuration: number,
  clickTime: number,
) {
  const sampleRate = meta.sampleRates[primarySourceIndex];
  if (!(sampleRate > 0)) return null;
  const group = anatomicalChannelGroup(meta.channelLabels[primarySourceIndex] ?? "");
  const sourceIndices = group
    ? meta.channelLabels.flatMap((label, index) => anatomicalChannelGroup(label) === group ? [index] : [])
    : [primarySourceIndex];
  if (sourceIndices.some((index) => meta.sampleRates[index] !== sampleRate)) {
    throw new Error("MATLAB group spectrogram requires equal source sample rates.");
  }
  const firstSourceSample = Math.floor(viewStart * sampleRate);
  const count = Math.min(Math.floor(viewDuration * sampleRate), Math.floor(meta.durationSec * sampleRate) - firstSourceSample);
  if (count < 1) return null;
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
