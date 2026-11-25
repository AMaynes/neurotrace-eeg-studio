/*
Purpose: Defines label visibility filter for the NeuroTrace workspace.
File Dependencies: app/label-visibility-filter.css, app/label-visibility.ts.
*/


"use client";

import { useState } from "react";
import type { LabelTypeOption } from "./label-visibility";
import "./label-visibility-filter.css";

/** Searchable display preferences. The parent retains all source and review data. */
export function LabelVisibilityFilter({ options, hiddenTypes, keywords, onKeywordsChange, onChange, onClose }: {
  options: readonly LabelTypeOption[];
  hiddenTypes: ReadonlySet<string>;
  keywords: string;
  onKeywordsChange: (keywords: string) => void;
  onChange: (hidden: Set<string>) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(100);
  const query = search.trim().toLowerCase();
  const matches = options.filter((option) => option.name.toLowerCase().includes(query));
  const hiddenCount = options.filter((option) => hiddenTypes.has(option.key)).length;
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal label-display-filter" data-tutorial="label-filter-dialog" role="dialog" aria-modal="true" aria-label="Filter labels" tabIndex={-1}>
      <button className="modal-close" type="button" aria-label="Close label filter" onClick={onClose}>×</button>
      <header><h2>Filter labels</h2><span>{hiddenCount} of {options.length} types hidden</span></header>
      <label className="label-keyword-field">Only show labels matching
        <input type="search" value={keywords} onChange={(event) => onKeywordsChange(event.target.value)} placeholder="e.g. seizure, spike" />
        <small>Separate keywords with commas. Any keyword can match.</small>
      </label>
      <p>Uncheck types to hide them from the viewer, timelines, and queues.</p>
      <input type="search" aria-label="Find label types" placeholder="Find a label type…" value={search} onChange={(event) => {
        setSearch(event.target.value);
        setLimit(100);
      }} />
      <div className="label-display-filter-actions">
        <button type="button" data-tutorial="label-filter-reset" onClick={() => { onKeywordsChange(""); onChange(new Set()); }}>Show all types</button>
        <button type="button" onClick={() => onChange(new Set([...hiddenTypes, ...options.map((option) => option.key)]))}>Hide all types</button>
      </div>
      <div className="label-display-filter-list">
        {matches.slice(0, limit).map((option) => <label key={option.key}>
          <input type="checkbox" checked={!hiddenTypes.has(option.key)} onChange={(event) => {
            const next = new Set(hiddenTypes);
            if (event.target.checked) next.delete(option.key);
            else next.add(option.key);
            onChange(next);
          }} />
          <span>{option.name}<small>{option.source === "recording" ? "File label" : "Annotation type"}</small></span>
          <b>{option.count}</b>
        </label>)}
        {!matches.length && <p>No label types match your search.</p>}
        {matches.length > limit && <button type="button" className="label-display-filter-more" onClick={() => setLimit((count) => count + 100)}>Show more types ({matches.length - limit} remaining)</button>}
      </div>
      <footer><button type="button" className="button primary" onClick={onClose}>Done</button></footer>
    </div>
  </div>;
}
