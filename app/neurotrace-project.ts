/**
 * Overview & Purpose
 * Defines the portable NeuroTrace project container and safe custom-tool assets.
 *
 * Architectural Relationships
 * Called by: The workstation save and mixed-file import flows in app/page.tsx.
 * Calls: Browser Blob/File streaming and slice APIs to build and read ZIP32
 * projects without materializing included recordings as an extra full copy.
 *
 * External Resources
 * The `.neurotrace` format is a stored ZIP containing a versioned JSON manifest.
 *
 * Notes
 * Custom equations and filtering methods are preserved as inert text. This
 * module never evaluates imported content. ZIP paths are normalized to prevent
 * path traversal, and ZIP32 limits are rejected explicitly.
 */

export const NEUROTRACE_PROJECT_SCHEMA = "neurotrace-project";
export const NEUROTRACE_PROJECT_VERSION = 1;
export const NEUROTRACE_PROJECT_MIME = "application/vnd.neurotrace.project+zip";
export const MAX_CUSTOM_TOOL_BYTES = 4 * 1024 * 1024;
export const MAX_CUSTOM_TOOL_TOTAL_BYTES = 64 * 1024 * 1024;

const ZIP32_MAX_VALUE = 0xffffffff;
const ZIP32_MAX_ENTRIES = 0xffff;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type NeurotraceCustomToolKind =
  | "dictionary"
  | "equation"
  | "filter-method"
  | "label-definitions"
  | "channel-grouping";

export type NeurotraceCustomToolAsset = {
  id: string;
  kind: NeurotraceCustomToolKind;
  name: string;
  sourceName: string;
  mimeType: string;
  byteLength: number;
  importedAt: string;
  content: string;
};

export type NeurotraceRecordingReference = {
  name: string;
  format: string;
  byteLength: number;
  durationSec: number;
  channelCount: number;
  sourceContentSha256: string;
  sessionInterpretationSha256: string;
};

export type NeurotraceProjectArchiveRequest = {
  projectId: string;
  title: string;
  appVersion: string;
  createdAt?: string;
  recording: NeurotraceRecordingReference | null;
  review?: unknown;
  workspace?: unknown;
  labelDefinitions?: unknown;
  customTools?: readonly NeurotraceCustomToolAsset[];
  supportingFiles?: readonly File[];
  recordingFile?: File | null;
};

export type NeurotraceProjectManifest = {
  schema: typeof NEUROTRACE_PROJECT_SCHEMA;
  formatVersion: typeof NEUROTRACE_PROJECT_VERSION;
  appVersion: string;
  projectId: string;
  title: string;
  createdAt: string;
  recording: (NeurotraceRecordingReference & { included: boolean; archivePath: string | null }) | null;
  sections: {
    review: string | null;
    workspace: string | null;
    labelDefinitions: string | null;
    customTools: string | null;
    supportingFiles: string | null;
  };
  contents: Array<{ path: string; role: string; byteLength: number }>;
  security: {
    importedToolsAreExecutable: false;
    note: string;
  };
};

export type ImportedNeurotraceProject = {
  manifest: NeurotraceProjectManifest;
  recordingFile: File | null;
  supportingFiles: File[];
  customToolFiles: File[];
  review: unknown | null;
  workspace: unknown | null;
};

type ZipContent = string | Uint8Array | Blob;
type ZipArchiveEntry = { path: string; content: ZipContent; role: string };

export type CustomToolImportResult = {
  assets: NeurotraceCustomToolAsset[];
  remainingFiles: File[];
  errors: Array<{ fileName: string; message: string }>;
};

function toolKindFromToken(value: unknown): NeurotraceCustomToolKind | null {
  if (typeof value !== "string") return null;
  const token = value.toLowerCase().replace(/[\s_]+/g, "-");
  if (["dictionary", "words", "word-list", "lexicon"].includes(token)) return "dictionary";
  if (["equation", "equations", "formula", "formulas"].includes(token)) return "equation";
  if (["filter", "filter-method", "filtering-method", "signal-filter"].includes(token)) return "filter-method";
  if (["labels", "label-definitions", "ontology"].includes(token)) return "label-definitions";
  if (["channel-group", "channel-groups", "channel-grouping"].includes(token)) return "channel-grouping";
  return null;
}

