"use client";

import { useEffect, useRef, useState } from "react";
import { WORKSPACE_TOOLS, type WorkspaceToolId } from "./workspace-layout";
import "./workspace-navigation.css";

/** Small, keyboard-accessible tabs shared by the sidebar and its label sections. */
export function WorkspaceTabs<T extends string>({ id, label, tabs, value, onChange }: {
  id: string; label: string; tabs: readonly { id: T; label: string }[]; value: T; onChange: (value: T) => void;
}) {
  return <div className="workspace-tabs" role="tablist" aria-label={label}>
    {tabs.map((tab, index) => <button key={tab.id} id={`${id}-tab-${tab.id}`} role="tab" data-tutorial={`${id}-${tab.id}`}
      aria-selected={tab.id === value} aria-controls={`${id}-panel-${tab.id}`} tabIndex={tab.id === value ? 0 : -1}
      onClick={() => onChange(tab.id)} onKeyDown={event => {
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
          : event.key === "ArrowRight" ? (index + 1) % tabs.length
          : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : null;
        if (next === null) return;
        event.preventDefault();
        onChange(tabs[next].id);
        document.getElementById(`${id}-tab-${tabs[next].id}`)?.focus();
      }}>{tab.label}</button>)}
  </div>;
}

/** Add/remove only optional tools; the transport and time controls are always available. */
export function ToolbarCustomizer({ selected, onChange }: { selected: WorkspaceToolId[]; onChange: (tools: WorkspaceToolId[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation(); setOpen(false);
      ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, [open]);
  return <div className="toolbar-customizer" ref={ref}>
    <button className="toolbar-add" aria-label="Customize toolbar" aria-expanded={open} aria-controls="toolbar-tool-picker" onClick={() => setOpen(value => !value)}>+</button>
    {open && <div className="toolbar-tool-picker" id="toolbar-tool-picker" role="group" aria-label="Optional toolbar tools">
      <strong>Add tools to toolbar</strong>
      {WORKSPACE_TOOLS.map(tool => <label key={tool.id}><input type="checkbox" checked={selected.includes(tool.id)}
        onChange={event => onChange(event.target.checked ? [...selected, tool.id] : selected.filter(id => id !== tool.id))} />{tool.label}</label>)}
    </div>}
  </div>;
}

/** Names are toggles, so disabled channels remain available for a single-click restore. */
export function ChannelVisibilityControls({ labels, groups, selected, search, onSearch, onChange, disabled }: {
  labels: string[]; groups: [string, { name: string; index: number }[]][]; selected: Set<number>;
  search: string; onSearch: (value: string) => void; onChange: (indices: number[], enabled: boolean) => void; disabled: boolean;
}) {
  const query = search.trim().toLowerCase();
  return <section className="sidebar-channels" aria-label="Channel visibility">
    <header><h2>Channels</h2><span>{selected.size}/{labels.length} enabled</span></header>
    <p>Click a channel or group name to enable or disable it.</p>
    <input type="search" aria-label="Find channels in View" placeholder="Find a channel…" value={search} onChange={event => onSearch(event.target.value)} />
    <div className="sidebar-channel-actions">
      <button disabled={disabled} onClick={() => onChange(labels.map((_, index) => index), true)}>Enable all</button>
      <button disabled={disabled} onClick={() => onChange(labels.map((_, index) => index), false)}>Disable all</button>
    </div>
    {groups.map(([group, members]) => {
      const visible = group.toLowerCase().includes(query) ? members : members.filter(member => member.name.toLowerCase().includes(query));
      if (!visible.length) return null;
      const count = members.filter(member => selected.has(member.index)).length;
      return <div className="sidebar-channel-group" key={group}>
        <button className="sidebar-channel-heading" disabled={disabled} aria-pressed={count === members.length}
          aria-label={`Toggle ${group} channel group`} data-state={count === members.length ? "enabled" : count ? "partial" : "disabled"}
          onClick={() => onChange(members.map(member => member.index), count !== members.length)}><strong>{group}</strong><span>{count}/{members.length}</span></button>
        <div>{visible.map(member => <button key={member.index} disabled={disabled} aria-pressed={selected.has(member.index)}
          title={member.name} onClick={() => onChange([member.index], !selected.has(member.index))}>{member.name}</button>)}</div>
      </div>;
    })}
    {!groups.some(([group, members]) => group.toLowerCase().includes(query) || members.some(member => member.name.toLowerCase().includes(query))) && <p>No matching channels.</p>}
  </section>;
}
