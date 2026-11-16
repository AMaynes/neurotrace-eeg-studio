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
}

/** Export the current recording's labels regardless of display filters or review status. */
export function serializeRecordingLabels<T extends ExportedLabel>(
  recording: string,
  annotations: readonly T[],
  labelName: (annotation: T) => string,
): string {
  const header = "recording,annotation_id,label,label_type,start_sec,end_sec,track,confidence_pct,status,origin,reviewer,notes,updated_at";
  const rows = annotations.map((item) => [
    recording, item.id, labelName(item), item.labelId, item.start, item.end, item.track, item.confidence,
    item.status, item.origin, item.reviewer, item.notes, item.updatedAt,
  ].map(csvCell).join(","));
  return [header, ...rows, ""].join("\r\n");
}
