/** Sidebar and optional toolbar preferences, including migration of older JSON saves. */
export const WORKSPACE_TABS = [
  { id: "files", label: "Folder / File" },
  { id: "window", label: "Window" },
  { id: "view", label: "View" },
  { id: "labels", label: "Labels" },
] as const;
export const LABEL_TABS = [
  { id: "session", label: "Session" },
  { id: "events", label: "Window / Instance" },
  { id: "create", label: "Create" },
] as const;
export const WORKSPACE_TOOLS = [
  { id: "montage", label: "Montage" },
  { id: "groups", label: "Grouping" },
  { id: "filters", label: "Filters" },
  { id: "gain", label: "Gain" },
  { id: "clamp", label: "Clamping" },
  { id: "spectrogram", label: "Spectrogram" },
  { id: "tracks", label: "Label tracks" },
] as const;
export type WorkspaceTab = typeof WORKSPACE_TABS[number]["id"];
export type LabelTab = typeof LABEL_TABS[number]["id"];
export type WorkspaceToolId = typeof WORKSPACE_TOOLS[number]["id"];

export function normalizeWorkspaceLayout(settings: Record<string, unknown>) {
  const sidebarTab: WorkspaceTab = WORKSPACE_TABS.some(tab => tab.id === settings.sidebarTab)
    ? settings.sidebarTab as WorkspaceTab
    : settings.rightPanelView === "inspect" || settings.rightPanelView === "resources" ? "window" : "labels";
  const labelsTab: LabelTab = LABEL_TABS.some(tab => tab.id === settings.labelsTab)
    ? settings.labelsTab as LabelTab : "events";
  const toolbarTools = Array.isArray(settings.toolbarTools)
    ? [...new Set(settings.toolbarTools.filter((id): id is WorkspaceToolId => WORKSPACE_TOOLS.some(tool => tool.id === id)))] : [];
  return { sidebarTab, labelsTab, toolbarTools };
}
