import type { DirectoryImportPlan } from "./directory-import.ts";
import { MATLAB_ANNOTATION_COLUMNS, type MatlabAnnotationRow, type MatlabCsvFileHandle } from "./matlab-annotations-csv.ts";
import type { NeurotraceCustomToolAsset } from "./neurotrace-project.ts";

export type LabelAlias = { key: string; alias: string; description: string };
export type DictionaryLabel = { id: string; name: string; code: string; description: string };
export type LabelLibrary = { aliases: LabelAlias[]; labels: DictionaryLabel[] };
export const emptyLabelLibrary = (): LabelLibrary => ({ aliases: [], labels: [] });

export type ReviewRecording = {
  visitedAt: string;
  completedAt?: string;
  review: Record<string, unknown>;
  view: Record<string, unknown>;
  csvRows: MatlabAnnotationRow[];
};

export type ReviewWorkspace = {
  schema: "neurotrace-review/1";
  folderKey: string;
  reviewerId: string;
  reviewSessionId: number;
  instanceId: string;
  createdAt: string;
  updatedAt: string;
  blind: boolean;
  furthestIndex: number;
  position: string | null;
  recordings: Record<string, ReviewRecording>;
  settings: Record<string, unknown>;
  library: LabelLibrary;
  customTools: NeurotraceCustomToolAsset[];
};

const MAX_WORKSPACE_BYTES = 64 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const date = (value: unknown) => text(value, 40) && Number.isFinite(Date.parse(value));

export function normalizeReviewerId(value: string) {
  const id = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9-]{0,31}$/.test(id) ? id : "";
}

