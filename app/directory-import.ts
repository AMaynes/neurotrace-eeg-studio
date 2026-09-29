/**
 * Filename-only discovery for a directory of recordings or saved projects.
 * This module never reads waveform/archive bytes or treats an extension as
 * verified contents; each entry must pass its normal loader when opened.
 */

export type DirectoryImportFormat = "edf" | "mat" | "mat-dat" | "neurotrace";

export interface DirectoryRecording {
  /** Case-insensitive relative path identity, not a content fingerprint. */
  id: string;
  label: string;
  primary: File;
  /** Only this recording and its exact partner, never another recording. */
  files: File[];
  relativePath: string;
}

export interface DirectoryImportPlan {
  format: DirectoryImportFormat;
  recordings: DirectoryRecording[];
  /** Shared once, avoiding one full companion-file array per recording. */
  supportingFiles: File[];
}

export type DirectoryImportErrorCode =
  | "EMPTY_DIRECTORY"
  | "INVALID_PATH"
  | "DUPLICATE_PATH"
  | "MIXED_FORMATS"
  | "MISSING_PAIR"
  | "NO_RECORDINGS";

export class DirectoryImportError extends Error {
  readonly code: DirectoryImportErrorCode;
  readonly paths: string[];

  constructor(code: DirectoryImportErrorCode, message: string, paths: string[] = []) {
    super(message);
    this.name = "DirectoryImportError";
    this.code = code;
    this.paths = paths;
  }
}

interface DirectoryFile {
  file: File;
  path: string;
  key: string;
  extension: string;
  stemKey: string;
}

const FORMAT_LABELS: Record<DirectoryImportFormat, string> = {
  edf: "EDF-only",
  mat: "standalone MAT-only",
  "mat-dat": "paired MAT + DAT",
  neurotrace: "NeuroTrace",
};

