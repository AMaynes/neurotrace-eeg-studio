/*
Purpose: Serializes and reads recording labels in the MATLAB-compatible CSV layout.
File Dependencies: app/matlab-annotations-csv.ts.
*/


import { csvCell, parseCsvRecords } from "./matlab-annotations-csv.ts";

interface ExportedLabel {
  id: string;
  labelId: string;
  start: number;
  end: number;
  track: string;
  confidence: number;
  status: string;
  origin: string;
  reviewer: string;
  notes: string;
  updatedAt: string;
  candidateId?: string;
  recordingLabel?: { label: string };
  sourceLabel?: string;
}

export type RecordingFileReference = { name: string; path: string; size: number };
export type CsvRecording<T = Record<string, unknown>> = {
  recording: string;
  annotations: readonly T[];
  reviewer?: string;
  format?: string;
  reviewSessionId?: number;
  sourcePath?: string;
  files?: RecordingFileReference[];
  candidates?: readonly unknown[];
  recordingLabelsImported?: boolean;
  interpretation?: Record<string, unknown> | null;
};

/** Classifies exported label provenance as reviewer, detected, or legacy. */
function labelSource(annotation: ExportedLabel): "detected" | "reviewer" | "legacy" {
  if (annotation.origin === "manual") return "reviewer";
  if (annotation.origin === "imported" && annotation.candidateId && !annotation.recordingLabel) return "reviewer";
  if (annotation.recordingLabel || annotation.origin === "imported" || annotation.origin === "detector") return "detected";
  return "legacy";
}

/** Store the real absolute path when exposed by a host, otherwise the browser's relative path. */
export function recordingSourcePath(file: File, interpretation?: Record<string, unknown> | null) {
  const absolute = (file as File & { path?: string }).path;
  if (absolute && !/fakepath/i.test(absolute)) return absolute;
  if (/\.dat$/i.test(file.name) && typeof interpretation?.data_dir_hint === "string"
    && /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(interpretation.data_dir_hint)) {
    return `${interpretation.data_dir_hint.replace(/[\\/]$/, "")}/${file.name}`;
  }
  if (/\.mat$/i.test(file.name) && typeof interpretation?.companion_mat_path === "string"
    && /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(interpretation.companion_mat_path)) return interpretation.companion_mat_path;
  return file.webkitRelativePath || file.name;
}

/** Metadata rows allow a CSV to retain recording references even before any labels exist. */
export function serializeRecordingLabels<T extends ExportedLabel>(
  recordings: readonly CsvRecording<T>[],
  labelName: (annotation: T) => string,
  includeRecordingReferences = false,
): string {
  const header = "recording,annotation_id,label,label_type,start_sec,end_sec,track,confidence_pct,status,origin,label_source,reviewer,notes,updated_at,row_type,source_path,source_files,recording_format,review_session_id,annotation_json,candidates_json,source_interpretation,recording_labels_imported";
  const records = recordings.flatMap((recording) => {
    const references = [recording.sourcePath || recording.recording, JSON.stringify(recording.files ?? []),
      recording.format ?? "", recording.reviewSessionId ?? ""];
    const metadata = includeRecordingReferences ? [[recording.recording, "", "", "", "", "", "", "", "", "", "",
      recording.reviewer ?? "", "", "", "recording", ...references, "",
      JSON.stringify(recording.candidates ?? []), JSON.stringify(recording.interpretation ?? null), recording.recordingLabelsImported ? "1" : "0"]] : [];
    const labels = recording.annotations.map((item) => [
      recording.recording, item.id, typeof item.sourceLabel === "string" ? item.sourceLabel : labelName(item), item.labelId,
      item.start, item.end, item.track, item.confidence, item.status, item.origin, labelSource(item),
      item.reviewer || (labelSource(item) === "reviewer" ? recording.reviewer ?? "" : ""), item.notes, item.updatedAt,
      "annotation", ...references, JSON.stringify({ ...item,
        reviewer: item.reviewer || (labelSource(item) === "reviewer" ? recording.reviewer ?? "" : "") }), "", "", "",
    ]);
    return [...metadata, ...labels];
  });
  return [header, ...records.map((values) => values.map(csvCell).join(",")), ""].join("\r\n");
}

