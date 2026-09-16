/** Shared electrode row geometry for waveform drawing, channel labels, and hit testing. */

import { displayElectrodeGroup, orderElectrodeChannelIndices } from "./eeg-core.ts";

export const ELECTRODE_GROUP_GAP_ROWS = 0.12;

export type ChannelRowLayout = {
  rowStartUnits: number[];
  /** Integer CSS grid lines; fractional spacing is represented by separate tracks. */
  rowGridLines: number[];
  gridTemplateRows: string;
  totalUnits: number;
  groupStarts: Set<number>;
};

/** Builds matching fractional waveform coordinates and valid integer CSS grid placements. */
export function buildChannelRowLayout(labels: readonly string[], electrodeSpacing: boolean): ChannelRowLayout {
  const rowStartUnits: number[] = [];
  const rowGridLines: number[] = [];
  const tracks: string[] = [];
  const groupStarts = new Set<number>();
  let units = 0;
  let previousGroup: string | null = null;
  labels.forEach((label, index) => {
    const group = electrodeSpacing ? displayElectrodeGroup(label) : null;
    if (index > 0 && group !== previousGroup && (group || previousGroup)) {
      tracks.push(`${ELECTRODE_GROUP_GAP_ROWS}fr`);
      units += ELECTRODE_GROUP_GAP_ROWS;
      groupStarts.add(index);
    }
    rowGridLines.push(tracks.length + 1);
    tracks.push("1fr");
    rowStartUnits.push(units);
    units += 1;
    previousGroup = group;
  });
  return { rowStartUnits, rowGridLines, gridTemplateRows: tracks.join(" ") || "1fr", totalUnits: Math.max(1, units), groupStarts };
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
  data: Float32Array[];
  traceBaselines: number[];
  envelopes: unknown[];
  sampleRates: number[];
  sourceSampleRates: number[];
  startSecs: number[];
  units: string[];
  sourceIndices: number[][];
  primarySourceIndices: number[];
};

/** Reorders complete display rows together, preserving samples, calibration, timing, and provenance. */
export function orderElectrodeDisplayRows<T extends ElectrodeDisplayRows>(display: T): T {
  const order = orderElectrodeChannelIndices(display.labels);
  const reorder = <V>(values: V[]): V[] => {
    if (values.length !== order.length) throw new Error("Display channel metadata does not match the waveform row count.");
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
    startSecs: reorder(display.startSecs),
    units: reorder(display.units),
    sourceIndices: reorder(display.sourceIndices),
    primarySourceIndices: reorder(display.primarySourceIndices),
  };
}