/** Returns a custom-tool kind only for explicit names or self-describing JSON. */
export function classifyCustomTool(name: string, parsedJson?: unknown): NeurotraceCustomToolKind | null {
  const lowerName = name.toLowerCase();
  const explicitExtension = lowerName.match(/\.(dict|dictionary|words|equation|formula|filter|method|labels|channelgroup)$/)?.[1];
  const extensionKind = toolKindFromToken(explicitExtension);
  if (extensionKind) return extensionKind;

  const namedKinds: Array<[RegExp, NeurotraceCustomToolKind]> = [
    [/(?:^|[-_. ])(?:dictionary|word[-_ ]?list|lexicon)(?:[-_. ]|$)/, "dictionary"],
    [/(?:^|[-_. ])(?:equations?|formulas?)(?:[-_. ]|$)/, "equation"],
    [/(?:^|[-_. ])(?:filter(?:ing)?[-_ ]?methods?|signal[-_ ]?filters?)(?:[-_. ]|$)/, "filter-method"],
    [/(?:^|[-_. ])(?:label[-_ ]?definitions?|ontology)(?:[-_. ]|$)/, "label-definitions"],
    [/(?:^|[-_. ])(?:channel[-_ ]?groups?|channel[-_ ]?grouping)(?:[-_. ]|$)/, "channel-grouping"],
  ];
  const namedKind = namedKinds.find(([pattern]) => pattern.test(lowerName))?.[1];
  if (namedKind) return namedKind;

  if (!parsedJson || typeof parsedJson !== "object") return null;
  const record = parsedJson as Record<string, unknown>;
  const declared = toolKindFromToken(
    record.kind
    ?? record.type
    ?? (record.neurotraceTool && typeof record.neurotraceTool === "object"
      ? (record.neurotraceTool as Record<string, unknown>).kind
      : undefined),
  );
  if (declared) return declared;
  if (Array.isArray(record.words) || Array.isArray(record.dictionary)) return "dictionary";
  if (Array.isArray(record.equations) || typeof record.equation === "string") return "equation";
  if (Array.isArray(record.filters) || Array.isArray(record.filterMethods)) return "filter-method";
  if (Array.isArray(record.labels)) return "label-definitions";
  if (Array.isArray(record.channelGroups)) return "channel-grouping";
  return null;
}

