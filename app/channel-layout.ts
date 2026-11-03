/** Shared electrode row geometry for waveform drawing, channel labels, and hit testing. */

import { anatomicalChannelGroup, orderElectrodeChannelIndices } from "./eeg-core.ts";

// Minimum gap; spare viewport space is shared equally by all gaps, including the edges.
export const ELECTRODE_GROUP_GAP_ROWS = 0.5;
export type ChannelGroupingMode = "matlab" | "name";

/** Parse display names only; source labels and montage pairing remain unchanged. */
function namedChannel(label: string): { group: string; contact: string } {
  const plain = label.trim().replace(/\s+\(CAR\)$/i, "")
    .replace(/^(?:EEG|SEEG|ECOG|IEEG|POL)[\s:_-]+/i, "");
  const core = plain.replace(/[-_\s]+(?:REF|LE|AR|AVG|CAR)$/i, "").trim();
  const suffix = plain.slice(core.length);
  const pair = /^([A-Za-z]+)[ _]*(\d+)\s*-\s*(?:([A-Za-z]+)[ _]*)?(\d+)$/.exec(core);
  if (pair) {
    const first = pair[1].toUpperCase(), second = (pair[3] ?? pair[1]).toUpperCase();
    return { group: first === second ? first : `${first}-${second}`, contact: `${pair[2]}-${pair[4]}${suffix}` };
  }
  const contact = /^([A-Za-z]+)[ _-]*(\d+)$/.exec(core)
    ?? /^(Fp|AF|F|FC|FT|C|CP|T|TP|P|PO|O|A|M)(z)$/i.exec(core);
  if (contact) return { group: contact[1].toUpperCase(), contact: `${contact[2]}${suffix}` };
  // Unnumbered/unknown names remain explicit groups, never silently hidden.
  return { group: core.toUpperCase() || "Other", contact: plain || label || "Unnamed" };
}

export function channelNameGroup(label: string): string {
  return namedChannel(label).group;
}

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

/** Name groups retain first-occurrence group order and acquisition order within each group. */
export function channelGroupOrder(labels: readonly string[], mode: ChannelGroupingMode): number[] {
  if (mode === "matlab") return matlabDisplayOrder(labels);
  const groups = new Map<string, number[]>();
  labels.forEach((label, index) => {
    const group = channelNameGroup(label);
    const rows = groups.get(group) ?? [];
    rows.push(index);
    groups.set(group, rows);
  });
  return [...groups.values()].flat();
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

/** Number of complete/fractional channel rows before a position; gaps contribute nothing. */
function occupiedRows(position: number, starts: readonly number[], rowSize: number): number {
  let low = 0, high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= position) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  return low - 1 + Math.min(1, Math.max(0, (position - starts[low - 1]) / rowSize));
}

/** One geometry for drawing, labels, scrolling, hit tests, and box zoom. */
export function channelPlotGeometry(
  layout: ChannelRowLayout,
  plotHeight: number,
  expanded: boolean,
  viewport: { top: number; bottom: number } | null = null,
) {
  const availableHeight = Math.max(1, plotHeight);
  const unitStart = expanded ? 0 : (viewport?.top ?? 0) * layout.totalUnits;
  const unitSpan = expanded ? layout.totalUnits
    : Math.max(Number.EPSILON, ((viewport?.bottom ?? 1) - (viewport?.top ?? 0)) * layout.totalUnits);
  const grouped = layout.groups.length > 0;
  // Keep contacts compact and distribute spare space between whole groups.
  // Explicit box zoom instead fills its selected range of canonical row units.
  const rowHeight = expanded ? (grouped ? 24 : 60)
    : Math.min(availableHeight / unitSpan, grouped && !viewport ? 18 : Infinity);
  if (grouped && (expanded || !viewport)) {
    const rowCount = layout.rowStartUnits.length;
    const gapUnits = layout.totalUnits - rowCount;
    const gapScale = Math.max(rowHeight, (availableHeight - rowCount * rowHeight) / gapUnits);
    let rowTops: number[] | undefined;
    return {
      rowHeight,
      contentHeight: rowCount * rowHeight + gapUnits * gapScale,
      yForUnit(unit: number) {
        const rows = occupiedRows(unit, layout.rowStartUnits, 1);
        return rows * rowHeight + (unit - rows) * gapScale;
      },
      unitForY(y: number) {
        rowTops ??= layout.rowStartUnits.map((start, row) => row * rowHeight + (start - row) * gapScale);
        const rows = occupiedRows(y, rowTops, rowHeight);
        return rows + (y - rows * rowHeight) / gapScale;
      },
    };
  }
  return {
    rowHeight,
    contentHeight: Math.max(availableHeight, layout.totalUnits * rowHeight),
    yForUnit: (unit: number) => (unit - unitStart) * rowHeight,
    unitForY: (y: number) => unitStart + y / rowHeight,
  };
}

