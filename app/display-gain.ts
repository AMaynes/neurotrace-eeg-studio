/** Display-only gain limits, shared by controls, tutorials, and restored views. */
export const MIN_DISPLAY_GAIN = 0.01;
export const MAX_DISPLAY_GAIN = 4;

/** Non-finite input retains a valid fallback; old saved gains fit the current range. */
export function normalizeDisplayGain(value: number, fallback = 1): number {
  const finiteValue = Number.isFinite(value) ? value : Number.isFinite(fallback) ? fallback : 1;
  return Math.max(MIN_DISPLAY_GAIN, Math.min(MAX_DISPLAY_GAIN, finiteValue));
}

/** Keep the existing 25% buttons, with at least one hundredth of movement near 0.01×. */
export function stepDisplayGain(value: number, direction: 1 | -1): number {
  const current = normalizeDisplayGain(value);
  const proportional = direction === 1 ? current * 1.25 : current / 1.25;
  const next = current + direction * Math.max(0.01, Math.abs(proportional - current));
  return normalizeDisplayGain(Number(next.toFixed(2)));
}
