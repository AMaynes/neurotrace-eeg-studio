/*
Purpose: Edits reusable dictionary labels and source-label aliases.
File Dependencies: app/review-workspace.ts.
*/


"use client";

import { useState } from "react";
import type { DictionaryLabel, LabelLibrary } from "./review-workspace";

/** Renders the label library editor controls and their current state. */
export function LabelLibraryEditor({ library, types, onChange, onClose }: {
  library: LabelLibrary;
  types: readonly { key: string; name: string }[];
  onChange: (library: LabelLibrary) => void;
  onClose: () => void;
}) {
  const [key, setKey] = useState(types[0]?.key ?? "");
  const currentAlias = library.aliases.find((item) => item.key === key);
  const [editing, setEditing] = useState<DictionaryLabel | null>(null);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal label-library-modal" data-tutorial="label-library-dialog" role="dialog" aria-modal="true" aria-label="Label library" tabIndex={-1}>
      <button type="button" className="modal-close" onClick={onClose} aria-label="Close label library">×</button>
      <h2>Label library</h2>
      <p>Give detected labels clearer names and descriptions, or create reusable labels for the palette.</p>
      <section>
        <h3>Aliases and descriptions</h3>
        <label className="form-field"><span>Original label</span><select value={key} onChange={(event) => setKey(event.target.value)}>
          {types.map((type) => <option key={type.key} value={type.key}>{type.name}</option>)}
        </select></label>
        <form key={key} onSubmit={(event) => {
          event.preventDefault();
          if (!key) return;
          const data = new FormData(event.currentTarget);
          const alias = String(data.get("alias") ?? "").trim();
          const description = String(data.get("description") ?? "").trim();
          const aliases = library.aliases.filter((item) => item.key !== key);
          if (alias || description) aliases.push({ key, alias, description });
          onChange({ ...library, aliases });
        }}>
          <label className="form-field"><span>Display alias</span><input name="alias" maxLength={120} defaultValue={currentAlias?.alias} /></label>
          <label className="form-field"><span>Label description</span><textarea name="description" rows={2} maxLength={2000} defaultValue={currentAlias?.description} /></label>
          <button type="submit" className="button secondary" disabled={!key}>Save alias and description</button>
        </form>
      </section>
      <section>
        <h3>Dictionary labels</h3>
        <form key={editing?.id ?? "new"} onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const name = String(data.get("name") ?? "").trim();
          if (!name) return;
          const entry = { id: editing?.id ?? crypto.randomUUID(), name,
            code: String(data.get("code") ?? "").trim(), description: String(data.get("definition") ?? "").trim() };
          const labels = editing ? library.labels.map((item) => item.id === editing.id ? entry : item) : [...library.labels, entry];
          onChange({ ...library, labels });
          event.currentTarget.reset();
          setEditing(null);
        }}>
          <label className="form-field"><span>Dictionary label name</span><input required name="name" maxLength={120} defaultValue={editing?.name} /></label>
          <label className="form-field"><span>Code word</span><input name="code" maxLength={80} defaultValue={editing?.code} /></label>
          <label className="form-field"><span>Dictionary description</span><textarea name="definition" rows={2} maxLength={2000} defaultValue={editing?.description} /></label>
          <button type="submit" className="button secondary" disabled={!editing && library.labels.length >= 1000}>{editing ? "Update dictionary label" : "Create dictionary label"}</button>
          {editing && <button type="button" className="button quiet" onClick={() => setEditing(null)}>Cancel edit</button>}
        </form>
        {library.labels.length > 0 && <ul className="dictionary-label-list">{library.labels.map((item) => <li key={item.id}>
          <span>{item.name}{item.code ? ` · ${item.code}` : ""}</span>
          <button type="button" className="button quiet" onClick={() => setEditing(item)}>Edit</button>
        </li>)}</ul>}
      </section>
      <footer><button type="button" className="button primary" onClick={onClose}>Done</button></footer>
    </div>
  </div>;
}