/** Shared channel spacing with fixed gaps between groups, regardless of contact count. */
export function buildChannelRowLayout(labels: readonly string[], electrodeSpacing: boolean, mode: ChannelGroupingMode = "matlab"): ChannelRowLayout {
  const rowStartUnits: number[] = [];
  const rowGridLines: number[] = [];
  const tracks: string[] = [];
  const groupStarts = new Set<number>();
  const groups: ChannelRowLayout["groups"] = [];
  const contactLabels: string[] = [];
  const blocks: Array<{ name: string | null; startRow: number; endRow: number }> = [];
  labels.forEach((label, index) => {
    const name = electrodeSpacing ? mode === "name" ? channelNameGroup(label) : matlabDisplayGroup(label) : null;
    const previous = blocks.at(-1);
    if (previous && previous.name === name) previous.endRow = index;
    else blocks.push({ name, startRow: index, endRow: index });
  });
  const grouped = blocks.some((block) => block.name !== null);
  let units = 0;
  const padding = (size: number) => {
    if (size <= 0) return;
    tracks.push(`${size}fr`);
    units += size;
  };
  for (const block of blocks) {
    // Adjacent half-gaps form a full gap; the outer edges each get a full gap too.
    const edgePadding = grouped ? ELECTRODE_GROUP_GAP_ROWS / 2 : 0;
    padding(block.startRow === 0 ? edgePadding * 2 : edgePadding);
    if (grouped && block.startRow > 0) groupStarts.add(block.startRow);
    if (block.name) groups.push({ name: block.name, startRow: block.startRow, endRow: block.endRow });
    for (let index = block.startRow; index <= block.endRow; index++) {
      rowGridLines.push(tracks.length + 1);
      tracks.push("1fr");
      rowStartUnits.push(units);
      units += 1;
      // MATLAB's referential labels are ordinals; bipolar labels retain the pair.
      const pair = /^(?:[A-Za-z]+)(\d+-\d+)$/.exec(labels[index].trim());
      contactLabels.push(block.name ? mode === "name" ? namedChannel(labels[index]).contact
        : pair?.[1] ?? String(index - block.startRow + 1) : labels[index]);
    }
    padding(block.endRow === labels.length - 1 ? edgePadding * 2 : edgePadding);
  }
  return { rowStartUnits, rowGridLines, gridTemplateRows: tracks.join(" ") || "1fr", totalUnits: Math.max(1, units), groupStarts, groups, contactLabels };
}

/** Gap hits deliberately resolve to no channel, so annotations cannot target a separator. */
export function channelRowFromFraction(layout: ChannelRowLayout, fraction: number): number | null {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) return null;
  const unit = fraction * layout.totalUnits;
  const epsilon = Number.EPSILON * Math.max(1, layout.totalUnits) * 4;
  const row = layout.rowStartUnits.findIndex((start) => unit >= start - epsilon && unit < start + 1 - epsilon);
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

export function orderGroupedDisplayRows<T extends ElectrodeDisplayRows>(display: T, mode: ChannelGroupingMode): T {
  return reorderDisplayRows(display, channelGroupOrder(display.labels, mode));
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
