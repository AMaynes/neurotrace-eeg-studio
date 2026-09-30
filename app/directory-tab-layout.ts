import type { DirectoryImportPlan } from "./directory-import";

type OwnedTab = { id: string; directoryId?: string; directoryRecordingId?: string };
type Catalog = { id: string; plan: DirectoryImportPlan };

/** Navigate the catalog's file order, not the order of the currently open tabs. */
export function adjacentDirectoryRecording(catalog: Catalog, tab: OwnedTab | undefined, direction: -1 | 1) {
  if (!tab || tab.directoryId !== catalog.id || !tab.directoryRecordingId) return undefined;
  const index = catalog.plan.recordings.findIndex((recording) => recording.id === tab.directoryRecordingId);
  return index < 0 ? undefined : catalog.plan.recordings[index + direction];
}

export type DirectoryTabHeader = {
  key: string;
  catalogId: string;
  label: string;
  total: number;
  column: number;
  span: number;
  sessionIds: string[];
};

/** Browser directory paths expose the selected root name, not its private absolute path. */
export function directoryTabLabel(plan: DirectoryImportPlan) {
  const roots = plan.recordings.map((recording) => {
    const parts = recording.relativePath.replaceAll("\\", "/").split("/");
    return parts.length > 1 ? parts[0] : "";
  });
  return roots.length && roots[0] && roots.every((root) => root === roots[0]) ? roots[0] : "Selected files";
}

/** Grid spans never include a tab from another folder or a standalone recording. */
export function directoryTabHeaders(tabs: readonly OwnedTab[], catalogs: readonly Catalog[]): DirectoryTabHeader[] {
  const byId = new Map(catalogs.map((catalog) => [catalog.id, catalog]));
  const seen = new Set<string>();
  const headers: DirectoryTabHeader[] = [];
  for (let index = 0; index < tabs.length; index += 1) {
    const catalog = tabs[index].directoryId ? byId.get(tabs[index].directoryId!) : undefined;
    if (!catalog) continue;
    const first = index;
    while (index + 1 < tabs.length && tabs[index + 1].directoryId === catalog.id) index += 1;
    headers.push({ key: `${catalog.id}-${first}`, catalogId: catalog.id, label: directoryTabLabel(catalog.plan),
      total: catalog.plan.recordings.length, column: first + 1, span: index - first + 1,
      sessionIds: tabs.slice(first, index + 1).map((tab) => tab.id) });
    seen.add(catalog.id);
  }
  // Keep the list reachable before any file is opened or after the last tab closes.
  let column = tabs.length + 1;
  for (const catalog of catalogs) {
    if (seen.has(catalog.id)) continue;
    headers.push({ key: `${catalog.id}-empty`, catalogId: catalog.id, label: directoryTabLabel(catalog.plan),
      total: catalog.plan.recordings.length, column: column++, span: 1, sessionIds: [] });
  }
  return headers;
}