// Recognizable non-selected waveform/project files are not harmless metadata.
// Unknown extensions remain available to the existing companion cataloguer.
const RECORDING_EXTENSIONS = new Set([
  "edf", "mat", "dat", "neurotrace", "bdf", "set", "nwb", "vhdr", "vmrk", "eeg", "fdt", "mefd",
]);
const NATURAL_PATH_ORDER = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function comparePaths(a: DirectoryFile, b: DirectoryFile): number {
  return NATURAL_PATH_ORDER.compare(a.path, b.path)
    || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function describePaths(paths: string[]): string {
  const preview = paths.slice(0, 4).map((path) => `“${path}”`).join(", ");
  return paths.length > 4 ? `${preview}, and ${paths.length - 4} more` : preview;
}

function describeFile(file: File): DirectoryFile {
  const path = (file.webkitRelativePath || file.name).replaceAll("\\", "/");
  const segments = path.split("/");
  if (!path || segments.some((segment) => !segment || segment === "." || segment === "..") || /^[a-z]:/i.test(path)) {
    throw new DirectoryImportError("INVALID_PATH", `Invalid relative file path: “${path}”. Select the directory again.`, [path]);
  }
  const name = segments[segments.length - 1];
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  const key = path.toLowerCase();
  return { file, path, key, extension, stemKey: dot < 0 ? key : key.slice(0, -(extension.length + 1)) };
}

function recordingEntry(primary: DirectoryFile, files: File[]): DirectoryRecording {
  return {
    id: `directory:${primary.key}`,
    label: primary.path,
    primary: primary.file,
    files,
    relativePath: primary.path,
  };
}

/**
 * Discover every recording recursively from a browser directory selection.
 * MAT + DAT pairing requires the same relative folder and basename (ignoring
 * case); a similarly named file in another directory is never a substitute.
 * Reject the entire selection on ambiguity or mixed recording families, before
 * opening any source. Non-recording companions are shared separately on the plan.
 */
export function planDirectoryImport(files: readonly File[], format: DirectoryImportFormat): DirectoryImportPlan {
  if (!files.length) {
    throw new DirectoryImportError("EMPTY_DIRECTORY", "The selected directory is empty. Choose a directory containing recordings.");
  }

  const entries = files.map(describeFile).sort(comparePaths);
  const byPath = new Map<string, DirectoryFile>();
  for (const entry of entries) {
    const previous = byPath.get(entry.key);
    if (previous) {
      throw new DirectoryImportError(
        "DUPLICATE_PATH",
        `Ambiguous duplicate paths: ${describePaths([previous.path, entry.path])}. File paths must be unique, ignoring case.`,
        [previous.path, entry.path],
      );
    }
    byPath.set(entry.key, entry);
  }

  const allowed = new Set(format === "mat-dat" ? ["mat", "dat"] : [format]);
  const incompatible = entries.filter((entry) => RECORDING_EXTENSIONS.has(entry.extension) && !allowed.has(entry.extension));
  if (incompatible.length) {
    const paths = incompatible.map((entry) => entry.path);
    throw new DirectoryImportError(
      "MIXED_FORMATS",
      `This directory must contain ${FORMAT_LABELS[format]} ${format === "neurotrace" ? "projects" : "recordings"} only. Incompatible recording files: ${describePaths(paths)}. Choose a same-format directory; metadata companions such as JSON and TSV are allowed.`,
      paths,
    );
  }

  const sources = entries.filter((entry) => allowed.has(entry.extension));
  if (!sources.length) {
    throw new DirectoryImportError("NO_RECORDINGS", `No ${FORMAT_LABELS[format]} ${format === "neurotrace" ? "projects" : "recordings"} were found in the selected directory.`);
  }

  let recordings: DirectoryRecording[];
  if (format === "mat-dat") {
    const missing = sources.filter((entry) => !byPath.has(`${entry.stemKey}.${entry.extension === "dat" ? "mat" : "dat"}`));
    if (missing.length) {
      const paths = missing.map((entry) => entry.path);
      throw new DirectoryImportError(
        "MISSING_PAIR",
        `Every MAT + DAT session needs one .mat and one .dat file with the same basename in the same folder (case-insensitive). Missing partners for ${describePaths(paths)}.`,
        paths,
      );
    }
    // DAT is the waveform source; MAT supplies only that source's metadata.
    recordings = sources.filter((entry) => entry.extension === "dat").map((entry) => (
      recordingEntry(entry, [byPath.get(`${entry.stemKey}.mat`)!.file, entry.file])
    ));
  } else {
    recordings = sources.map((entry) => recordingEntry(entry, [entry.file]));
  }

  return {
    format,
    recordings,
    supportingFiles: entries.filter((entry) => !allowed.has(entry.extension)).map((entry) => entry.file),
  };
}

const SHARED_DIRECTORY_METADATA = new Set([
  "dataset_description.json", "metadata.json", "recording.json", "session.json", "subject.json",
  "participants.tsv", "participants.json",
]);
const NAMED_SIDECAR_SUFFIXES = new Set(["events", "channels", "electrodes", "coordsystem", "eeg", "ieeg", "scans", "sessions"]);
const SINGLE_RECORDING_TABLES = new Set(["events.tsv", "channels.tsv", "electrodes.tsv"]);

function normalizedDirectoryPath(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

function directoryOf(path: string): string {
  return normalizedDirectoryPath(path).replace(/[^/]*$/, "");
}

function nameParts(path: string): { name: string; stem: string; extension: string; suffix: string; prefix: string; entities: Map<string, string> } {
  const name = normalizedDirectoryPath(path).split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  const stem = dot < 0 ? name : name.slice(0, dot);
  const extension = dot < 0 ? "" : name.slice(dot + 1);
  const tokens = stem.split("_");
  const suffix = tokens.at(-1) ?? "";
  const prefix = tokens.slice(0, -1).join("_");
  const entities = new Map<string, string>();
  // Unstructured prefixes (a_events, lab_a_events, etc.) are not BIDS
  // inheritance rules. They must match the recording's exact basename.
  for (const token of tokens.slice(0, -1)) {
    const entity = /^([a-z][a-z0-9]*)-([a-z0-9]+)$/.exec(token);
    if (!entity || entities.has(entity[1])) {
      entities.clear();
      break;
    }
    entities.set(entity[1], entity[2]);
  }
  return { name, stem, extension, suffix, prefix, entities };
}

/**
 * Construct only the selected session's inputs on demand. Ancestor metadata
 * can be inherited; sibling/descendant companions can never be inherited.
 * Non-BIDS sidecars require an exact recording basename in the same folder.
 * BIDS sidecars require a strict subset of matching recording entities (an
 * absent entity is not a wildcard). Bare events/channels/electrodes tables
 * are ambiguous if their folder has multiple recordings, so they are omitted.
 * Omitted files remain in the catalog; no association or data is guessed.
 */
export function directoryRecordingFiles(plan: DirectoryImportPlan, recording: DirectoryRecording): File[] {
  // A project defines its own recording, companions, and review state. Nearby
  // files must never alter that saved content or supply a guessed recording.
  if (plan.format === "neurotrace") return [recording.primary];
  const recordingFolder = directoryOf(recording.relativePath);
  const recordingName = nameParts(recording.relativePath);
  const sameFolderStems = new Map<string, string>();
  const modalityBaseOwners = new Map<string, string[]>();
  for (const entry of plan.recordings) {
    if (directoryOf(entry.relativePath) !== recordingFolder) continue;
    const stem = nameParts(entry.relativePath).stem;
    sameFolderStems.set(stem, entry.id);
    const base = stem.replace(/_(?:eeg|ieeg)$/, "");
    const owners = modalityBaseOwners.get(base) ?? [];
    owners.push(entry.id);
    modalityBaseOwners.set(base, owners);
  }
  const companions = plan.supportingFiles.filter((file) => {
    const companionPath = file.webkitRelativePath || file.name;
    const companionFolder = directoryOf(companionPath);
    // Folders retain their trailing slash so day-1 cannot match day-10.
    if (!recordingFolder.startsWith(companionFolder)) return false;
    const sidecar = nameParts(companionPath);
    if (sidecar.extension !== "json" && sidecar.extension !== "tsv") return true;
    if (SHARED_DIRECTORY_METADATA.has(sidecar.name)) return true;
    if ((sidecar.suffix === "eeg" || sidecar.suffix === "ieeg")
      && (recordingName.suffix === "eeg" || recordingName.suffix === "ieeg")
      && sidecar.suffix !== recordingName.suffix) return false;

    const sameFolder = recordingFolder === companionFolder;
    if (sameFolder) {
      const exactOwner = sameFolderStems.get(sidecar.stem);
      if (exactOwner) return exactOwner === recording.id;
      if (NAMED_SIDECAR_SUFFIXES.has(sidecar.suffix) && sidecar.prefix) {
        const namedOwner = sameFolderStems.get(sidecar.prefix);
        if (namedOwner) return namedOwner === recording.id;
        const modalityOwners = modalityBaseOwners.get(sidecar.prefix) ?? [];
        if (!sidecar.entities.size && modalityOwners.length) {
          return modalityOwners.length === 1 && modalityOwners[0] === recording.id;
        }
      }
    }

    if (sidecar.entities.size) {
      return [...sidecar.entities].every(([key, value]) => recordingName.entities.get(key) === value)
        && (!(sidecar.suffix === "eeg" || sidecar.suffix === "ieeg") || sidecar.suffix === recordingName.suffix);
    }
    if (sidecar.name === "coordsystem.json") return true;
    if (sidecar.name === "eeg.json" || sidecar.name === "ieeg.json") return sidecar.stem === recordingName.suffix;
    if (SINGLE_RECORDING_TABLES.has(sidecar.name)) return sameFolder && sameFolderStems.size === 1;
    return false;
  });
  return [...recording.files, ...companions];
}
