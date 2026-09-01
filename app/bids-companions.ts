/**
 * Browser-side discovery and best-effort parsing for BIDS JSON/TSV companions.
 * The parser deliberately catalogs every selected file while applying only
 * metadata whose BIDS entities are compatible with the active recording.
 */

export type UploadedFileRole =
  | "recording"
  | "recording-companion"
  | "metadata"
  | "events"
  | "channels"
  | "electrodes"
  | "table"
  | "other";

export type UploadedFileStatus = "primary" | "applied" | "catalogued" | "available" | "error";

export interface UploadedFileRecord {
  key: string;
  name: string;
  path: string;
  size: number;
  lastModified: number;
  extension: string;
  role: UploadedFileRole;
  status: UploadedFileStatus;
  detail: string;
}

export interface BidsTableSummary {
  path: string;
  kind: string;
  columns: string[];
  rowCount: number;
  applied: boolean;
}

export interface BidsChannelRecord {
  name: string;
  type: string;
  units: string;
  status: string;
  description: string;
  samplingFrequency: number | null;
  reference: string;
}

export interface BidsEventRecord {
  id: string;
  sourcePath: string;
  rowIndex: number;
  onset: number;
  duration: number;
  label: string;
  description: string;
  channels: string[];
  values: Record<string, string>;
}

export interface BidsCompanionBundle {
  files: UploadedFileRecord[];
  metadata: Record<string, unknown>;
  metadataSources: string[];
  tables: BidsTableSummary[];
  channels: BidsChannelRecord[];
  events: BidsEventRecord[];
  badChannelIndices: number[];
  subjectId: string | null;
  sessionId: string | null;
  recordingType: string | null;
  warnings: string[];
}

export interface CompanionAnalysisOptions {
  recordingFile?: File | null;
  channelCount?: number;
}

type ParsedBidsName = {
  entities: Record<string, string>;
  suffix: string;
};

type ParsedTsv = {
  columns: string[];
  rows: Array<Record<string, string>>;
};

const JSON_SIZE_LIMIT = 8 * 1024 * 1024;
const TSV_SIZE_LIMIT = 48 * 1024 * 1024;
const RECORDING_EXTENSIONS = new Set(["edf", "mat", "dat", "bdf", "set", "nwb"]);
const RECORDING_COMPANION_EXTENSIONS = new Set(["vhdr", "vmrk", "eeg", "fdt", "mefd"]);
const GENERIC_METADATA_NAMES = new Set([
  "dataset_description.json",
  "metadata.json",
  "recording.json",
  "session.json",
  "subject.json",
]);
const APPLICABLE_JSON_SUFFIXES = new Set(["eeg", "ieeg", "coordsystem"]);

export function emptyBidsCompanionBundle(): BidsCompanionBundle {
  return {
    files: [],
    metadata: {},
    metadataSources: [],
    tables: [],
    channels: [],
    events: [],
    badChannelIndices: [],
    subjectId: null,
    sessionId: null,
    recordingType: null,
    warnings: [],
  };
}

