/** Pure fixed-bin density clustering for wide annotation timelines. */

export interface TimelineDensityAnnotation<TTrack extends string = string> {
  id: string;
  track: TTrack;
  start: number;
  end: number;
}

export interface TimelineDensityRange {
  start: number;
  end: number;
}

export interface TimelineDensityBin<TTrack extends string = string> {
  track: TTrack;
  start: number;
  end: number;
  /** Unique annotations on this track whose visible coverage touches the bin. */
  count: number;
}

type TrackAccumulator = {
  delta: Float64Array;
  seenIds: Set<string>;
};

/**
 * Reduces visible point and interval annotations to at most `maxBinsPerTrack`
 * occupied bins per track. An interval contributes to every bin it intersects;
 * a point contributes to its containing bin. Returned bin bounds cover the
 * complete fixed cell, making their visual coverage a conservative superset of
 * the source annotations while never extending outside the requested range.
 *
 * Counting uses a difference-array sweep, so long intervals remain O(1) each
 * rather than touching every output cell during ingestion.
 */
export function clusterTimelineDensity<TTrack extends string>(
  annotations: readonly TimelineDensityAnnotation<TTrack>[],
  visibleRange: TimelineDensityRange,
  maxBinsPerTrack: number,
): TimelineDensityBin<TTrack>[] {
  if (!Number.isFinite(visibleRange.start)
    || !Number.isFinite(visibleRange.end)
    || visibleRange.end <= visibleRange.start
    || !Number.isFinite(maxBinsPerTrack)
    || maxBinsPerTrack < 1) return [];

  const binCount = Math.max(1, Math.floor(maxBinsPerTrack));
  const duration = visibleRange.end - visibleRange.start;
  const binDuration = duration / binCount;
  const tracks = new Map<TTrack, TrackAccumulator>();

  const binForPoint = (time: number) => Math.min(
    binCount - 1,
    Math.max(0, Math.floor((time - visibleRange.start) / binDuration)),
  );

  for (const annotation of annotations) {
    if (!annotation.id || !Number.isFinite(annotation.start) || !Number.isFinite(annotation.end)) continue;
    const sourceStart = Math.min(annotation.start, annotation.end);
    const sourceEnd = Math.max(annotation.start, annotation.end);
    const point = sourceStart === sourceEnd;
    if (point) {
      // Boundary points are retained conservatively in the nearest visible bin.
      if (sourceStart < visibleRange.start || sourceStart > visibleRange.end) continue;
    } else if (sourceEnd <= visibleRange.start || sourceStart >= visibleRange.end) {
      continue;
    }

    let accumulator = tracks.get(annotation.track);
    if (!accumulator) {
      accumulator = {
        delta: new Float64Array(binCount + 1),
        seenIds: new Set<string>(),
      };
      tracks.set(annotation.track, accumulator);
    }
    // Duplicate records with the same track/id describe one annotation.
    if (accumulator.seenIds.has(annotation.id)) continue;
    accumulator.seenIds.add(annotation.id);

    let firstBin: number;
    let lastBin: number;
    if (point) {
      firstBin = binForPoint(sourceStart);
      lastBin = firstBin;
    } else {
      const clippedStart = Math.max(sourceStart, visibleRange.start);
      const clippedEnd = Math.min(sourceEnd, visibleRange.end);
      firstBin = binForPoint(clippedStart);
      // Intervals are half-open. An end exactly on a cell boundary does not
      // claim the following cell, while a crossing interval claims both.
      lastBin = Math.min(
        binCount - 1,
        Math.max(firstBin, Math.ceil((clippedEnd - visibleRange.start) / binDuration) - 1),
      );
    }
    accumulator.delta[firstBin] += 1;
    accumulator.delta[lastBin + 1] -= 1;
  }

  const output: TimelineDensityBin<TTrack>[] = [];
  for (const [track, accumulator] of tracks) {
    let count = 0;
    for (let index = 0; index < binCount; index += 1) {
      count += accumulator.delta[index];
      if (count <= 0) continue;
      output.push({
        track,
        start: visibleRange.start + index * binDuration,
        end: index === binCount - 1
          ? visibleRange.end
          : visibleRange.start + (index + 1) * binDuration,
        count,
      });
    }
  }
  return output;
}
