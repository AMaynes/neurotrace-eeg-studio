/**
 * Recording-supplied labels remain evidence, not automatically accepted review
 * decisions. This module owns timing validation, stable import identities, and
 * lossless source provenance for the MAT/EDF import and annotation recovery paths.
 */

export interface RecordingLabel {
  id: string;
  label: string;
  timeSec: number;
  durationSec: number;
  source: "mat" | "edf+";
  channels: string[];
  notes: string;
}

interface MatEventTimes {
  groupIndex: number;
  label: string;
  dimensions: readonly number[];
  count: number;
  valueAt: (index: number) => number;
  epochAt?: (index: number) => number;
  channelsAt?: (index: number) => string[];
  notesAt?: (index: number) => string;
}

/**
 * Brainstorm sFile.events uses 1×N point times or 2×N start/end columns, in
 * seconds (https://neuroimage.usc.edu/brainstorm/Tutorials/EventMarkers).
 * Epoch-local times beyond epoch 1 cannot be mapped onto a flat DAT safely.
 * Malformed occurrences are reported, never clamped into plausible events.
 */
export function decodeMatRecordingLabels(input: MatEventTimes) {
  const labels: RecordingLabel[] = [];
  const warnings: string[] = [];
  if (!input.count) return { labels, warnings };
  const [rows, columns] = input.dimensions;
  if (![1, 2].includes(rows) || !Number.isSafeInteger(columns) || columns < 0
    || input.dimensions.slice(2).some((value) => value !== 1) || rows * columns !== input.count) {
    return { labels, warnings: [`Event group ${input.groupIndex + 1} has unsupported time dimensions; expected 1×N markers or 2×N intervals.`] };
  }
  let invalid = 0;
  let unmappedEpochs = 0;
  for (let occurrence = 0; occurrence < columns; occurrence += 1) {
    if (input.epochAt && input.epochAt(occurrence) !== 1) { unmappedEpochs += 1; continue; }
    const start = input.valueAt(occurrence * rows);
    const end = rows === 2 ? input.valueAt(occurrence * rows + 1) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || !input.label.trim()) {
      invalid += 1;
      continue;
    }
    labels.push({
      id: `mat-label-${input.groupIndex}-${occurrence}`,
      label: input.label, timeSec: start, durationSec: end - start, source: "mat",
      channels: input.channelsAt?.(occurrence) ?? [], notes: input.notesAt?.(occurrence) ?? "",
    });
  }
  if (invalid) warnings.push(`Skipped ${invalid} invalid occurrence(s) in event group ${input.groupIndex + 1}.`);
  if (unmappedEpochs) warnings.push(`Skipped ${unmappedEpochs} occurrence(s) in event group ${input.groupIndex + 1} with unmapped epoch timing.`);
  return { labels, warnings };
}

/** EDF annotation identity depends on content, not filtered queue position. */
export function edfRecordingLabels(events: readonly { label: string; timeSec: number; durationSec?: number }[]): RecordingLabel[] {
  const occurrences = new Map<string, number>();
  return events.map((event) => {
    const key = JSON.stringify([event.timeSec, event.durationSec ?? 0, event.label]);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    return { ...event, durationSec: event.durationSec ?? 0, source: "edf+", channels: [], notes: "",
      id: `edf-label-${key}-${occurrence}` };
  });
}

/** Validate source provenance when restoring an untrusted local/project record. */
export function validRecordingLabel(value: unknown): value is RecordingLabel {
  if (!value || typeof value !== "object") return false;
  const label = value as RecordingLabel;
  return typeof label.id === "string" && Boolean(label.id)
    && typeof label.label === "string" && Boolean(label.label.trim())
    && Number.isFinite(label.timeSec) && label.timeSec >= 0
    && Number.isFinite(label.durationSec) && label.durationSec >= 0
    && Number.isFinite(label.timeSec + label.durationSec)
    && (label.source === "mat" || label.source === "edf+")
    && Array.isArray(label.channels) && label.channels.every((name) => typeof name === "string")
    && typeof label.notes === "string";
}

/**
 * Import exact source text as neutral, unreviewed labels. Duplicate channel
 * names are intentionally not resolved to an arbitrary contact. Out-of-file
 * intervals are clipped for display only; original times stay in provenance.
 */
export function recordingLabelAnnotations(labels: readonly RecordingLabel[], durationSec: number, channelNames: readonly string[], timestamp = new Date().toISOString()) {
  const lookup = new Map<string, number[]>();
  channelNames.forEach((name, index) => {
    const key = name.trim().toLowerCase();
    lookup.set(key, [...(lookup.get(key) ?? []), index]);
  });
  let outside = 0;
  let invalid = 0;
  let unresolvedChannels = 0;
  const seen = new Set<string>();
  const annotations = labels.flatMap((label) => {
    if (!validRecordingLabel(label) || !Number.isFinite(durationSec) || !(durationSec > 0)) { invalid += 1; return []; }
    if (seen.has(label.id)) return [];
    seen.add(label.id);
    if (label.timeSec >= durationSec) { outside += 1; return []; }
    const end = Math.min(durationSec, label.timeSec + label.durationSec);
    const channels = label.channels.flatMap((name) => {
      const indices = lookup.get(name.trim().toLowerCase());
      if (indices?.length === 1) return indices;
      unresolvedChannels += 1;
      return [];
    });
    return [{
      id: `recording-${label.id}`, labelId: "recording-label", start: label.timeSec, end,
      geometry: end > label.timeSec ? "interval" as const : "point" as const,
      track: "instance" as const, channels: [...new Set(channels)],
      confidence: 0, reliability: "gray" as const, origin: "imported" as const,
      reviewer: "", notes: label.notes, status: "suggestion" as const,
      recordingLabel: { ...label, channels: [...label.channels] },
      revision: 1, createdAt: timestamp, updatedAt: timestamp,
    }];
  });
  const warnings: string[] = [];
  if (invalid) warnings.push(`${invalid} invalid recording label(s) were not imported.`);
  if (outside) warnings.push(`${outside} recording label(s) were outside the recording and were not imported.`);
  if (unresolvedChannels) warnings.push(`${unresolvedChannels} recording-label channel reference(s) could not be mapped uniquely; original names remain in label details.`);
  return { annotations, warnings };
}

/** Existing edits win; repeated imports never duplicate a recording label. */
export function mergeRecordingLabels<T extends { id: string }>(restored: readonly T[], detected: readonly T[], alreadyImported = false): T[] {
  if (alreadyImported) return [...restored];
  const ids = new Set(restored.map((entry) => entry.id));
  return [...restored, ...detected.filter((entry) => {
    if (ids.has(entry.id)) return false;
    ids.add(entry.id);
    return true;
  })];
}
