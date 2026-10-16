import type { NormalizedVerticalViewport } from "./waveform-viewport";

export type SpectrogramFrequencyRange = { min: number; max: number };

/** Display-only state: restoring a zoom must never restore or overwrite annotations. */
export type ZoomView = {
  viewStart: number;
  timebase: number;
  gain: number;
  verticalViewport: NormalizedVerticalViewport | null;
  expandedChannels: boolean;
  channelScrollTop: number;
  frequencyRange: SpectrogramFrequencyRange;
};

/** One atomic zoom, including both time and vertical/frequency axes for a box gesture. */
export type ZoomHistoryEntry = { kind: "zoom"; before: ZoomView; after: ZoomView };
/** Ephemeral grouping state, reset on undo/redo, session switch, and recording replacement. */
export type ZoomGestureState = { entry?: ZoomHistoryEntry; group?: string; lastAt?: number };

/** Exact equality avoids adding history for a control already at its limit. */
export function sameZoomView(a: ZoomView, b: ZoomView): boolean {
  return a.viewStart === b.viewStart && a.timebase === b.timebase && a.gain === b.gain
    && a.verticalViewport?.top === b.verticalViewport?.top && a.verticalViewport?.bottom === b.verticalViewport?.bottom
    && a.expandedChannels === b.expandedChannels && a.channelScrollTop === b.channelScrollTop
    && a.frequencyRange.min === b.frequencyRange.min && a.frequencyRange.max === b.frequencyRange.max;
}

/**
 * Mutates the existing chronological stacks, retaining at most 100 undo entries.
 * Adjacent wheel frames within 300ms share one entry; edits/pans break the group.
 * No-op zooms leave redo intact. Returns whether the caller should apply the view.
 */
export function recordZoomChange<T extends { kind?: "annotation" }>(
  undo: Array<T | ZoomHistoryEntry>,
  redo: Array<T | ZoomHistoryEntry>,
  before: ZoomView,
  after: ZoomView,
  gesture: ZoomGestureState,
  group?: string,
  now = performance.now(),
): boolean {
  if (sameZoomView(before, after)) return false;
  const last = undo.at(-1);
  if (group && group === gesture.group && last === gesture.entry && last?.kind === "zoom"
    && now - (gesture.lastAt ?? -Infinity) <= 300 && sameZoomView(last.after, before)) {
    last.after = after;
  } else {
    const entry: ZoomHistoryEntry = { kind: "zoom", before, after };
    undo.push(entry);
    if (undo.length > 100) undo.shift();
    gesture.entry = entry;
  }
  gesture.group = group;
  gesture.lastAt = now;
  redo.length = 0;
  return true;
}
