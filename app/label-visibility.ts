/** Display-only label identities; file wording is independent of the shared import label ID. */
export interface LabelTypeAnnotation {
  labelId: string;
  recordingLabel?: { label: string };
}

export interface LabelTypeOption {
  key: string;
  name: string;
  source: "recording" | "annotation";
  count: number;
}

/** File annotations and their source-event queue entries share one visibility choice. */
export function recordingLabelTypeKey(name: string): string {
  return `recording:${name.trim().toLowerCase()}`;
}

export function annotationLabelTypeKey(annotation: LabelTypeAnnotation): string {
  return annotation.labelId === "recording-label" && annotation.recordingLabel
    ? recordingLabelTypeKey(annotation.recordingLabel.label)
    : `annotation:${annotation.labelId}`;
}

/** Count available types without modifying or dropping any saved annotation. */
export function collectLabelTypes(
  annotations: readonly LabelTypeAnnotation[],
  candidates: readonly { label: string }[],
  definitions: readonly { id: string; name: string; hidden?: boolean }[],
): LabelTypeOption[] {
  const names = new Map(definitions.map((label) => [label.id, label.name]));
  const types = new Map<string, LabelTypeOption>();
  for (const label of definitions) {
    if (!label.hidden && label.id !== "recording-label") {
      types.set(`annotation:${label.id}`, { key: `annotation:${label.id}`, name: label.name, source: "annotation", count: 0 });
    }
  }
  const add = (key: string, name: string, source: LabelTypeOption["source"]) => {
    const type = types.get(key);
    if (type) type.count += 1;
    else types.set(key, { key, name, source, count: 1 });
  };
  for (const annotation of annotations) {
    const fileLabel = annotation.labelId === "recording-label" ? annotation.recordingLabel?.label : undefined;
    add(annotationLabelTypeKey(annotation), fileLabel?.trim() || names.get(annotation.labelId) || annotation.labelId,
      fileLabel !== undefined ? "recording" : "annotation");
  }
  for (const candidate of candidates) add(recordingLabelTypeKey(candidate.label), candidate.label.trim(), "recording");
  return [...types.values()].sort((a, b) =>
    (a.source === b.source ? 0 : a.source === "recording" ? -1 : 1) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}
