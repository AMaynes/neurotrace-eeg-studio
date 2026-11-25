/*
Purpose: Emits waveform endpoints and extrema in time order for each screen column.
File Dependencies: None.
*/


/** Emits each finite run through per-pixel endpoints and extrema without reordering samples. */
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
  /** Emits the current pixel column endpoints and extrema in sample order. */
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
