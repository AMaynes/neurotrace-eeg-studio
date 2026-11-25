/** Sidebar and optional toolbar preferences, including migration of older JSON saves. */
export const WORKSPACE_TABS = [
  { id: "info", label: "Info" },
  { id: "view", label: "Viewing Tools" },
  { id: "labels", label: "Labels" },
] as const;
export const INFO_TABS = [
  { id: "files", label: "Folder/File" },
  { id: "window", label: "Window/Performance" },
] as const;
export const LABEL_TABS = [
  { id: "session", label: "Session" },
  { id: "events", label: "Window / Instance" },
  { id: "create", label: "Create" },
] as const;
export const VIEW_TOOL_SECTIONS = [
  { id: "channels", label: "Channels" },
  { id: "waveform", label: "Waveform" },
  { id: "analysis", label: "Analysis" },
] as const;
export const WORKSPACE_TOOLS = [
  { id: "montage", label: "Montage", section: "channels" },
  { id: "groups", label: "Grouping", section: "channels" },
  { id: "gain", label: "Gain", section: "waveform" },
  { id: "clamp", label: "Clamping", section: "waveform" },
  { id: "filters", label: "Filters", section: "waveform" },
  { id: "spectrogram", label: "Spectrogram", section: "analysis" },
  { id: "tracks", label: "Label tracks", section: "lower" },
] as const;
export type WorkspaceTab = typeof WORKSPACE_TABS[number]["id"];
export type InfoTab = typeof INFO_TABS[number]["id"];
export type LabelTab = typeof LABEL_TABS[number]["id"];
export type WorkspaceToolId = typeof WORKSPACE_TOOLS[number]["id"];
export type ToolbarToolId = WorkspaceToolId | `label:${string}`;

export function isLabelToolbarTool(id: unknown): id is `label:${string}` {
  return typeof id === "string" && /^label:(?:dictionary:)?[A-Za-z0-9_-]{1,120}$/.test(id);
}

export function normalizeWorkspaceLayout(settings: Record<string, unknown>) {
  const legacyInfoTab = settings.sidebarTab === "files" || settings.sidebarTab === "window" ? settings.sidebarTab : null;
  const legacyInspector = settings.rightPanelView === "inspect" || settings.rightPanelView === "resources";
  const sidebarTab: WorkspaceTab = WORKSPACE_TABS.some(tab => tab.id === settings.sidebarTab)
    ? settings.sidebarTab as WorkspaceTab
    : legacyInfoTab || legacyInspector ? "info" : "labels";
  const infoTab: InfoTab = legacyInfoTab ?? (INFO_TABS.some(tab => tab.id === settings.infoTab)
    ? settings.infoTab as InfoTab : legacyInspector ? "window" : "files");
  const labelsTab: LabelTab = LABEL_TABS.some(tab => tab.id === settings.labelsTab)
    ? settings.labelsTab as LabelTab : "events";
  const toolbarTools = Array.isArray(settings.toolbarTools)
    ? [...new Set(settings.toolbarTools.filter((id): id is ToolbarToolId => WORKSPACE_TOOLS.some(tool => tool.id === id) || isLabelToolbarTool(id)))] : [];
  return { sidebarTab, infoTab, labelsTab, toolbarTools };
}
