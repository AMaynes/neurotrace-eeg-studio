import { csvCell } from "./matlab-annotations-csv.ts";

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

function labelSource(annotation: ExportedLabel): "detected" | "reviewer" | "legacy" {
  if (annotation.origin === "manual") return "reviewer";
  // Accepted marks restored from a MATLAB CSV were authored by a reviewer.
  if (annotation.origin === "imported" && annotation.candidateId && !annotation.recordingLabel) return "reviewer";
  if (annotation.recordingLabel || annotation.origin === "imported" || annotation.origin === "detector") return "detected";
  return "legacy";
}

/** Export all annotation rows, including when there are no rows yet. */
export function serializeRecordingLabels<T extends ExportedLabel>(
  recordings: readonly { recording: string; annotations: readonly T[] }[],
  labelName: (annotation: T) => string,
): string {
  const header = "recording,annotation_id,label,label_type,start_sec,end_sec,track,confidence_pct,status,origin,label_source,reviewer,notes,updated_at";
  const rows = recordings.flatMap(({ recording, annotations }) => annotations.map((item) => [
    recording, item.id, typeof item.sourceLabel === "string" ? item.sourceLabel : labelName(item), item.labelId, item.start, item.end, item.track, item.confidence,
    item.status, item.origin, labelSource(item), item.reviewer, item.notes, item.updatedAt,
  ].map(csvCell).join(",")));
  return [header, ...rows, ""].join("\r\n");
}
