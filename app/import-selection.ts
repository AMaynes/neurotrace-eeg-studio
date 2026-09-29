import { DirectoryImportError, planDirectoryImport, type DirectoryImportFormat, type DirectoryImportPlan } from "./directory-import.ts";

export type RecordingSelection =
  | { kind: "directory"; plan: DirectoryImportPlan }
  | { kind: "files"; files: File[] };

const OTHER_RECORDING_EXTENSIONS = new Set(["bdf", "set", "nwb", "vhdr", "vmrk", "eeg", "fdt", "mefd"]);

function extensionOf(file: File): string {
  return file.name.includes(".") ? file.name.split(".").at(-1)!.toLowerCase() : "";
}

/** Classify input shape using filenames only. MAT contents are checked on opening. */
export function classifyRecordingSelection(files: readonly File[], fromDirectory = false): RecordingSelection {
  const directory = fromDirectory || files.some((file) => Boolean(file.webkitRelativePath));
  if (!files.length && directory) {
    throw new DirectoryImportError("EMPTY_DIRECTORY", "The selected directory is empty. Choose a directory containing recordings.");
  }
  let edf = 0;
  let mat = 0;
  let dat = 0;
  let projects = 0;
  let otherRecordings = 0;
  for (const file of files) {
    const extension = extensionOf(file);
    if (extension === "edf") edf += 1;
    else if (extension === "mat") mat += 1;
    else if (extension === "dat") dat += 1;
    else if (extension === "neurotrace") projects += 1;
    else if (OTHER_RECORDING_EXTENSIONS.has(extension)) otherRecordings += 1;
  }
  // A MAT and its DAT describe one session, not two. Sidecars never increase
  // the session count, and companion-only folders keep additive file import.
  const sessionCount = edf + Math.max(mat, dat) + projects + otherRecordings;
  if (!sessionCount || (!directory && sessionCount <= 1)) return { kind: "files", files: [...files] };

  const format: DirectoryImportFormat | null = edf ? "edf" : dat ? "mat-dat" : mat ? "mat" : null;
  if (!format) {
    const paths = files.filter((file) => extensionOf(file) === "neurotrace" || OTHER_RECORDING_EXTENSIONS.has(extensionOf(file)))
      .map((file) => file.webkitRelativePath || file.name);
    throw new DirectoryImportError("MIXED_FORMATS", "Recording collections support EDF, standalone MAT, or matching MAT + DAT pairs only. Open a .neurotrace project individually; other recording formats are not supported.", paths);
  }
  return { kind: "directory", plan: planDirectoryImport(files, format) };
}

interface DroppedEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  file?: (success: (file: File) => void, error?: (error: DOMException) => void) => void;
  createReader?: () => { readEntries(success: (entries: DroppedEntry[]) => void, error?: (error: DOMException) => void): void };
}

const MAX_DROPPED_ENTRIES = 100_000;
const MAX_PATH_SEGMENTS = 200;
const KNOWN_FILE_EXTENSIONS = new Set([
  "edf", "mat", "dat", "neurotrace", ...OTHER_RECORDING_EXTENSIONS,
  "json", "tsv", "csv", "txt", "md", "xml", "yaml", "yml", "ini", "cfg", "log", "toml",
]);

function dropFailure(detail: string): Error {
  return new Error(`${detail} Nothing was imported. Try Choose folder for a directory, or Choose files for individual files.`);
}

function assertFallbackFile(file: File): void {
  if (!file.size && !file.type && !KNOWN_FILE_EXTENSIONS.has(extensionOf(file))) {
    throw dropFailure("The browser could not identify a dropped item as a readable file.");
  }
}

/**
 * Snapshot drag entries while the drop data store is readable, then enumerate
 * all directory-reader batches. Preserve File objects; never copy signal bytes.
 * Traversal is all-or-nothing so failures cannot open an incomplete collection.
 */
export async function collectDroppedRecordingFiles(dataTransfer: DataTransfer): Promise<{ files: File[]; directory: boolean }> {
  const fallbackFiles = [...dataTransfer.files];
  const fileItems = [...dataTransfer.items].filter((item) => item.kind === "file");
  if (fallbackFiles.length > MAX_DROPPED_ENTRIES || fileItems.length > MAX_DROPPED_ENTRIES) {
    throw dropFailure("The dropped selection contains too many entries (maximum 100,000).");
  }
  // Keep every access to DataTransfer / DataTransferItem before the first await.
  const roots = fileItems.map((item, index) => {
    let entry: DroppedEntry | null;
    try {
      entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    } catch {
      throw dropFailure("The browser could not inspect the dropped files or directory.");
    }
    return { entry, file: entry ? null : item.getAsFile() ?? fallbackFiles[index] ?? null };
  });
  if (!roots.length) {
    fallbackFiles.forEach(assertFallbackFile);
    return { files: fallbackFiles, directory: fallbackFiles.some((file) => Boolean(file.webkitRelativePath)) };
  }

  const files: File[] = [];
  let directory = roots.some(({ entry }) => Boolean(entry?.isDirectory));
  let entryCount = 0;
  const visit = async (entry: DroppedEntry, ancestors: string[]): Promise<void> => {
    entryCount += 1;
    if (entryCount > MAX_DROPPED_ENTRIES) throw dropFailure("The dropped selection contains too many entries (maximum 100,000).");
    if (!entry.name || /[/\\]/.test(entry.name) || entry.name === "." || entry.name === ".." || /^[a-z]:/i.test(entry.name)) {
      throw dropFailure("The dropped directory contains an invalid relative path.");
    }
    const segments = [...ancestors, entry.name];
    if (segments.length > MAX_PATH_SEGMENTS) throw dropFailure("The dropped directory nesting exceeds 200 path segments.");
    if (entry.isFile && !entry.isDirectory && entry.file) {
      let file: File;
      try {
        file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject));
      } catch {
        throw dropFailure("A file in the dropped selection could not be read.");
      }
      if (ancestors.length) {
        const path = segments.join("/");
        try {
          if (file.webkitRelativePath !== path) Object.defineProperty(file, "webkitRelativePath", { value: path, configurable: true });
        } catch {
          throw dropFailure("The browser could not preserve the dropped directory's file paths.");
        }
      }
      files.push(file);
      return;
    }
    if (entry.isDirectory && !entry.isFile && entry.createReader) {
      let reader: ReturnType<NonNullable<DroppedEntry["createReader"]>>;
      try {
        reader = entry.createReader();
      } catch {
        throw dropFailure("A dropped directory could not be opened.");
      }
      while (true) {
        let batch: DroppedEntry[];
        try {
          batch = await new Promise<DroppedEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        } catch {
          throw dropFailure("A dropped directory could not be fully read.");
        }
        if (!batch.length) return;
        for (const child of batch) await visit(child, segments);
      }
    }
    throw dropFailure("The browser returned an unsupported dropped item.");
  };

  for (const root of roots) {
    if (root.entry) await visit(root.entry, []);
    else if (root.file) {
      entryCount += 1;
      if (entryCount > MAX_DROPPED_ENTRIES) throw dropFailure("The dropped selection contains too many entries (maximum 100,000).");
      assertFallbackFile(root.file);
      files.push(root.file);
    } else throw dropFailure("One of the dropped items could not be read.");
  }
  directory ||= files.some((file) => Boolean(file.webkitRelativePath));
  return { files, directory };
}