/** Recognizes a non-null object that is not an array. */
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Import only data. Normal recording-bound validation runs again before annotations are applied. */
export function parseRecordingLabelsCsv(text: string): { recordings: CsvRecording[]; reviewer: string; reviewSessionId: number } {
  if (text.length > 64 * 1024 * 1024) throw new Error("The annotation CSV exceeds 64 MiB.");
  const records = parseCsvRecords(text);
  const columns = records.shift();
  if (!columns || !["recording", "annotation_id", "label_type", "start_sec", "end_sec", "label_source"].every((name) => columns.includes(name))) {
    throw new Error("Choose an all-labels annotation CSV exported by this app.");
  }
  const recordings = new Map<string, CsvRecording>();
  let reviewer = "", reviewSessionId = 1;
  for (const values of records) {
    if (values.length !== columns.length) throw new Error("The annotation CSV contains an incomplete row.");
    const row = Object.fromEntries(columns.map((name, index) => [name, values[index]]));
    if (!row.recording) throw new Error("A CSV row has no recording reference.");
    const pass = Number(row.review_session_id || 1);
    if (!Number.isSafeInteger(pass) || pass < 1) throw new Error("The CSV review session number is invalid.");
    const entry = recordings.get(row.recording) ?? {
      recording: row.recording, annotations: [], reviewer: row.reviewer, sourcePath: row.source_path || row.recording,
      format: row.recording_format, reviewSessionId: pass,
    };
    if (row.source_files) {
      const files: unknown = JSON.parse(row.source_files);
      if (!Array.isArray(files) || !files.every((file) => object(file) && typeof file.name === "string"
        && typeof file.path === "string" && Number.isSafeInteger(file.size) && Number(file.size) >= 0)) {
        throw new Error("The CSV recording references are invalid.");
      }
      entry.files = files;
    }
    if (row.row_type === "recording") {
      entry.recordingLabelsImported = row.recording_labels_imported === "1";
      if (row.candidates_json) {
        const candidates: unknown = JSON.parse(row.candidates_json);
        if (!Array.isArray(candidates)) throw new Error("The CSV event reviews are invalid.");
        entry.candidates = candidates;
      }
      if (row.source_interpretation) {
        const interpretation: unknown = JSON.parse(row.source_interpretation);
        if (interpretation !== null && !object(interpretation)) throw new Error("The CSV recording layout is invalid.");
        entry.interpretation = interpretation;
      }
    } else if (row.annotation_id) {
      const annotation: unknown = row.annotation_json ? JSON.parse(row.annotation_json) : {
        id: row.annotation_id, labelId: row.label_type, start: Number(row.start_sec), end: Number(row.end_sec),
        geometry: Number(row.start_sec) === Number(row.end_sec) ? "point" : "interval", track: row.track,
        confidence: Number(row.confidence_pct), status: row.status, origin: row.origin, reviewer: row.reviewer,
        notes: row.notes, updatedAt: row.updated_at, createdAt: row.updated_at, channels: [],
      };
      if (!object(annotation) || annotation.id !== row.annotation_id || annotation.labelId !== row.label_type
        || !Number.isFinite(annotation.start) || !Number.isFinite(annotation.end)) throw new Error("A CSV annotation is invalid.");
      entry.annotations = [...entry.annotations, annotation];
    }
    recordings.set(row.recording, entry);
    if (row.reviewer) reviewer ||= row.reviewer;
    reviewSessionId = Math.max(reviewSessionId, pass);
  }
  return { recordings: [...recordings.values()], reviewer, reviewSessionId };
}
