/**
 * Emits original samples for a canvas path without zoom-dependent filtering.
 * Each occupied pixel retains its first/last samples and both extrema in time
 * order. Finite runs remain separate across gaps; inputs are never modified.
 */
export function visitWaveformPeakSamples(
  values: ArrayLike<number>,
  firstIndex: number,
  endIndex: number,
  xForIndex: (index: number) => number,
  emit: (index: number, value: number, beginsRun: boolean) => void,
) {
  let first = -1;
  let last = -1;
  let minimum = -1;
  let maximum = -1;
  let pixel = 0;
  let beginsRun = true;
  const flush = () => {
    if (first < 0) return;
    emit(first, values[first], beginsRun);
    beginsRun = false;
    const early = Math.min(minimum, maximum);
    const late = Math.max(minimum, maximum);
    if (early > first && early < last) emit(early, values[early], false);
    if (late > early && late > first && late < last) emit(late, values[late], false);
    if (last > first) emit(last, values[last], false);
    first = -1;
  };
  for (let index = Math.max(0, firstIndex); index < Math.min(values.length, endIndex); index += 1) {
    if (!Number.isFinite(values[index])) {
      flush();
      beginsRun = true;
      continue;
    }
    const nextPixel = Math.floor(xForIndex(index));
    if (first >= 0 && pixel !== nextPixel) flush();
    if (first < 0) {
      first = minimum = maximum = index;
      pixel = nextPixel;
    }
    last = index;
    if (values[index] < values[minimum]) minimum = index;
    if (values[index] > values[maximum]) maximum = index;
  }
  flush();
}