function customToolId(file: File, content: string) {
  const seed = `${file.name}\0${file.size}\0${file.lastModified}\0${content.slice(0, 256)}`;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `tool-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Reads one bounded text asset and validates JSON when applicable. */
export async function readCustomToolAsset(file: File): Promise<NeurotraceCustomToolAsset | null> {
  if (file.size > MAX_CUSTOM_TOOL_BYTES) {
    const namedKind = classifyCustomTool(file.name);
    if (!namedKind) return null;
    throw new RangeError(`Custom tool files must be ${MAX_CUSTOM_TOOL_BYTES / 1024 / 1024} MB or smaller.`);
  }
  const lowerName = file.name.toLowerCase();
  const mightBeTool = classifyCustomTool(file.name) !== null
    || /\.(json|ya?ml|txt|csv)$/i.test(lowerName);
  if (!mightBeTool) return null;

  const content = await file.text();
  let parsedJson: unknown;
  if (lowerName.endsWith(".json")) {
    try {
      parsedJson = JSON.parse(content);
    } catch (error) {
      if (classifyCustomTool(file.name)) {
        throw new SyntaxError(`Custom tool JSON is invalid: ${error instanceof Error ? error.message : "parse failed"}`);
      }
      return null;
    }
  }
  const kind = classifyCustomTool(file.name, parsedJson);
  if (!kind) return null;
  return {
    id: customToolId(file, content),
    kind,
    name: file.name.replace(/\.[^.]+$/, ""),
    sourceName: file.name,
    mimeType: file.type || (lowerName.endsWith(".json") ? "application/json" : "text/plain"),
    byteLength: file.size,
    importedAt: new Date().toISOString(),
    content,
  };
}

/** Separates inert custom-tool assets from ordinary recording/companion files. */
export async function importCustomToolFiles(files: readonly File[]): Promise<CustomToolImportResult> {
  const assets: NeurotraceCustomToolAsset[] = [];
  const remainingFiles: File[] = [];
  const errors: Array<{ fileName: string; message: string }> = [];
  let totalBytes = 0;
  for (const file of files) {
    try {
      const asset = await readCustomToolAsset(file);
      if (!asset) {
        remainingFiles.push(file);
        continue;
      }
      if (totalBytes + asset.byteLength > MAX_CUSTOM_TOOL_TOTAL_BYTES) {
        throw new RangeError(`Imported custom tools may total at most ${MAX_CUSTOM_TOOL_TOTAL_BYTES / 1024 / 1024} MB.`);
      }
      totalBytes += asset.byteLength;
      assets.push(asset);
    } catch (error) {
      errors.push({
        fileName: file.name,
        message: error instanceof Error ? error.message : "The custom tool could not be read.",
      });
    }
  }
  return { assets, remainingFiles, errors };
}

/** Replaces a repeated source filename while preserving all other imported tools. */
export function mergeCustomToolAssets(
  current: readonly NeurotraceCustomToolAsset[],
  incoming: readonly NeurotraceCustomToolAsset[],
) {
  const bySourceName = new Map(current.map((asset) => [asset.sourceName.toLowerCase(), asset]));
  for (const asset of incoming) bySourceName.set(asset.sourceName.toLowerCase(), asset);
  return [...bySourceName.values()];
}

/** Converts a user-controlled archive path into a relative, traversal-safe path. */
export function safeArchivePath(path: string) {
  const segments = path.replace(/\\/g, "/").split("/").flatMap((segment) => {
    const cleaned = segment.trim().replace(/[\u0000-\u001f<>:"|?*]/g, "_");
    if (!cleaned || cleaned === ".") return [];
    if (cleaned === "..") return ["_"];
    return [cleaned.slice(0, 180)];
  });
  return segments.join("/") || "unnamed";
}

function uniqueArchivePath(path: string, usedPaths: Set<string>) {
  const safePath = safeArchivePath(path);
  if (!usedPaths.has(safePath.toLowerCase())) {
    usedPaths.add(safePath.toLowerCase());
    return safePath;
  }
  const slash = safePath.lastIndexOf("/");
  const directory = slash >= 0 ? safePath.slice(0, slash + 1) : "";
  const fileName = slash >= 0 ? safePath.slice(slash + 1) : safePath;
  const dot = fileName.lastIndexOf(".");
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : "";
  for (let suffix = 2; suffix < ZIP32_MAX_ENTRIES; suffix += 1) {
    const candidate = `${directory}${base} (${suffix})${extension}`;
    if (usedPaths.has(candidate.toLowerCase())) continue;
    usedPaths.add(candidate.toLowerCase());
    return candidate;
  }
  throw new RangeError("The archive contains too many duplicate filenames.");
}

function byteLength(content: ZipContent) {
  if (typeof content === "string") return encoder.encode(content).byteLength;
  return content instanceof Blob ? content.size : content.byteLength;
}

function contentPart(content: ZipContent): BlobPart {
  if (typeof content === "string") return encoder.encode(content) as BlobPart;
  return content as BlobPart;
}

function updateCrc32(crc: number, bytes: Uint8Array) {
  let next = crc;
  for (const byte of bytes) {
    next ^= byte;
    for (let bit = 0; bit < 8; bit += 1) next = (next >>> 1) ^ (0xedb88320 & -(next & 1));
  }
  return next;
}

async function crc32(content: ZipContent) {
  let crc = 0xffffffff;
  if (typeof content === "string") {
    crc = updateCrc32(crc, encoder.encode(content));
  } else if (content instanceof Uint8Array) {
    crc = updateCrc32(crc, content);
  } else {
    const reader = content.stream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      crc = updateCrc32(crc, value);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds an uncompressed ZIP32 archive while retaining Blob-backed file data. */
export async function createStoredZip(entries: readonly ZipArchiveEntry[]) {
  if (entries.length > ZIP32_MAX_ENTRIES) throw new RangeError("ZIP32 supports at most 65,535 entries.");
  const localParts: BlobPart[] = [];
  const centralParts: BlobPart[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(safeArchivePath(entry.path));
    const size = byteLength(entry.content);
    if (size > ZIP32_MAX_VALUE || localOffset + 30 + name.length + size > ZIP32_MAX_VALUE) {
      throw new RangeError("This project exceeds the 4 GB ZIP32 limit. Save without the recording or supporting files.");
    }
    const checksum = await crc32(entry.content);
    const localHeader = new Uint8Array(30 + name.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, size, true);
    localView.setUint32(22, size, true);
    localView.setUint16(26, name.length, true);
    localHeader.set(name, 30);
    localParts.push(localHeader as BlobPart, contentPart(entry.content));

    const centralHeader = new Uint8Array(46 + name.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, size, true);
    centralView.setUint32(24, size, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, localOffset, true);
    centralHeader.set(name, 46);
    centralParts.push(centralHeader as BlobPart);
    localOffset += localHeader.byteLength + size;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + (part as Uint8Array).byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  return new Blob([...localParts, ...centralParts, end as BlobPart], { type: NEUROTRACE_PROJECT_MIME });
}

function jsonContent(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function uploadPath(file: File) {
  const relativePath = "webkitRelativePath" in file && typeof file.webkitRelativePath === "string"
    ? file.webkitRelativePath
    : "";
  return relativePath || file.name;
}

/** Creates one self-describing `.neurotrace` ZIP project. */
export async function createNeurotraceProjectArchive(request: NeurotraceProjectArchiveRequest) {
  const usedPaths = new Set<string>();
  const entries: ZipArchiveEntry[] = [];
  const sections: NeurotraceProjectManifest["sections"] = {
    review: null,
    workspace: null,
    labelDefinitions: null,
    customTools: null,
    supportingFiles: null,
  };
  const add = (path: string, content: ZipContent, role: string) => {
    const uniquePath = uniqueArchivePath(path, usedPaths);
    entries.push({ path: uniquePath, content, role });
    return uniquePath;
  };

  if (request.review !== undefined) sections.review = add("review/state.json", jsonContent(request.review), "review-state");
  if (request.workspace !== undefined) sections.workspace = add("workspace/settings.json", jsonContent(request.workspace), "workspace-settings");
  if (request.labelDefinitions !== undefined) {
    sections.labelDefinitions = add("definitions/labels.json", jsonContent(request.labelDefinitions), "label-definitions");
  }

  const toolIndex = (request.customTools ?? []).map((tool) => {
    const archivePath = add(`custom-tools/files/${tool.sourceName}`, tool.content, `custom-tool:${tool.kind}`);
    return { ...tool, content: undefined, archivePath };
  });
  if (request.customTools !== undefined) {
    sections.customTools = add("custom-tools/index.json", jsonContent({ tools: toolIndex }), "custom-tool-index");
  }

  const supportingIndex = (request.supportingFiles ?? []).map((file) => {
    const archivePath = add(`uploads/files/${uploadPath(file)}`, file, "supporting-file");
    return {
      sourceName: file.name,
      sourcePath: uploadPath(file),
      archivePath,
      mimeType: file.type || "application/octet-stream",
      byteLength: file.size,
      lastModified: file.lastModified,
    };
  });
  if (request.supportingFiles !== undefined) {
    sections.supportingFiles = add("uploads/index.json", jsonContent({ files: supportingIndex }), "supporting-file-index");
  }

  const recordingArchivePath = request.recordingFile
    ? add(`recording/${request.recordingFile.name}`, request.recordingFile, "recording")
    : null;
  const readmePath = add("README.txt", [
    "NeuroTrace project",
    "",
    "This single .neurotrace file is a ZIP-compatible, versioned project container.",
    "Open manifest.json to inspect its contents. Imported dictionaries, equations,",
    "filtering methods, labels, and channel groupings are stored as inert data and",
    "must never be executed as JavaScript or operating-system commands.",
    "",
  ].join("\n"), "readme");

  const manifest: NeurotraceProjectManifest = {
    schema: NEUROTRACE_PROJECT_SCHEMA,
    formatVersion: NEUROTRACE_PROJECT_VERSION,
    appVersion: request.appVersion,
    projectId: request.projectId,
    title: request.title,
    createdAt: request.createdAt ?? new Date().toISOString(),
    recording: request.recording
      ? { ...request.recording, included: Boolean(recordingArchivePath), archivePath: recordingArchivePath }
      : null,
    sections,
    contents: entries.map((entry) => ({
      path: entry.path,
      role: entry.role,
      byteLength: byteLength(entry.content),
    })),
    security: {
      importedToolsAreExecutable: false,
      note: "Custom tools are declarative assets. Validate their schema before future use and never evaluate their text as code.",
    },
  };
  manifest.contents.push({ path: "manifest.json", role: "manifest", byteLength: 0 });
  let manifestText = jsonContent(manifest);
  for (let pass = 0; pass < 4; pass += 1) {
    const manifestBytes = encoder.encode(manifestText).byteLength;
    if (manifest.contents.at(-1)!.byteLength === manifestBytes) break;
    manifest.contents.at(-1)!.byteLength = manifestBytes;
    manifestText = jsonContent(manifest);
  }
  entries.unshift({ path: "manifest.json", content: manifestText, role: "manifest" });

  const blob = await createStoredZip(entries);
  const safeTitle = safeArchivePath(request.title).replaceAll("/", "-").replace(/\.[^.]+$/, "") || "NeuroTrace project";
  return {
    blob,
    manifest,
    fileName: `${safeTitle}.neurotrace`,
    readmePath,
  };
}

type StoredZipEntry = {
  path: string;
  size: number;
  localHeaderOffset: number;
  compressionMethod: number;
};

const ZIP_END_MIN_BYTES = 22;
const ZIP_END_SEARCH_BYTES = 65_557;
const MAX_PROJECT_METADATA_BYTES = 16 * 1024 * 1024;

async function storedZipDirectory(file: File) {
  if (file.size < ZIP_END_MIN_BYTES) throw new Error("The NeuroTrace project is incomplete.");
  const tailOffset = Math.max(0, file.size - ZIP_END_SEARCH_BYTES);
  const tail = new Uint8Array(await file.slice(tailOffset).arrayBuffer());
  let endOffset = -1;
  for (let index = tail.length - ZIP_END_MIN_BYTES; index >= 0; index -= 1) {
    if (new DataView(tail.buffer, tail.byteOffset + index, 4).getUint32(0, true) === 0x06054b50) {
      endOffset = index;
      break;
    }
  }
  if (endOffset < 0) throw new Error("The NeuroTrace project ZIP directory is missing.");
  const end = new DataView(tail.buffer, tail.byteOffset + endOffset);
  const entryCount = end.getUint16(10, true);
  const directorySize = end.getUint32(12, true);
  const directoryOffset = end.getUint32(16, true);
  if (directorySize > MAX_PROJECT_METADATA_BYTES
    || directoryOffset + directorySize > file.size
    || entryCount > ZIP32_MAX_ENTRIES) {
    throw new Error("The NeuroTrace project ZIP directory is invalid.");
  }

  const bytes = new Uint8Array(await file.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer());
  const entries = new Map<string, StoredZipEntry>();
  let offset = 0;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (offset + 46 > bytes.length) throw new Error("The NeuroTrace project ZIP directory is truncated.");
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    if (view.getUint32(0, true) !== 0x02014b50) throw new Error("The NeuroTrace project ZIP directory is invalid.");
    const compressionMethod = view.getUint16(10, true);
    const compressedSize = view.getUint32(20, true);
    const uncompressedSize = view.getUint32(24, true);
    const nameLength = view.getUint16(28, true);
    const extraLength = view.getUint16(30, true);
    const commentLength = view.getUint16(32, true);
    const localHeaderOffset = view.getUint32(42, true);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > bytes.length || compressedSize !== uncompressedSize) {
      throw new Error("The NeuroTrace project contains an unsupported compressed entry.");
    }
    const path = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (!path || safeArchivePath(path) !== path || entries.has(path)) {
      throw new Error("The NeuroTrace project contains an invalid archive path.");
    }
    entries.set(path, { path, size: uncompressedSize, localHeaderOffset, compressionMethod });
    offset = nextOffset;
  }
  return entries;
}

async function storedZipEntryBlob(file: File, entry: StoredZipEntry) {
  if (entry.compressionMethod !== 0) throw new Error("Compressed NeuroTrace project entries are not supported.");
  const headerBytes = new Uint8Array(await file.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30).arrayBuffer());
  if (headerBytes.byteLength !== 30 || new DataView(headerBytes.buffer).getUint32(0, true) !== 0x04034b50) {
    throw new Error(`The NeuroTrace project entry ${entry.path} is damaged.`);
  }
  const header = new DataView(headerBytes.buffer);
  const dataOffset = entry.localHeaderOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const dataEnd = dataOffset + entry.size;
  if (dataEnd > file.size) throw new Error(`The NeuroTrace project entry ${entry.path} is truncated.`);
  return file.slice(dataOffset, dataEnd);
}

async function readProjectJson(file: File, entries: Map<string, StoredZipEntry>, path: string | null) {
  if (!path) return null;
  const entry = entries.get(path);
  if (!entry) throw new Error(`The NeuroTrace project is missing ${path}.`);
  if (entry.size > MAX_PROJECT_METADATA_BYTES) throw new Error(`The NeuroTrace project metadata ${path} is too large.`);
  return JSON.parse(await (await storedZipEntryBlob(file, entry)).text()) as unknown;
}

/** Reads a versioned, stored-ZIP `.neurotrace` project without copying large recordings into memory. */
export async function readNeurotraceProjectArchive(file: File): Promise<ImportedNeurotraceProject> {
  const entries = await storedZipDirectory(file);
  const rawManifest = await readProjectJson(file, entries, "manifest.json");
  if (!rawManifest || typeof rawManifest !== "object" || Array.isArray(rawManifest)) {
    throw new Error("The NeuroTrace project manifest is invalid.");
  }
  const manifest = rawManifest as NeurotraceProjectManifest;
  if (manifest.schema !== NEUROTRACE_PROJECT_SCHEMA || manifest.formatVersion !== NEUROTRACE_PROJECT_VERSION) {
    throw new Error("This NeuroTrace project version is not supported.");
  }
  if (typeof manifest.title !== "string"
    || !manifest.sections || typeof manifest.sections !== "object" || Array.isArray(manifest.sections)
    || [manifest.sections.review, manifest.sections.workspace, manifest.sections.labelDefinitions,
      manifest.sections.customTools, manifest.sections.supportingFiles]
      .some((path) => path !== null && typeof path !== "string")
    || (manifest.recording !== null && (!manifest.recording || typeof manifest.recording !== "object"
      || typeof manifest.recording.name !== "string" || typeof manifest.recording.included !== "boolean"
      || (manifest.recording.archivePath !== null && typeof manifest.recording.archivePath !== "string")))) {
    throw new Error("The NeuroTrace project manifest is invalid.");
  }

  const makeFile = async (path: string, name: string, mimeType = "application/octet-stream", lastModified?: number) => {
    const entry = entries.get(path);
    if (!entry) throw new Error(`The NeuroTrace project is missing ${path}.`);
    return new File([await storedZipEntryBlob(file, entry)], name, { type: mimeType, lastModified });
  };

  const recordingFile = manifest.recording?.included && manifest.recording.archivePath
    ? await makeFile(manifest.recording.archivePath, manifest.recording.name)
    : null;

  const supportingFiles: File[] = [];
  const supportingIndex = await readProjectJson(file, entries, manifest.sections.supportingFiles);
  if (supportingIndex && typeof supportingIndex === "object" && !Array.isArray(supportingIndex)) {
    const files = (supportingIndex as { files?: unknown }).files;
    if (!Array.isArray(files)) throw new Error("The NeuroTrace supporting-file index is invalid.");
    for (const value of files) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The NeuroTrace supporting-file index is invalid.");
      const item = value as Record<string, unknown>;
      if (typeof item.archivePath !== "string" || typeof item.sourceName !== "string") {
        throw new Error("The NeuroTrace supporting-file index is invalid.");
      }
      supportingFiles.push(await makeFile(
        item.archivePath,
        item.sourceName,
        typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream",
        typeof item.lastModified === "number" ? item.lastModified : undefined,
      ));
    }
  }

  const customToolFiles: File[] = [];
  const customToolIndex = await readProjectJson(file, entries, manifest.sections.customTools);
  if (customToolIndex && typeof customToolIndex === "object" && !Array.isArray(customToolIndex)) {
    const tools = (customToolIndex as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) throw new Error("The NeuroTrace custom-tool index is invalid.");
    for (const value of tools) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The NeuroTrace custom-tool index is invalid.");
      const item = value as Record<string, unknown>;
      if (typeof item.archivePath !== "string" || typeof item.sourceName !== "string") {
        throw new Error("The NeuroTrace custom-tool index is invalid.");
      }
      customToolFiles.push(await makeFile(
        item.archivePath,
        item.sourceName,
        typeof item.mimeType === "string" ? item.mimeType : "text/plain",
      ));
    }
  }

  return {
    manifest,
    recordingFile,
    supportingFiles,
    customToolFiles,
    review: await readProjectJson(file, entries, manifest.sections.review),
    workspace: await readProjectJson(file, entries, manifest.sections.workspace),
  };
}
