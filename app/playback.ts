type PlaybackCoverage = {
  viewStart: number;
  viewDuration?: number;
  processingThroughSec?: number;
  unreadAfterSec?: number;
};

/** Check only recorded time; a centered viewport may extend beyond either file edge. */
export function playbackWindowReady(coverage: PlaybackCoverage | undefined, startSec: number, windowSec: number, durationSec: number) {
  if (!coverage || coverage.viewDuration === undefined) return false;
  const endSec = Math.min(coverage.viewStart + coverage.viewDuration,
    coverage.processingThroughSec ?? Infinity, coverage.unreadAfterSec ?? Infinity);
  return coverage.viewStart <= Math.max(0, startSec) + 1e-9
    && endSec >= Math.min(durationSec, startSec + windowSec) - 1e-9;
}

/** Scroll beneath a centered playhead, prefetching ahead before the current buffer runs out. */
export function nextPlaybackStep(timeSec: number, windowSec: number, durationSec: number,
  coverage: PlaybackCoverage | undefined, elapsedSec: number) {
  const nextTimeSec = Math.min(durationSec, timeSec + Math.max(0, Math.min(0.1, elapsedSec)));
  const ready = playbackWindowReady(coverage, nextTimeSec - windowSec / 2, windowSec, durationSec);
  const time = ready ? nextTimeSec : timeSec;
  const viewStartSec = time - windowSec / 2;
  // Small windows still need enough lead to absorb file/worker latency. Large
  // windows add at most five seconds, keeping the extra decoding bounded.
  const leadSec = Math.max(0.5, Math.min(5, windowSec / 2));
  const coveredEndSec = coverage ? coverage.viewStart + (coverage.viewDuration ?? 0) : 0;
  const request = !ready || (coveredEndSec < durationSec && coveredEndSec - (viewStartSec + windowSec) < leadSec / 2)
    ? { startSec: Math.max(0, viewStartSec), durationSec: Math.min(durationSec - Math.max(0, viewStartSec), windowSec + leadSec) }
    : undefined;
  return { timeSec: time, viewStartSec: playbackWindowReady(coverage, viewStartSec, windowSec, durationSec) ? viewStartSec : undefined,
    request, buffering: !ready, finished: ready && time >= durationSec };
}
