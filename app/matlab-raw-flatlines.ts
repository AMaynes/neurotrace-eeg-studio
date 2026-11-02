import type { MatlabDisplaySamples } from "./matlab-display-processing.ts";

/** Bounded tiles can scan contiguous channel memory and sweep integer events. */
export function detectMatlabTileFlatlines(data: readonly MatlabDisplaySamples[], sampleRate: number) {
  const count = data[0]?.length ?? 0;
  if (!data.length || !count) return [];
  const events = new Int32Array(count);
  for (const channel of data) {
    if (channel.length !== count) throw new Error("Flatline tile channels must be aligned.");
    let start = 0;
    for (let i = 1; i <= count; i++) {
      if (i < count && Number.isFinite(channel[i]) && channel[i] === channel[i - 1]) continue;
      const end = i - 1;
      if (Number.isFinite(channel[start]) && (end - start) / sampleRate >= 0.25) {
        events[start]++; events[end]--;
      }
      start = i;
    }
  }
  const required = Math.ceil(data.length * 0.8);
  const regions: { startSample: number; endSample: number }[] = [];
  let active = 0, start = -1;
  for (let i = 0; i < count; i++) {
    active += events[i];
    if (active >= required) { if (start < 0) start = i; }
    else if (start >= 0) {
      if ((i - start) / sampleRate >= 0.25) regions.push({ startSample: start, endSample: i });
      start = -1;
    }
  }
  return regions;
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