/** Include the complete selection so changing a label filter keeps the same folder identity. */
export async function reviewFolderKey(plan: DirectoryImportPlan): Promise<string> {
  const references = (plan.unfilteredRecordings ?? plan.recordings).map(({ id, files }) =>
    [id, files.map((file) => [file.name, file.size])]);
  const bytes = new TextEncoder().encode(JSON.stringify([plan.format, references]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function newReviewWorkspace(folderKey: string, reviewerId: string, reviewSessionId: number, blind: boolean): ReviewWorkspace {
  const now = new Date().toISOString();
  return {
    schema: "neurotrace-review/1", folderKey, reviewerId, reviewSessionId, instanceId: crypto.randomUUID(),
    createdAt: now, updatedAt: now, blind, furthestIndex: -1, position: null,
    recordings: {}, settings: {}, library: emptyLabelLibrary(), customTools: [],
  };
}

export function reviewWorkspaceNames({ reviewerId, reviewSessionId }: Pick<ReviewWorkspace, "reviewerId" | "reviewSessionId">) {
  const stem = `reviewer-${reviewerId}_review-${String(reviewSessionId).padStart(3, "0")}`;
  return { workspace: `${stem}_workspace.json`, annotations: `${stem}_annotations.csv` };
}

export function isReviewWorkspaceFile(file: File) {
  return /_workspace\.json$/i.test(file.name);
}

export function isReviewerCsv(file: File) {
  return /^reviewer-[a-z0-9-]+_review-\d+_annotations\.csv$/i.test(file.name);
}

export function canOpenReviewRecording(review: ReviewWorkspace | undefined, plan: DirectoryImportPlan, recordingId: string) {
  if (!review?.blind) return true;
  const index = (plan.unfilteredRecordings ?? plan.recordings).findIndex(({ id }) => id === recordingId);
  return index >= 0 && index >= review.furthestIndex;
}

export function parseLabelLibrary(value: unknown): LabelLibrary {
  if (!object(value)) return emptyLabelLibrary();
  const aliases = Array.isArray(value.aliases) ? value.aliases.slice(0, 2000).filter((item): item is LabelAlias =>
    object(item) && text(item.key, 512) && text(item.alias, 120) && text(item.description, 2000)) : [];
  const labels = Array.isArray(value.labels) ? value.labels.slice(0, 1000).filter((item): item is DictionaryLabel =>
    object(item) && text(item.id, 80) && text(item.name, 120) && item.name.trim().length > 0
    && text(item.code, 80) && text(item.description, 2000)) : [];
  return { aliases, labels };
}

export function parseReviewWorkspace(raw: string): ReviewWorkspace {
  if (raw.length > MAX_WORKSPACE_BYTES) throw new Error("The workspace JSON exceeds 64 MiB.");
  const value: unknown = JSON.parse(raw);
  if (!object(value) || value.schema !== "neurotrace-review/1" || !text(value.folderKey, 64)
    || !/^[\da-f]{64}$/.test(value.folderKey) || !text(value.reviewerId, 32) || !normalizeReviewerId(value.reviewerId)
    || normalizeReviewerId(value.reviewerId) !== value.reviewerId || !Number.isSafeInteger(value.reviewSessionId)
    || Number(value.reviewSessionId) < 1 || !text(value.instanceId, 80) || !value.instanceId
    || !date(value.createdAt) || !date(value.updatedAt) || typeof value.blind !== "boolean"
    || !Number.isSafeInteger(value.furthestIndex) || Number(value.furthestIndex) < -1
    || (value.position !== null && !text(value.position, 4096))
    || !object(value.recordings) || !object(value.settings)) throw new Error("The workspace JSON is incomplete or unsupported.");
  const recordings = Object.fromEntries(Object.entries(value.recordings).map(([key, item]) => {
    if (!text(key, 4096) || !object(item) || !date(item.visitedAt)
      || (item.completedAt !== undefined && !date(item.completedAt)) || !object(item.review) || !object(item.view)
      || !Array.isArray(item.csvRows) || item.csvRows.some((row) => !object(row) || MATLAB_ANNOTATION_COLUMNS.some((column) =>
        typeof row[column] !== "string" && !(typeof row[column] === "number" && Number.isFinite(row[column]))))
      || !Array.isArray(item.review.annotations) || !Array.isArray(item.review.candidates)) {
      throw new Error("A saved recording in this workspace is incomplete.");
    }
    return [key, item];
  }));
  const customTools = Array.isArray(value.customTools) ? value.customTools.filter((asset) =>
    object(asset) && text(asset.id, 256) && text(asset.name, 1024) && text(asset.sourceName, 1024)
    && text(asset.content, 4 * 1024 * 1024) && text(asset.mimeType, 128) && date(asset.importedAt)
    && Number.isSafeInteger(asset.byteLength) && Number(asset.byteLength) >= 0
    && ["dictionary", "equation", "filter-method", "label-definitions", "channel-grouping"].includes(String(asset.kind))) : [];
  return { ...value, recordings, library: parseLabelLibrary(value.library), customTools } as ReviewWorkspace;
}

export async function readReviewWorkspace(file: Blob) {
  if (file.size > MAX_WORKSPACE_BYTES) throw new Error("The workspace JSON exceeds 64 MiB.");
  return parseReviewWorkspace(await file.text());
}

const bucket = (folderKey: string, reviewerId: string) => `${folderKey}/${reviewerId}/`;
const keyFor = (workspace: ReviewWorkspace) => `${bucket(workspace.folderKey, workspace.reviewerId)}${workspace.reviewSessionId}`;

let dbPromise: Promise<IDBDatabase> | undefined;
function database() {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("neurotrace-review-workspaces", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("reviews");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Browser review storage is blocked by another window."));
  }).catch((error: unknown) => { dbPromise = undefined; throw error; });
  return dbPromise;
}

export async function listReviewWorkspaces(folderKey: string, reviewerId: string): Promise<ReviewWorkspace[]> {
  const db = await database();
  const prefix = bucket(folderKey, reviewerId);
  return new Promise((resolve, reject) => {
    const request = db.transaction("reviews").objectStore("reviews").getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Await the transaction, not just the request, before reporting a successful autosave. */
export async function persistReviewWorkspace(workspace: ReviewWorkspace) {
  const copy = structuredClone(workspace);
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("reviews", "readwrite");
    const store = transaction.objectStore("reviews");
    const key = keyFor(copy);
    const request = store.get(key);
    let conflict = false;
    request.onsuccess = () => {
      if (request.result && request.result.instanceId !== copy.instanceId) {
        conflict = true;
        transaction.abort();
      } else if (!request.result || request.result.updatedAt <= copy.updatedAt) {
        store.put(copy, key);
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(conflict ? new Error("Another review uses this session number.") : transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

type ReviewFile = MatlabCsvFileHandle;
export type ReviewOutputDirectory = { getFileHandle(name: string, options?: { create: boolean }): Promise<ReviewFile> };

async function writeReviewFile(handle: ReviewFile, data: Blob) {
  const writable = await handle.createWritable();
  try { await writable.write(data); await writable.close(); }
  catch (error) { await writable.abort?.().catch(() => {}); throw error; }
}

async function existingReviewFile(directory: ReviewOutputDirectory, name: string) {
  try { return await directory.getFileHandle(name); }
  catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
    return undefined;
  }
}

/** Validate both paths first. Commit the recoverable JSON before replacing the CSV. */
export async function writeReviewWorkspacePair(directory: ReviewOutputDirectory, workspace: ReviewWorkspace, csv: string) {
  const names = reviewWorkspaceNames(workspace);
  const jsonFile = await existingReviewFile(directory, names.workspace);
  const previousJson = jsonFile ? await jsonFile.getFile() : undefined;
  const existing = previousJson?.size ? await readReviewWorkspace(previousJson) : undefined;
  if (existing && (existing.instanceId !== workspace.instanceId || existing.folderKey !== workspace.folderKey
    || existing.reviewerId !== workspace.reviewerId || existing.reviewSessionId !== workspace.reviewSessionId
    || existing.updatedAt > workspace.updatedAt)) {
    throw new Error("This destination contains a different or newer review with the same filename. Choose another folder.");
  }
  const csvFile = await existingReviewFile(directory, names.annotations);
  if (!existing && csvFile && (await csvFile.getFile()).size) {
    throw new Error("This destination already contains an annotations CSV without its workspace JSON.");
  }
  const json = new Blob([JSON.stringify(workspace)], { type: "application/json" });
  await writeReviewFile(jsonFile ?? await directory.getFileHandle(names.workspace, { create: true }), json);
  await writeReviewFile(csvFile ?? await directory.getFileHandle(names.annotations, { create: true }),
    new Blob([csv], { type: "text/csv;charset=utf-8" }));
}

export type SavedReviewSummary = {
  folderKey: string;
  reviewerId: string;
  reviewSessionId: number;
  instanceId: string;
  folderName: string;
  recordingPath: string;
  updatedAt: string;
  visitedCount: number;
  labelCount: number;
};

/** Only return summaries belonging to the selected reviewer. */
export async function listSavedReviews(reviewerId: string): Promise<SavedReviewSummary[]> {
  const id = normalizeReviewerId(reviewerId);
  if (!id) return [];
  const db = await database();
  return new Promise((resolve, reject) => {
    const reviews: SavedReviewSummary[] = [];
    const request = db.transaction("reviews").objectStore("reviews").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(reviews.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
        return;
      }
      const review = cursor.value as ReviewWorkspace;
      if (review.reviewerId === id && review.position) {
        const recordingPath = review.position.replace(/^directory:/, "");
        reviews.push({
          folderKey: review.folderKey, reviewerId: id, reviewSessionId: review.reviewSessionId, instanceId: review.instanceId,
          folderName: typeof review.settings.folderName === "string" ? review.settings.folderName : recordingPath.split("/")[0],
          recordingPath, updatedAt: review.updatedAt, visitedCount: Object.keys(review.recordings).length,
          labelCount: Object.values(review.recordings).reduce((count, recording) => count + (Array.isArray(recording.review.annotations) ? recording.review.annotations.length : 0), 0),
        });
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}
