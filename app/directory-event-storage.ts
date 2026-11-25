/*
Purpose: Caches directory event metadata in IndexedDB without storing waveform samples.
File Dependencies: app/directory-event-index.ts.
*/


import type { DirectoryEventIndex, DirectoryEventRequest } from "./directory-event-index.ts";

let connection: Promise<IDBDatabase> | undefined;
/** Opens or reuses the IndexedDB connection for directory event metadata. */
function database() {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("neurotrace-label-index", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("recordings");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("The label index is busy."));
  }).catch((error: unknown) => { connection = undefined; throw error; });
  return connection;
}

/** Builds the cache key for the supplied request. */
function key(request: DirectoryEventRequest) {
  /** Builds the identity used to compare the supplied value. */
  const identity = (file: File) => [file.webkitRelativePath || file.name, file.size, file.lastModified];
  return JSON.stringify([request.format, identity(request.file), request.eventTables.map(identity)]);
}

/** Reads the stored directory index. */
export async function readStoredDirectoryIndex(request: DirectoryEventRequest): Promise<DirectoryEventIndex | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const read = db.transaction("recordings").objectStore("recordings").get(key(request));
    read.onsuccess = () => {
      const value = read.result as DirectoryEventIndex | undefined;
      resolve(value?.state === "ready" && Array.isArray(value.labels) && value.labels.every((label) => typeof label === "string")
        ? value : undefined);
    };
    read.onerror = () => reject(read.error);
  });
}

/** Persists only completed directory event indexes. */
export async function storeDirectoryIndex(request: DirectoryEventRequest, result: DirectoryEventIndex) {
  if (result.state !== "ready") return;
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("recordings", "readwrite");
    transaction.objectStore("recordings").put(result, key(request));
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}
