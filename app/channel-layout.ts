/** Shared electrode row geometry for waveform drawing, channel labels, and hit testing. */

import { anatomicalChannelGroup, orderElectrodeChannelIndices } from "./eeg-core.ts";

// MATLAB adds GROUP_SPACING = CH_SPACING * 4 after each group's last row increment.
export const ELECTRODE_GROUP_GAP_ROWS = 4;

/** Preserve MATLAB's case-sensitive group identity, including our CAR display suffix. */
export function matlabDisplayGroup(label: string): string | null {
  return anatomicalChannelGroup(label.replace(/ \(CAR\)$/, ""));
}

/** Same side partition and stable first-occurrence groups as MATLAB chOffsets_pre. */
export function matlabDisplayOrder(labels: readonly string[]): number[] {
  const groups = new Map<string, number[]>();
  labels.forEach((label, index) => {
    const group = matlabDisplayGroup(label);
    if (!group) return;
    const rows = groups.get(group) ?? [];
    rows.push(index);
    groups.set(group, rows);
  });
  // MATLAB's unclassified fallback displays all channels without anatomical spacing.
  if (!groups.size) return labels.map((_, index) => index);
  const side = (group: string) => group[0].toUpperCase() === "L" ? 0 : group[0].toUpperCase() === "R" ? 1 : 2;
  return [...groups].sort(([a], [b]) => side(a) - side(b)).flatMap(([, rows]) => rows);
}

export type ChannelRowLayout = {
  rowStartUnits: number[];
  /** Integer CSS grid lines; fractional spacing is represented by separate tracks. */
  rowGridLines: number[];
  gridTemplateRows: string;
  totalUnits: number;
  groupStarts: Set<number>;
  groups: Array<{ name: string; startRow: number; endRow: number }>;
  contactLabels: string[];
};

/** Builds matching fractional waveform coordinates and valid integer CSS grid placements. */
export function buildChannelRowLayout(labels: readonly string[], electrodeSpacing: boolean): ChannelRowLayout {
  const rowStartUnits: number[] = [];
  const rowGridLines: number[] = [];
  const tracks: string[] = [];
  const groupStarts = new Set<number>();
  const groups: ChannelRowLayout["groups"] = [];
  const contactLabels: string[] = [];
  let units = 0;
  let previousGroup: string | null = null;
  labels.forEach((label, index) => {
    const group = electrodeSpacing ? matlabDisplayGroup(label) : null;
    if (index > 0 && group !== previousGroup && (group || previousGroup)) {
      tracks.push(`${ELECTRODE_GROUP_GAP_ROWS}fr`);
      units += ELECTRODE_GROUP_GAP_ROWS;
      groupStarts.add(index);
    }
    rowGridLines.push(tracks.length + 1);
    tracks.push("1fr");
    rowStartUnits.push(units);
    units += 1;
    if (group) {
      if (group !== previousGroup || !groups.length) groups.push({ name: group, startRow: index, endRow: index });
      const block = groups[groups.length - 1];
      block.endRow = index;
      // MATLAB's referential labels are ordinals within the visible group; bipolar labels use the pair.
      const pair = /^(?:[A-Za-z]+)(\d+-\d+)$/.exec(label.trim());
      contactLabels.push(pair?.[1] ?? String(index - block.startRow + 1));
    } else contactLabels.push(label);
    previousGroup = group;
  });
  return { rowStartUnits, rowGridLines, gridTemplateRows: tracks.join(" ") || "1fr", totalUnits: Math.max(1, units), groupStarts, groups, contactLabels };
}

/** Gap hits deliberately resolve to no channel, so annotations cannot target a separator. */
export function channelRowFromFraction(layout: ChannelRowLayout, fraction: number): number | null {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) return null;
  const unit = fraction * layout.totalUnits;
  const row = layout.rowStartUnits.findIndex((start) => unit >= start && unit < start + 1);
  return row >= 0 ? row : null;
}

type ElectrodeDisplayRows = {
  labels: string[];
  data: (Float32Array | Float64Array)[];
  traceBaselines: number[];
  envelopes: unknown[];
  sampleRates: number[];
  sourceSampleRates: number[];
  sourceStartSampleIndices?: (number | null)[];
  startSecs: number[];
  units: string[];
  sourceIndices: number[][];
  primarySourceIndices: number[];
};

/** Reorders complete display rows together, preserving samples, calibration, timing, and provenance. */
export function orderElectrodeDisplayRows<T extends ElectrodeDisplayRows>(display: T): T {
  return reorderDisplayRows(display, orderElectrodeChannelIndices(display.labels));
}

/** Display-only grouping: never derive pairs, change a sample, or mutate the source selection. */
export function orderMatlabDisplayRows<T extends ElectrodeDisplayRows>(display: T): T {
  return reorderDisplayRows(display, matlabDisplayOrder(display.labels));
}

function reorderDisplayRows<T extends ElectrodeDisplayRows>(display: T, order: number[]): T {
  const reorder = <V>(values: V[]): V[] => {
    if (values.length !== display.labels.length) throw new Error("Display channel metadata does not match the waveform row count.");
    return order.map((index) => values[index]);
  };
  return {
    ...display,
    labels: reorder(display.labels),
    data: reorder(display.data),
    traceBaselines: reorder(display.traceBaselines),
    envelopes: reorder(display.envelopes),
    sampleRates: reorder(display.sampleRates),
    sourceSampleRates: reorder(display.sourceSampleRates),
    ...(display.sourceStartSampleIndices ? { sourceStartSampleIndices: reorder(display.sourceStartSampleIndices) } : {}),
    startSecs: reorder(display.startSecs),
    units: reorder(display.units),
    sourceIndices: reorder(display.sourceIndices),
    primarySourceIndices: reorder(display.primarySourceIndices),
  };
}

/** Keep cursor, inspection, and spectrogram attached to the same complete derivation. */
export function remapDisplayFocus(previous: Pick<ElectrodeDisplayRows, "labels" | "sourceIndices">, next: Pick<ElectrodeDisplayRows, "labels" | "sourceIndices">, row: number): number {
  const sources = previous.sourceIndices[row];
  if (!sources) return -1;
  return next.labels.findIndex((label, index) => label === previous.labels[row]
    && next.sourceIndices[index].length === sources.length
    && next.sourceIndices[index].every((source, position) => source === sources[position]));
}
