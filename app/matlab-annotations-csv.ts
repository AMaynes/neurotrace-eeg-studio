/** The savedT/newRow contract in seizure_annotation_tool_update.m (lines 314–327, 929–947).
 * No extra columns, skipped decisions, display settings, or waveform data.
 */
export const MATLAB_ANNOTATION_COLUMNS = [
  "mat_path", "data_dir", "dat_file", "event_label", "event_time_original_sec",
  "onset_offset_sec", "onset_time_adjusted_sec", "offset_offset_sec", "offset_time_adjusted_sec",
  "sampling_rate", "n_channels", "bad_channels", "review_timestamp", "accepted",
] as const;

export type MatlabAnnotationRow = Record<typeof MATLAB_ANNOTATION_COLUMNS[number], string | number>;

type ReviewInput = {
  meta: { name: string; sampleRates: number[]; channelLabels: string[] };
  sourceInterpretation: Record<string, unknown> | null;
  sourcePath?: string;
  candidates: { id: string; time: number; label: string; status: string; badChannels?: string; reviewedAt?: string }[];
  annotations: { candidateId?: string; labelId: string; status: string; start: number; end: number; updatedAt: string }[];
};

export function formatMatlabTimestamp(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** writetable uses long g (15 significant digits for doubles), not fixed-six decimals.
 * https://www.mathworks.com/help/matlab/ref/writetable.html
 */
export function matlabCsvNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("CSV contains a non-finite numeric value.");
  if (value === 0) return "0";
  const [mantissa, exponentText] = value.toExponential(14).split("e");
  const exponent = Number(exponentText);
  const trim = (text: string) => text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
  if (exponent < -4 || exponent >= 15) {
    return `${trim(mantissa)}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  return trim(Number(value.toPrecision(15)).toFixed(Math.max(0, 14 - exponent)));
}

export function matlabAnnotationRows(input: ReviewInput): MatlabAnnotationRow[] {
  const { meta, candidates, annotations } = input;
  const field = (key: string) => typeof input.sourceInterpretation?.[key] === "string"
    ? input.sourceInterpretation[key] as string : "";
  const sourcePath = input.sourcePath || meta.name;
  const matPath = field("companion_mat_path") || field("companion_mat_name")
    || (/\.mat$/i.test(sourcePath) ? sourcePath : "");
  const directory = field("data_dir_hint") || sourcePath.replace(/[^/\\]+$/, "").replace(/[/\\]$/, "");
  const dataFile = field("dat_file_base") || meta.name.replace(/\.(dat|mat|edf)$/i, "");
  const rate = meta.sampleRates[0];
  const uniformRate = meta.sampleRates.length > 0 && meta.sampleRates.every((item) => item === rate);
  const rows: MatlabAnnotationRow[] = [];
  const committed = new Map<string, ReviewInput["annotations"][number]>();
  for (const annotation of annotations) {
    if (annotation.candidateId && annotation.labelId === "ictal" && annotation.status === "committed") {
      committed.set(annotation.candidateId, annotation);
    }
  }
  for (const candidate of candidates) {
    if (candidate.status !== "reviewed") continue;
    const annotation = committed.get(candidate.id);
    if (!annotation) continue;
    rows.push({
      mat_path: matPath,
      data_dir: directory,
      dat_file: dataFile,
      event_label: candidate.label,
      event_time_original_sec: candidate.time,
      onset_offset_sec: annotation.start - candidate.time,
      onset_time_adjusted_sec: annotation.start,
      offset_offset_sec: annotation.end - candidate.time,
      offset_time_adjusted_sec: annotation.end,
      // MATLAB writes source fs and nCh, never the decimated rate or montage row count.
      sampling_rate: uniformRate ? rate : "",
      n_channels: meta.channelLabels.length,
      bad_channels: (candidate.badChannels ?? "").trim(),
      review_timestamp: formatMatlabTimestamp(candidate.reviewedAt ?? annotation.updatedAt),
      accepted: 1,
    });
  }
  return rows;
}

function csvCell(value: string | number): string {
  const text = typeof value === "number" ? matlabCsvNumber(value) : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function validateRow(row: MatlabAnnotationRow): void {
  for (const key of MATLAB_ANNOTATION_COLUMNS.slice(4, 11)) {
    if (row[key] === "" || !Number.isFinite(Number(row[key]))) {
      throw new Error(`Cannot save ${row.dat_file}: ${key} is missing or invalid. MATLAB CSV requires one source sampling rate for every channel.`);
    }
  }
  if (Number(row.accepted) !== 1 || Number(row.sampling_rate) <= 0
    || !Number.isInteger(Number(row.n_channels)) || Number(row.n_channels) < 1
    || Number(row.offset_time_adjusted_sec) <= Number(row.onset_time_adjusted_sec)
    || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(row.review_timestamp))) {
    throw new Error(`Cannot save ${row.dat_file}: the accepted review is incomplete.`);
  }
}

function eventKey(row: MatlabAnnotationRow): string {
  // Same six-decimal event identity as MATLAB upsertSavedRow. No rounding of stored marks.
  // Standalone/EDF sources lack a MAT path, so retain their distinct file identities.
  return JSON.stringify([row.mat_path || [row.data_dir, row.dat_file], Number(row.event_time_original_sec).toFixed(6)]);
}

export function mergeMatlabAnnotationRows(previous: MatlabAnnotationRow[], current: MatlabAnnotationRow[]): MatlabAnnotationRow[] {
  const rows = new Map<string, MatlabAnnotationRow>();
  for (const row of [...previous, ...current]) {
    validateRow(row);
    rows.set(eventKey(row), row);
  }
  return [...rows.values()];
}

export function serializeMatlabAnnotations(rows: MatlabAnnotationRow[]): string {
  const lines = [MATLAB_ANNOTATION_COLUMNS.join(",")];
  for (const row of mergeMatlabAnnotationRows([], rows)) lines.push(MATLAB_ANNOTATION_COLUMNS.map((key) => csvCell(row[key])).join(","));
  // Windows MATLAB CSV convention, UTF-8 without a BOM, including final newline.
  return `${lines.join("\r\n")}\r\n`;
}

/** Strict parsing protects an existing CSV before a save replaces its contents. */
export function parseMatlabAnnotations(text: string): MatlabAnnotationRow[] {
  if (!text.trim()) return [];
  const records: string[][] = [];
  let record: string[] = [], cell = "", quoted = false, closed = false;
  const finishCell = () => { record.push(cell); cell = ""; closed = false; };
  const finishRecord = () => { finishCell(); records.push(record); record = []; };
  const content = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') { quoted = false; closed = true; }
      else cell += char;
    } else if (char === '"' && !cell && !closed) quoted = true;
    else if (char === ",") finishCell();
    else if (char === "\r" || char === "\n") {
      if (char === "\r" && content[index + 1] === "\n") index++;
      finishRecord();
    } else {
      if (closed || char === '"') throw new Error("The existing CSV has invalid quoting; choose a different file.");
      cell += char;
    }
  }
  if (quoted) throw new Error("The existing CSV is incomplete; choose a different file.");
  if (cell || record.length || closed) finishRecord();
  if (records.shift()?.join(",") !== MATLAB_ANNOTATION_COLUMNS.join(",")) {
    throw new Error("The selected file is not a MATLAB annotation CSV. Choose a new filename to keep that file unchanged.");
  }
  const rows = records.map((values) => {
    if (values.length !== MATLAB_ANNOTATION_COLUMNS.length) throw new Error("The existing CSV has an invalid row; choose a different file.");
    const row = Object.fromEntries(MATLAB_ANNOTATION_COLUMNS.map((key, index) => [key, values[index]])) as MatlabAnnotationRow;
    validateRow(row);
    return row;
  });
  return rows;
}

export function matlabAnnotationFilename(patient: string, reviewer: string): string {
  const safe = (text: string) => text.trim().replace(/ /g, "_").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  return `${safe(patient) || "recording"}_${safe(reviewer) || "reviewer"}_annotations.csv`;
}

export type MatlabCsvFileHandle = {
  getFile(): Promise<Blob>;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }>;
};

export async function writeMatlabAnnotations(handle: MatlabCsvFileHandle, current: MatlabAnnotationRow[]): Promise<number> {
  // Read/validate BEFORE createWritable: resaving must not erase other sessions' accepted rows.
  const previous = parseMatlabAnnotations(await (await handle.getFile()).text());
  const rows = mergeMatlabAnnotationRows(previous, current);
  const blob = new Blob([serializeMatlabAnnotations(rows)], { type: "text/csv;charset=utf-8" });
  const writable = await handle.createWritable();
  try { await writable.write(blob); await writable.close(); }
  catch (error) { await writable.abort?.().catch(() => {}); throw error; }
  return rows.length;
}

/** Keep only small export rows when directory navigation closes a recording. */
export class MatlabReviewCsvCache {
  private sessions = new Map<string, { group: string; rows: MatlabAnnotationRow[] }>();
  update(session: string, group: string, rows: MatlabAnnotationRow[]): void {
    this.sessions.set(JSON.stringify([group, session]), { group, rows });
  }
  rows(group: string): MatlabAnnotationRow[] {
    return [...this.sessions.values()].filter((session) => session.group === group).flatMap((session) => session.rows);
  }
}
