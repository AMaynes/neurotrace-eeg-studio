"use client";

import { useEffect, useRef, useState } from "react";
import { directoryEventCache, filterDirectoryPlan, scanDirectoryEvents } from "./directory-event-client";
import type { DirectoryImportPlan } from "./directory-import";
import { eventKeywords } from "./event-keywords";

export function DirectoryImportFilters({ plan, busy, onLoad }: {
  plan: DirectoryImportPlan;
  busy: boolean;
  onLoad: (plan: DirectoryImportPlan) => void;
}) {
  const [open, setOpen] = useState(false);
  const [keywords, setKeywords] = useState("");
  const [applied, setApplied] = useState<{ query: string; plan: DirectoryImportPlan; incomplete: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(0);
  const [sourcePlan, setSourcePlan] = useState(plan);
  const scanRef = useRef<AbortController | null>(null);
  const total = plan.recordings.length;
  const query = eventKeywords(keywords).join(", ");
  const ready = !query || applied?.query === query;
  const selected = query ? applied?.plan : plan;

  if (sourcePlan !== plan) {
    setSourcePlan(plan);
    setOpen(false);
    setKeywords("");
    setApplied(null);
    setChecking(false);
  }
  useEffect(() => () => {
    scanRef.current?.abort();
    scanRef.current = null;
  }, [plan]);

  const cancel = () => {
    scanRef.current?.abort();
    scanRef.current = null;
    setChecking(false);
  };

  const apply = async () => {
    if (!query || scanRef.current || busy) return;
    const controller = new AbortController();
    scanRef.current = controller;
    setChecking(true);
    setApplied(null);
    const cache = directoryEventCache(plan);
    let checkedCount = Object.keys(cache.entries).length;
    setChecked(checkedCount);
    let updates = 0;
    await scanDirectoryEvents(plan, controller.signal, (id) => {
      if (id !== null && ++updates % 16 !== 0) return;
      const count = Object.keys(cache.entries).length;
      if (count !== checkedCount) {
        checkedCount = count;
        setChecked(count);
      }
    }, true, true);
    if (controller.signal.aborted) return;
    const incomplete = plan.recordings.filter(({ id }) => cache.entries[id]?.state !== "ready").length;
    setApplied({ query, plan: filterDirectoryPlan(plan, query), incomplete });
    scanRef.current = null;
    setChecking(false);
  };

  return <>
    <button type="button" className="button secondary directory-import-filter-toggle" aria-expanded={open} disabled={busy}
      onClick={() => { if (open) { cancel(); setKeywords(""); setApplied(null); } setOpen(!open); }}>
      {open ? "Remove filters" : "Add filters"}
    </button>
    {open && <div className="directory-import-filter">
      <label className="label-keyword-field">Include recordings with event labels matching
        <input type="search" value={keywords} disabled={busy || checking} placeholder="e.g. seizure, spike"
          onChange={(event) => { setKeywords(event.target.value); setApplied(null); }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void apply(); } }} />
        <small>Separate keywords with commas. A recording is included if any keyword matches.</small>
      </label>
      <div className="label-display-filter-actions">
        <button type="button" disabled={busy || checking || !query} onClick={() => void apply()}>Apply filters</button>
        {checking && <button type="button" onClick={cancel}>Cancel check</button>}
      </div>
      {checking && <p role="status">Checking event labels… {checked}/{total} checked.</p>}
      {ready && applied && <p role="status">{applied.plan.recordings.length} of {total} sessions match.
        {applied.incomplete > 0 && ` Could not fully check ${applied.incomplete} session${applied.incomplete === 1 ? "" : "s"}. Only confirmed matches are included.`}</p>}
    </div>}
    {ready && selected && selected.recordings.length > 0 && <div className="directory-import-summary directory-import-preview">
      <ul aria-label={query ? "Matching recording paths" : "Recording paths"}>{selected.recordings.slice(0, 5).map((recording) =>
        <li key={recording.id}>{recording.relativePath}</li>)}</ul>
      {selected.recordings.length > 5 && <small>And {selected.recordings.length - 5} more sessions.</small>}
    </div>}
    <footer>
      <span className="directory-import-local-note">{plan.supportingFiles.length ? `${plan.supportingFiles.length} companion file${plan.supportingFiles.length === 1 ? "" : "s"} found · ` : ""}Files stay on this device.</span>
      <button type="button" className="button primary" data-tutorial="import-open" disabled={!ready || !selected?.recordings.length || busy || checking}
        onClick={() => { if (ready && selected?.recordings.length && !busy && !checking) onLoad(selected); }}>
        {checking ? "Checking labels…" : busy ? "Opening…" : query && !ready ? "Load matching sessions" : `Load ${selected?.recordings.length ?? 0} sessions`}
      </button>
    </footer>
  </>;
}
