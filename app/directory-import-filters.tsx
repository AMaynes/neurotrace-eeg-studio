/*
Purpose: Edits committed folder keyword filters and reports metadata scan progress.
File Dependencies: app/directory-event-client.ts, app/directory-import-filters.css, app/directory-import.ts,
  app/event-keywords.ts.
*/


"use client";

import { useEffect, useRef, useState } from "react";
import { directoryEventCache, filterDirectoryPlan, scanDirectoryEvents } from "./directory-event-client";
import type { DirectoryImportPlan } from "./directory-import";
import { COMMON_EVENT_KEYWORDS, eventKeywordPresetState, eventKeywords } from "./event-keywords";
import "./directory-import-filters.css";

/** Renders the directory import filters controls and their current state. */
export function DirectoryImportFilters({ plan, busy, onLoad, mode = "load" }: {
  plan: DirectoryImportPlan;
  busy: boolean;
  mode?: "load" | "update";
  onLoad: (plan: DirectoryImportPlan) => void;
}) {
  const [open, setOpen] = useState(Boolean(plan.eventKeywordFilter));
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [keywords, setKeywords] = useState(plan.eventKeywordFilter ?? "");
  const [applied, setApplied] = useState<{ query: string; plan: DirectoryImportPlan; incomplete: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(0);
  const [error, setError] = useState("");
  const [sourcePlan, setSourcePlan] = useState(plan);
  const scanRef = useRef<AbortController | null>(null);
  const total = plan.recordings.length;
  const terms = eventKeywords(keywords);
  const query = terms.join(", ");
  const ready = !query || applied?.query === query;
  const selected = query ? applied?.plan : plan;

  if (sourcePlan !== plan) {
    setSourcePlan(plan);
    setOpen(Boolean(plan.eventKeywordFilter));
    setPresetsOpen(false);
    setKeywords(plan.eventKeywordFilter ?? "");
    const sameFolder = (sourcePlan.unfilteredRecordings ?? sourcePlan.recordings) === (plan.unfilteredRecordings ?? plan.recordings);
    if (!sameFolder || applied?.query !== eventKeywords(plan.eventKeywordFilter ?? "").join(", ")) setApplied(null);
    setChecking(false);
    setError("");
  }
  useEffect(() => () => {
    scanRef.current?.abort();
    scanRef.current = null;
  }, [plan]);

  /** Aborts the current keyword scan and clears its transient status. */
  const cancel = () => {
    scanRef.current?.abort();
    scanRef.current = null;
    setChecking(false);
    setError("");
  };

  /** Updates the draft query and clears results from the previous keywords. */
  const changeKeywords = (value: string) => {
    setKeywords(value);
    setApplied(null);
    setError("");
  };

  /** Checks source events for the committed keywords before optionally loading matches. */
  const apply = async (loadWhenReady = false) => {
    if (scanRef.current || busy) return;
    if (!query) {
      if (loadWhenReady) onLoad({ ...plan, eventKeywordFilter: undefined });
      return;
    }
    const controller = new AbortController();
    scanRef.current = controller;
    setChecking(true);
    setError("");
    setApplied(null);
    const cache = directoryEventCache(plan);
    let checkedCount = Object.keys(cache.entries).length;
    setChecked(checkedCount);
    let updates = 0;
    try {
      await scanDirectoryEvents(plan, controller.signal, (id) => {
        if (controller.signal.aborted || scanRef.current !== controller) return;
        if (id !== null && ++updates % 16 !== 0) return;
        const count = Object.keys(cache.entries).length;
        if (count !== checkedCount) {
          checkedCount = count;
          setChecked(count);
        }
      }, true, true);
      if (controller.signal.aborted || scanRef.current !== controller) return;
      const incomplete = plan.recordings.filter(({ id }) => cache.entries[id]?.state !== "ready").length;
      const filtered = filterDirectoryPlan(plan, query);
      setApplied({ query, plan: filtered, incomplete });
      if (loadWhenReady && (mode === "update" || filtered.recordings.length)) onLoad(filtered);
    } catch (cause) {
      if (!controller.signal.aborted && scanRef.current === controller) {
        setError(cause instanceof Error ? cause.message : "Could not check event labels. Try again.");
      }
    } finally {
      if (scanRef.current === controller) {
        scanRef.current = null;
        setChecking(false);
      }
    }
  };

  return <>
    <button type="button" className="button secondary directory-import-filter-toggle" aria-expanded={open} disabled={busy}
      onClick={() => {
        if (open) {
          cancel();
          changeKeywords("");
          setPresetsOpen(false);
          if (mode === "update") onLoad({ ...plan, eventKeywordFilter: undefined });
        }
        setOpen(!open);
      }}>
      {open ? "Remove filters" : mode === "update" ? "Change folder filters" : "Add filters"}
    </button>
    {open && <div className="directory-import-filter">
      <label className="directory-filter-field">Include recordings with event labels matching
        <input type="search" value={keywords} disabled={busy || checking} placeholder="e.g. seizure, spike"
          onChange={(event) => changeKeywords(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void apply(mode === "update"); } }} />
        <small>Separate keywords with commas. A recording is included if any keyword matches.</small>
      </label>
      <div className="directory-filter-actions">
        <button type="button" className="button secondary" aria-expanded={presetsOpen} disabled={busy || checking}
          onClick={() => setPresetsOpen((current) => !current)}>Common keywords</button>
        {mode === "load" && <button type="button" className="button secondary" disabled={busy || checking || !query} onClick={() => void apply()}>Apply filters</button>}
        {checking && <button type="button" className="button secondary" onClick={cancel}>Cancel check</button>}
      </div>
      {presetsOpen && <div className="directory-filter-presets" role="group" aria-label="Common event keywords">
        {COMMON_EVENT_KEYWORDS.map((preset) => {
          const { selected, toggledQuery } = eventKeywordPresetState(terms, preset.query);
          return <button key={preset.name} type="button" className="button secondary" disabled={busy || checking}
            aria-pressed={selected} title={preset.query} onClick={() => changeKeywords(toggledQuery)}>{preset.name}</button>;
        })}
      </div>}
      {checking && <p role="status">Checking event labels… {checked}/{total} checked.</p>}
      {error && <p role="alert">{error}</p>}
      {ready && applied && <p role="status">{applied.plan.recordings.length} of {total} sessions match.
        {applied.incomplete > 0 && ` Could not fully check ${applied.incomplete} session${applied.incomplete === 1 ? "" : "s"}. Only confirmed matches are included.`}</p>}
    </div>}
    {mode === "load" && ready && selected && selected.recordings.length > 0 && <div className="directory-import-summary directory-import-preview">
      <ul aria-label={query ? "Matching recording paths" : "Recording paths"}>{selected.recordings.slice(0, 5).map((recording) =>
        <li key={recording.id}>{recording.relativePath}</li>)}</ul>
      {selected.recordings.length > 5 && <small>And {selected.recordings.length - 5} more sessions.</small>}
    </div>}
    {(mode === "load" || open) && <footer className="directory-filter-footer">
      <span className="directory-import-local-note">{plan.supportingFiles.length ? `${plan.supportingFiles.length} companion file${plan.supportingFiles.length === 1 ? "" : "s"} found · ` : ""}Files stay on this device.</span>
      <button type="button" className="button primary" data-tutorial={mode === "load" ? "import-open" : undefined} disabled={(mode === "load" && ready && !selected?.recordings.length) || busy || checking}
        onClick={() => {
          if (busy || checking) return;
          if (!ready || !query) void apply(true);
          else if (selected && (mode === "update" || selected.recordings.length)) onLoad(selected);
        }}>
        {checking ? "Checking labels…" : busy ? "Opening…" : mode === "update" ? "Apply to folder" : query && !ready ? "Load matching sessions" : `Load ${selected?.recordings.length ?? 0} sessions`}
      </button>
    </footer>}
  </>;
}
