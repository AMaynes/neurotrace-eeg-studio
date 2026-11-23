/** Keep already published source bins visible while missing blocks are prepared. */
type Envelope = { startSec: number; bucketDurationSec: number; minima: Float32Array | Float64Array;
  maxima: Float32Array | Float64Array; gaps: Uint8Array; variation?: Float32Array };
type Waveform = {
  settingsKey?: string;
  recordingAnchored?: boolean;
  data: (Float32Array | Float64Array)[];
  labels: string[];
  units: string[];
  sourceIndices: number[][];
  primarySourceIndices: number[];
  startSecs: number[];
  sampleRates: number[];
  traceBaselines: number[];
  envelopes: (Envelope | null)[];
};

/** Only identical source/settings/grids can reuse values. No interpolation or rescaling. */
export function retainDisplayOverlap<T extends Waveform>(next: T, previous: Waveform | undefined): T {
  if (!previous?.recordingAnchored || !next.recordingAnchored || !next.settingsKey
    || next.settingsKey !== previous.settingsKey) return next;
  const identity = (window: Waveform, row: number) => JSON.stringify([
    window.labels[row], window.units[row], window.primarySourceIndices[row], window.sourceIndices[row],
  ]);
  const oldRows = new Map(previous.data.map((_, row) => [identity(previous, row), row]));
  const data = [...next.data], envelopes = [...next.envelopes], baselines = [...next.traceBaselines];
  let changed = false;
  for (let row = 0; row < data.length; row++) {
    const oldRow = oldRows.get(identity(next, row));
    if (oldRow === undefined) continue;
    const oldEnvelope = previous.envelopes[oldRow], newEnvelope = next.envelopes[row];
    if (Boolean(oldEnvelope) !== Boolean(newEnvelope)) continue;
    const interval = newEnvelope?.bucketDurationSec ?? 1 / next.sampleRates[row];
    const oldInterval = oldEnvelope?.bucketDurationSec ?? 1 / previous.sampleRates[oldRow];
    if (!(interval > 0) || Math.abs(interval - oldInterval) > interval * 1e-10) continue;
    const start = newEnvelope?.startSec ?? next.startSecs[row];
    const oldStart = oldEnvelope?.startSec ?? previous.startSecs[oldRow];
    const shift = (start - oldStart) / interval, offset = Math.round(shift);
    const tolerance = Number.EPSILON * 64 * Math.max(1, Math.abs(start / interval), Math.abs(oldStart / interval));
    if (!Number.isSafeInteger(offset) || Math.abs(shift - offset) > tolerance) continue;
    const from = Math.max(0, -offset), to = Math.min(data[row].length, previous.data[oldRow].length - offset);
    if (to <= from) continue;
    const values = data[row].slice();
    const envelope = newEnvelope ? { ...newEnvelope, minima: newEnvelope.minima.slice(), maxima: newEnvelope.maxima.slice(),
      gaps: newEnvelope.gaps.slice(), variation: newEnvelope.variation?.slice() } : null;
    let copied = false;
    for (let i = from; i < to; i++) {
      const oldIndex = i + offset, value = previous.data[oldRow][oldIndex];
      // NaN in the previous frame may mean an unread block, not a recorded gap.
      if (!Number.isFinite(value)) continue;
      values[i] = value; copied = true;
      if (envelope && oldEnvelope) {
        envelope.minima[i] = oldEnvelope.minima[oldIndex]; envelope.maxima[i] = oldEnvelope.maxima[oldIndex];
        envelope.gaps[i] = oldEnvelope.gaps[oldIndex];
        if (envelope.variation && oldEnvelope.variation) envelope.variation[i] = oldEnvelope.variation[oldIndex];
      }
    }
    if (copied) {
      data[row] = values; envelopes[row] = envelope; baselines[row] = previous.traceBaselines[oldRow]; changed = true;
    }
  }
  return changed ? { ...next, data, envelopes, traceBaselines: baselines } : next;
}
