"use client";

import { useEffect, useRef, useState } from "react";
import { WORKSPACE_TOOLS, type ToolbarToolId } from "./workspace-layout";
import "./workspace-navigation.css";

/** Small, keyboard-accessible tabs shared by the sidebar and its label sections. */
export function WorkspaceTabs<T extends string>({ id, label, tabs, value, onChange, numbered = false }: {
  id: string; label: string; tabs: readonly { id: T; label: string }[]; value: T; onChange: (value: T) => void;
  numbered?: boolean;
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
      }}>{numbered && <span className="workspace-tab-number" aria-hidden="true">{index + 1}</span>}{tab.label}</button>)}
  </div>;
}

/** Add/remove only optional tools; the transport and time controls are always available. */
export function ToolbarCustomizer({ selected, pinnedLabels, onChange }: {
  selected: ToolbarToolId[];
  pinnedLabels: readonly { id: ToolbarToolId; label: string }[];
  onChange: (tools: ToolbarToolId[]) => void;
}) {
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
    <button className="toolbar-add" data-tutorial="customize-toolbar" aria-label="Customize toolbar" aria-expanded={open} aria-controls="toolbar-tool-picker" onClick={() => setOpen(value => !value)}>+</button>
    {open && <div className="toolbar-tool-picker" id="toolbar-tool-picker" role="group" aria-label="Optional toolbar tools">
      <strong>Add tools to toolbar</strong>
      {[...WORKSPACE_TOOLS, ...pinnedLabels].map(tool => <label key={tool.id}><input type="checkbox" checked={selected.includes(tool.id)}
        onChange={event => onChange(event.target.checked ? [...selected, tool.id] : selected.filter(id => id !== tool.id))} />{tool.label}</label>)}
    </div>}
  </div>;
}
