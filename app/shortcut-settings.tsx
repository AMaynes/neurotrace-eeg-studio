"use client";

import { useState } from "react";
import { DEFAULT_CONTROLS, SHORTCUTS, SHORTCUT_GROUPS, shortcutConflict, shortcutFromEvent, shortcutLabel, shortcutRestriction, type ControlBindings, type ShortcutAction } from "./shortcuts";
import "./shortcut-settings.css";

/** A focused key recorder never dispatches application shortcuts; Tab still leaves it normally. */
export function ShortcutSettings({ bindings, onChange }: { bindings: ControlBindings; onChange(bindings: ControlBindings): void }) {
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<{ action: ShortcutAction; index: number } | null>(null);
  const [message, setMessage] = useState("");
  return <section className="settings-section shortcut-settings">
    <div className="settings-heading"><strong>Keyboard shortcuts</strong><button onClick={() => { onChange(DEFAULT_CONTROLS); setRecording(null); setMessage("Defaults restored."); }}>Restore defaults</button></div>
    <p>Click a key to replace it, or + Add to record another. Use × to remove a binding. Ctrl and ⌘ share the same setting. Changes save automatically, including in saved workspaces.</p>
    <input type="search" aria-label="Find a shortcut" placeholder="Find a shortcut…" value={query} onChange={(event) => setQuery(event.target.value)} />
    <div className="shortcut-status" role="status">{message || "Conflicting bindings are blocked. Tab moves focus; it cannot be reassigned. Some system shortcuts cannot be captured."}</div>
    {SHORTCUT_GROUPS.map((group) => {
      const rows = SHORTCUTS.filter((item) => group.scopes.includes(item.scope) && `${item.label} ${group.title} ${bindings[item.id].map(shortcutLabel).join(" ")}`.toLowerCase().includes(query.toLowerCase()));
      if (!rows.length) return null;
      return <details key={`${group.title}:${Boolean(query)}`} open={query ? true : undefined} className="shortcut-group">
        <summary>{group.title}<small>{rows.length}</small></summary>
        <p>{group.note}</p>
        {rows.map((item) => <div className="shortcut-row" key={item.id}>
          <span>{item.label}</span>
          <div className="shortcut-bindings">
            {[...bindings[item.id], null].map((chord, index) => {
              const active = recording?.action === item.id && recording.index === index;
              return <span className="shortcut-chip" key={index}>
                <button type="button" data-shortcut-recorder="true" className={active ? "recording" : ""}
                  aria-label={`${chord ? "Change" : "Add"} ${item.label} shortcut${chord ? ` ${shortcutLabel(chord)}` : ""}`}
                  onClick={() => { setRecording(active ? null : { action: item.id, index }); setMessage(active ? "Recording cancelled." : "Press your shortcut, including any modifiers. Click again or Tab away to cancel. Escape can be assigned too."); }}
                  onBlur={() => setRecording(null)}
                  onKeyDown={(event) => {
                    if (!active || event.key === "Tab") return;
                    event.preventDefault(); event.stopPropagation();
                    if (event.repeat) return;
                    const next = shortcutFromEvent(event);
                    if (!next) return;
                    const restriction = shortcutRestriction(next, item.id);
                    const conflict = shortcutConflict(bindings, item.id, next);
                    if (restriction || conflict) { setMessage(restriction ?? `Already assigned to “${conflict}”. Remove that binding first or choose another.`); return; }
                    const keys = [...bindings[item.id]];
                    keys[index] = next;
                    onChange({ ...bindings, [item.id]: [...new Set(keys)] });
                    setRecording(null); setMessage(`${item.label}: ${shortcutLabel(next)} saved.`);
                  }}
                >{active ? "Press keys…" : chord ? shortcutLabel(chord) : "+ Add"}</button>
                {chord && <button type="button" aria-label={`Remove ${shortcutLabel(chord)} from ${item.label}`} onClick={() => { onChange({ ...bindings, [item.id]: bindings[item.id].filter((_, position) => position !== index) }); setMessage("Binding removed."); }}>×</button>}
              </span>;
            })}
          </div>
        </div>)}
      </details>;
    })}
    <details className="shortcut-group"><summary>Standard text & focus controls</summary><p>These native controls stay unchanged: Tab / Shift + Tab move focus; Enter / Space activate a focused button; arrows operate select menus and number fields; Ctrl/⌘ + A, C, X, V, Z and Shift + Z select, copy, cut, paste, undo and redo text. Application shortcuts are paused while typing (Escape may still close a dialog). Use the mouse close button if you remove the close shortcut.</p></details>
  </section>;
}