export function relativeFilePath(file: File): string {
  return (file.webkitRelativePath || file.name)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

export function selectedFileKey(file: File): string {
  return `${relativeFilePath(file).toLowerCase()}\0${file.size}\0${file.lastModified}`;
}

export function mergeSelectedFiles(existing: readonly File[], incoming: readonly File[]): File[] {
  const merged = new Map<string, File>();
  for (const file of [...existing, ...incoming]) {
    merged.set(relativeFilePath(file).toLowerCase(), file);
  }
  return [...merged.values()].sort((left, right) =>
    relativeFilePath(left).localeCompare(relativeFilePath(right), undefined, { numeric: true }));
}

function fileExtension(file: File): string {
  return file.name.split(".").at(-1)?.toLowerCase() ?? "";
}

function fileSuffix(path: string): string {
  const base = path.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  return base.split("_").at(-1)?.toLowerCase() ?? "";
}

export function classifyUploadedFile(file: File): UploadedFileRole {
  const extension = fileExtension(file);
  const suffix = fileSuffix(relativeFilePath(file));
  if (RECORDING_EXTENSIONS.has(extension)) return "recording";
  if (RECORDING_COMPANION_EXTENSIONS.has(extension)) return "recording-companion";
  if (extension === "json") return "metadata";
  if (extension === "tsv") {
    if (suffix === "events") return "events";
    if (suffix === "channels") return "channels";
    if (suffix === "electrodes") return "electrodes";
    return "table";
  }
  return "other";
}

function parseBidsName(path: string): ParsedBidsName {
  const base = path.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const tokens = base.split("_").filter(Boolean);
  const entities: Record<string, string> = {};
  for (const token of tokens.slice(0, -1)) {
    const separator = token.indexOf("-");
    if (separator <= 0 || separator === token.length - 1) continue;
    entities[token.slice(0, separator).toLowerCase()] = token.slice(separator + 1);
  }
  return { entities, suffix: (tokens.at(-1) ?? "").toLowerCase() };
}

function entityCompatibility(sidecar: ParsedBidsName, recording: ParsedBidsName | null): boolean {
  if (!recording) return true;
  return Object.entries(sidecar.entities).every(([key, value]) =>
    recording.entities[key] === undefined || recording.entities[key] === value);
}

function specificity(path: string): number {
  const parsed = parseBidsName(path);
  return Object.keys(parsed.entities).length * 100 + path.split("/").length;
}

function stableEventId(path: string, rowIndex: number, onset: number, label: string): string {
  const material = `${path}\0${rowIndex}\0${onset}\0${label}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `bids-event-${(hash >>> 0).toString(36)}`;
}

function parseDelimitedRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && character === delimiter) {
      row.push(value);
      value = "";
      continue;
    }
    if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value);
      value = "";
      if (row.some((entry) => entry.length > 0)) rows.push(row);
      row = [];
      continue;
    }
    value += character;
  }
  if (value.length || row.length) {
    row.push(value);
    if (row.some((entry) => entry.length > 0)) rows.push(row);
  }
  return rows;
}

export function parseTsv(text: string): ParsedTsv {
  const rows = parseDelimitedRows(text.replace(/^\uFEFF/, ""), "\t");
  const columns = (rows.shift() ?? []).map((column) => column.trim());
  if (!columns.length || columns.some((column) => !column)) {
    throw new Error("TSV header contains an empty column name.");
  }
  return {
    columns,
    rows: rows.map((values) => Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""]))),
  };
}

function finiteTsvNumber(value: string | undefined): number | null {
  if (!value || value.trim().toLowerCase() === "n/a") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function splitChannelNames(value: string | undefined): string[] {
  if (!value || value.trim().toLowerCase() === "n/a") return [];
  return value.split(/[,;|]/).map((entry) => entry.trim()).filter(Boolean);
}

function displayStatus(role: UploadedFileRole, status: UploadedFileStatus): string {
  if (status === "primary") return "Primary waveform source";
  if (status === "applied") return role === "events" ? "Events imported" : "Metadata applied";
  if (status === "error") return "Could not parse";
  if (status === "available") return "Additional recording catalogued";
  return role === "other" ? "Catalogued for provenance" : "Catalogued; not associated with this recording";
}

function isGenericMetadata(path: string, parsed: ParsedBidsName): boolean {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  return GENERIC_METADATA_NAMES.has(name) || APPLICABLE_JSON_SUFFIXES.has(parsed.suffix);
}

function recordingTypeFrom(recording: ParsedBidsName | null, metadata: Record<string, unknown>): string | null {
  if (recording?.suffix === "ieeg") return "SEEG / iEEG";
  if (recording?.suffix === "eeg") return "Scalp EEG";
  if (typeof metadata.iEEGReference === "string") return "SEEG / iEEG";
  if (typeof metadata.EEGReference === "string") return "Scalp EEG";
  return null;
}

export async function analyzeBidsCompanions(
  files: readonly File[],
  options: CompanionAnalysisOptions = {},
): Promise<BidsCompanionBundle> {
  const bundle = emptyBidsCompanionBundle();
  const primaryKey = options.recordingFile ? selectedFileKey(options.recordingFile) : null;
  const recordingPath = options.recordingFile ? relativeFilePath(options.recordingFile) : "";
  const recordingName = recordingPath.split("/").at(-1) ?? "";
  const recording = recordingPath ? parseBidsName(recordingPath) : null;
  const statuses = new Map<string, UploadedFileStatus>();
  const details = new Map<string, string>();
  const jsonCandidates: Array<{ path: string; parsedName: ParsedBidsName; value: Record<string, unknown> }> = [];
  const tables: Array<{ file: File; path: string; parsedName: ParsedBidsName; parsed: ParsedTsv }> = [];

  for (const file of files) {
    const key = selectedFileKey(file);
    const role = classifyUploadedFile(file);
    statuses.set(key, key === primaryKey ? "primary" : role === "recording" ? "available" : "catalogued");

    if (role === "metadata") {
      const path = relativeFilePath(file);
      try {
        if (file.size > JSON_SIZE_LIMIT) throw new Error(`JSON exceeds the ${JSON_SIZE_LIMIT / 1024 / 1024} MB parsing limit.`);
        const parsed: unknown = JSON.parse(await file.text());
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON root must be an object.");
        jsonCandidates.push({ path, parsedName: parseBidsName(path), value: parsed as Record<string, unknown> });
        details.set(key, "JSON metadata parsed");
      } catch (error) {
        statuses.set(key, "error");
        const message = error instanceof Error ? error.message : "Unknown JSON parsing error";
        details.set(key, message);
        bundle.warnings.push(`${path}: ${message}`);
      }
      continue;
    }

    if (role === "events" || role === "channels" || role === "electrodes" || role === "table") {
      const path = relativeFilePath(file);
      try {
        if (file.size > TSV_SIZE_LIMIT) throw new Error(`TSV exceeds the ${TSV_SIZE_LIMIT / 1024 / 1024} MB parsing limit.`);
        const parsed = parseTsv(await file.text());
        tables.push({ file, path, parsedName: parseBidsName(path), parsed });
        details.set(key, `${parsed.rows.length.toLocaleString()} rows · ${parsed.columns.length} columns`);
      } catch (error) {
        statuses.set(key, "error");
        const message = error instanceof Error ? error.message : "Unknown TSV parsing error";
        details.set(key, message);
        bundle.warnings.push(`${path}: ${message}`);
      }
    }
  }

  for (const candidate of jsonCandidates
    .filter(({ path, parsedName }) => isGenericMetadata(path, parsedName) && entityCompatibility(parsedName, recording))
    .sort((left, right) => specificity(left.path) - specificity(right.path))) {
    Object.assign(bundle.metadata, candidate.value);
    bundle.metadataSources.push(candidate.path);
    const sourceFile = files.find((file) => relativeFilePath(file) === candidate.path);
    if (sourceFile) statuses.set(selectedFileKey(sourceFile), "applied");
  }

  const applicableTables = tables.filter(({ parsedName }) => entityCompatibility(parsedName, recording));
  const participantId = recording?.entities.sub ? `sub-${recording.entities.sub}` : null;
  const sessionId = recording?.entities.ses ? `ses-${recording.entities.ses}` : null;
  bundle.subjectId = participantId;
  bundle.sessionId = sessionId;

  for (const table of tables) {
    const name = table.path.split("/").at(-1)?.toLowerCase() ?? "";
    let applied = applicableTables.includes(table);
    let selectedRow: Record<string, string> | undefined;
    if (name === "participants.tsv" && participantId) {
      selectedRow = table.parsed.rows.find((row) => row.participant_id === participantId);
      applied = Boolean(selectedRow);
    } else if (name.endsWith("_sessions.tsv") && sessionId) {
      selectedRow = table.parsed.rows.find((row) => row.session_id === sessionId);
      applied = Boolean(selectedRow);
    } else if (name.endsWith("_scans.tsv") && recordingName) {
      selectedRow = table.parsed.rows.find((row) => {
        const filename = (row.filename ?? "").replace(/\\/g, "/");
        return filename === recordingPath || filename.endsWith(`/${recordingName}`) || filename === recordingName;
      });
      applied = Boolean(selectedRow);
    }
    if (selectedRow) Object.assign(bundle.metadata, selectedRow);
    bundle.tables.push({
      path: table.path,
      kind: table.parsedName.suffix || name.replace(/\.tsv$/i, ""),
      columns: table.parsed.columns,
      rowCount: table.parsed.rows.length,
      applied,
    });
    if (applied) statuses.set(selectedFileKey(table.file), "applied");
  }

  const channelTable = applicableTables
    .filter(({ parsedName }) => parsedName.suffix === "channels")
    .sort((left, right) => specificity(left.path) - specificity(right.path))
    .at(-1);
  if (channelTable) {
    bundle.channels = channelTable.parsed.rows.map((row) => ({
      name: row.name?.trim() ?? "",
      type: row.type?.trim() ?? "",
      units: row.units?.trim() ?? "",
      status: row.status?.trim() ?? "",
      description: row.description?.trim() ?? "",
      samplingFrequency: finiteTsvNumber(row.sampling_frequency),
      reference: row.reference?.trim() ?? "",
    }));
    if (options.channelCount !== undefined && bundle.channels.length !== options.channelCount) {
      bundle.warnings.push(`${channelTable.path}: ${bundle.channels.length} channel rows do not match the recording's ${options.channelCount} channels; channel labels and quality flags were not applied.`);
      bundle.channels = [];
    } else if (bundle.channels.some((channel) => !channel.name)) {
      bundle.warnings.push(`${channelTable.path}: one or more channel names are blank; channel labels and quality flags were not applied.`);
      bundle.channels = [];
    } else {
      bundle.badChannelIndices = bundle.channels.flatMap((channel, index) =>
        channel.status.toLowerCase() === "bad" ? [index] : []);
    }
  }

  for (const table of applicableTables.filter(({ parsedName }) => parsedName.suffix === "events")) {
    table.parsed.rows.forEach((row, rowIndex) => {
      const onset = finiteTsvNumber(row.onset);
      if (onset === null) {
        bundle.warnings.push(`${table.path}: row ${rowIndex + 2} has no finite onset and was not imported.`);
        return;
      }
      const duration = finiteTsvNumber(row.duration) ?? 0;
      const label = row.trial_type || row.event_type || row.value || row.description || "BIDS event";
      bundle.events.push({
        id: stableEventId(table.path, rowIndex, onset, label),
        sourcePath: table.path,
        rowIndex,
        onset,
        duration: Math.max(0, duration),
        label,
        description: row.description || row.HED || "",
        channels: splitChannelNames(row.channels || row.channel),
        values: row,
      });
    });
  }

  if (bundle.channels.length) {
    bundle.metadata.BIDSChannelRows = bundle.channels.length;
  }
  if (bundle.events.length) {
    bundle.metadata.BIDSEventRows = bundle.events.length;
  }
  bundle.recordingType = recordingTypeFrom(recording, bundle.metadata);

  bundle.files = files.map((file) => {
    const key = selectedFileKey(file);
    const role = classifyUploadedFile(file);
    const status = statuses.get(key) ?? "catalogued";
    return {
      key,
      name: file.name,
      path: relativeFilePath(file),
      size: file.size,
      lastModified: file.lastModified,
      extension: fileExtension(file),
      role,
      status,
      detail: details.get(key) ?? displayStatus(role, status),
    };
  });

  return bundle;
}
