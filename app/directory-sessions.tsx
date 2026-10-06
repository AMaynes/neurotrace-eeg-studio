"use client";

import { useEffect, useRef, useState } from "react";
import type { DirectoryImportPlan, DirectoryRecording } from "./directory-import";
import { COMMON_EVENT_KEYWORDS, createEventLabelMatcher, eventKeywords } from "./directory-event-index";
import { directoryEventCache, scanDirectoryEvents, setDirectoryEventQuery, supportsDirectoryEventSearch } from "./directory-event-client";
import "./directory-sessions.css";

export type DirectorySessionStatus = {
  state: "opening" | "confirmation" | "loaded" | "error";
  message?: string;
};

type DirectorySessionsProps = {
  plan: DirectoryImportPlan;
  busy: boolean;
  statuses: Record<string, DirectorySessionStatus>;
  onOpen(recording: DirectoryRecording): void;
  onClose(): void;
  onClear(): void;
};

const PAGE_SIZE = 50;
const FORMAT_NAMES = { edf: "EDF / EDF+", mat: "Standalone MAT", "mat-dat": "MAT + DAT", neurotrace: "NeuroTrace project" };
const STATUS_LABELS = {
  opening: "Opening…",
  confirmation: "Layout confirmation needed",
  loaded: "Open in a session tab",
  error: "Could not open this session",
};

/** On-demand session catalog with a cancellable, metadata-only event-label index. */
export function DirectorySessions({ plan, busy, statuses, onOpen, onClose, onClear }: DirectorySessionsProps) {
  const searchSupported = supportsDirectoryEventSearch(plan.format);
  const cache = directoryEventCache(plan);
  const [requestedPage, setRequestedPage] = useState(0);
  const [query, setQuery] = useState(() => cache.query);
  const [draft, setDraft] = useState("");
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [includeUnchecked, setIncludeUnchecked] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [scanGeneration, setScanGeneration] = useState(0);
  const [, refreshIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const keywordsRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (busy || !searchSupported) return;
    const controller = new AbortController();
    void scanDirectoryEvents(plan, controller.signal, (id) => {
      setChecking(id);
      refreshIndex((version) => version + 1);
    }, scanGeneration > 0);
    return () => controller.abort();
  }, [plan, busy, scanGeneration, searchSupported]);
  const changeQuery = (value: string) => {
    if (!searchSupported) return;
    setDirectoryEventQuery(plan, value);
    setQuery(value);
    setRequestedPage(0);
  };
  const keywords = searchSupported ? eventKeywords(query) : [];
  const submitKeywords = () => {
    if (busy || !searchSupported || !eventKeywords(draft).length) return;
    changeQuery(eventKeywords([...keywords, draft].join(",")).join(", "));
    setDraft("");
    searchRef.current?.focus();
  };
  const searching = keywords.length > 0;
  const matchesLabels = createEventLabelMatcher(query);
  const indexedCount = plan.recordings.filter((recording) => cache.entries[recording.id]).length;
  const uncheckedCount = plan.recordings.filter((recording) => cache.entries[recording.id]?.state !== "ready").length;
  const incompleteCount = plan.recordings.filter((recording) => cache.entries[recording.id] && cache.entries[recording.id].state !== "ready").length;
  const matches = plan.recordings.map((recording, index) => ({ recording, index })).filter(({ recording }) => !searching
    || matchesLabels(cache.entries[recording.id]?.labels ?? [])
    || (includeUnchecked && cache.entries[recording.id]?.state !== "ready"));
  const pageCount = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount - 1);
  const first = page * PAGE_SIZE;
  const visible = matches.slice(first, first + PAGE_SIZE);
  const loadedCount = plan.recordings.filter((recording) => statuses[recording.id]?.state === "loaded").length;
  const errorCount = plan.recordings.filter((recording) => statuses[recording.id]?.state === "error").length;

  return <div className="modal-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}>
    <div id="directory-sessions-dialog" className="modal directory-sessions-modal" data-tutorial="directory-list" role="dialog" aria-modal="true" aria-labelledby="directory-sessions-heading" aria-describedby="directory-sessions-description" tabIndex={-1}>
      <button type="button" className="modal-close" disabled={busy} onClick={onClose} aria-label="Close directory sessions">×</button>
      <header className="directory-sessions-heading">
        <span className="modal-eyebrow">RECORDING DIRECTORY</span>
        <h2 id="directory-sessions-heading">Directory sessions</h2>
        <p id="directory-sessions-description">Only the selected recording format is listed; other recording types are ignored. Files stay on this device and open on demand, one session at a time.</p>
      </header>
      <div className="directory-sessions-summary" role="status" aria-live="polite">
        <strong>{FORMAT_NAMES[plan.format]}</strong>
        <span>{plan.recordings.length.toLocaleString()} session{plan.recordings.length === 1 ? "" : "s"}</span>
        <span>{loadedCount.toLocaleString()} open</span>
        {errorCount > 0 && <span>{errorCount.toLocaleString()} need attention</span>}
      </div>
      <div className="directory-event-search">
        <label htmlFor="directory-event-query">Filter sessions by event label</label>
        <div className="directory-event-search-row" data-unsupported={!searchSupported || undefined}
          title={!searchSupported ? "Not supported for EDF" : undefined}
          data-shortcut-scope={searchSupported && presetsOpen ? "directory-keywords" : undefined}
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPresetsOpen(false); }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && presetsOpen) { event.preventDefault(); event.stopPropagation(); setPresetsOpen(false); keywordsRef.current?.focus(); }
          }}>
          <input id="directory-event-query" ref={searchRef} type="search" disabled={busy || !searchSupported} value={searchSupported ? draft : ""} placeholder="seizure, sz, EEG onset…" aria-describedby="directory-event-query-help" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              event.preventDefault(); event.stopPropagation(); submitKeywords();
            }
          }} />
          <button type="button" className="button secondary" disabled={busy || !searchSupported || !eventKeywords(draft).length} aria-label="Search event labels" onClick={submitKeywords}>Search</button>
          <button type="button" ref={keywordsRef} className="button secondary directory-keywords-toggle" disabled={busy || !searchSupported} aria-label="Common event keywords" aria-expanded={searchSupported && presetsOpen} aria-controls="directory-common-keywords" title={searchSupported ? "Choose common event keywords" : "Not supported for EDF"} onClick={() => setPresetsOpen((open) => !open)}>…</button>
          {searchSupported && (query || draft) && <button type="button" className="button secondary" disabled={busy} onClick={() => { changeQuery(""); setDraft(""); searchRef.current?.focus(); }} aria-label="Clear event label filter">Clear</button>}
          {searchSupported && presetsOpen && <div id="directory-common-keywords" className="directory-keywords-popover" role="group" aria-label="Common event keyword presets">
            <strong>Common keywords</strong><small>Choose keywords, then press Enter or Search to apply.</small>
            {COMMON_EVENT_KEYWORDS.map((preset) => <button type="button" disabled={busy} key={preset.name} onClick={() => { setDraft(preset.query); setPresetsOpen(false); searchRef.current?.focus(); }}><strong>{preset.name}</strong><span>{preset.query}</span></button>)}
          </div>}
        </div>
        {keywords.length > 0 && <ul className="directory-keyword-tags" aria-label="Active event keywords">
          {keywords.map((keyword) => <li key={keyword.toLowerCase()}><span>{keyword}</span><button type="button" disabled={busy} aria-label={`Remove keyword ${keyword}`} onClick={() => {
            changeQuery(keywords.filter((term) => term !== keyword).join(", "));
            searchRef.current?.focus();
          }}>×</button></li>)}
        </ul>}
        <small id="directory-event-query-help">{searchSupported
          ? "Press Enter or Search to add tags and filter event labels, not filenames. Commas separate keywords; any tag can match. Spaces stay together as a phrase. Case-insensitive."
          : "Keyword searching is not supported for EDF."}</small>
        {searchSupported && <div className="directory-event-progress" role="status" aria-live="polite">
          <span>{matches.length.toLocaleString()} of {plan.recordings.length.toLocaleString()} sessions shown · {indexedCount.toLocaleString()} checked{checking || indexedCount < plan.recordings.length ? ` · ${busy ? "checking paused" : "checking event labels…"}` : ""}</span>
          {incompleteCount > 0 && <button type="button" disabled={busy || Boolean(checking)} onClick={() => setScanGeneration((version) => version + 1)}>Retry {incompleteCount} incomplete check{incompleteCount === 1 ? "" : "s"}</button>}
        </div>}
        {searching && uncheckedCount > 0 && <label className="directory-include-unchecked"><input type="checkbox" disabled={busy} checked={includeUnchecked} onChange={(event) => { setIncludeUnchecked(event.target.checked); setRequestedPage(0); }} />Include {uncheckedCount} unchecked / partially checked sessions. Results are incomplete until these can be checked.</label>}
      </div>
      <ol className="directory-sessions-list" aria-label="Recordings in directory" start={first + 1}>
        {visible.map(({ recording, index }) => {
          const status = statuses[recording.id];
          const labelIndex = searchSupported ? cache.entries[recording.id] : undefined;
          const matchingLabels = labelIndex?.labels.filter((label) => !searching || matchesLabels([label])) ?? [];
          const action = status?.state === "loaded" || status?.state === "confirmation" ? "Resume"
            : status?.state === "error" ? "Retry"
              : status?.state === "opening" ? "Opening…" : "Open";
          return <li className="directory-session-row" key={recording.id} data-recording-id={recording.id}>
            <div className="directory-session-info">
              <strong className="directory-session-path">{recording.relativePath}</strong>
              <span className="directory-session-meta">Session {(index + 1).toLocaleString()} · {FORMAT_NAMES[plan.format]}{plan.format === "mat-dat" ? " pair" : ""}</span>
              <span className="directory-session-state" data-state={status?.state ?? "ready"}>{status ? status.message || STATUS_LABELS[status.state] : "Ready to open"}</span>
              {searchSupported && <span className="directory-session-events" title={matchingLabels.join(" · ")}>{matchingLabels.length ? `Events: ${matchingLabels.slice(0, 3).join(" · ")}${matchingLabels.length > 3 ? ` · +${matchingLabels.length - 3} more` : ""}` : labelIndex?.state === "ready" ? "No supported event labels found" : checking === recording.id && !busy ? "Checking event labels…" : "Event labels not fully checked"}</span>}
              {!!labelIndex?.warnings.length && <details className="directory-event-warning"><summary>Event-label check incomplete</summary>{labelIndex.warnings.map((warning) => <p key={warning}>{warning}</p>)}</details>}
            </div>
            <button type="button" className="button secondary" disabled={busy || status?.state === "opening"} aria-label={`${action} ${recording.relativePath}`} onClick={() => onOpen(recording)}>{action}</button>
          </li>;
        })}
        {!visible.length && <li className="directory-event-empty">{uncheckedCount ? "No matches found yet. Some sessions have not been fully checked." : "No sessions contain these event-label keywords."}</li>}
      </ol>
      {pageCount > 1 && <nav className="directory-sessions-pagination" aria-label="Directory pages">
        <button type="button" className="button secondary" disabled={page === 0} aria-label="Previous sessions" onClick={() => setRequestedPage(page - 1)}>Previous</button>
        <span aria-live="polite">{(first + 1).toLocaleString()}–{Math.min(first + PAGE_SIZE, matches.length).toLocaleString()} of {matches.length.toLocaleString()} · Page {page + 1} of {pageCount}</span>
        <button type="button" className="button secondary" disabled={page === pageCount - 1} aria-label="Next sessions" onClick={() => setRequestedPage(page + 1)}>Next</button>
      </nav>}
      <p className="directory-sessions-note">{plan.format === "neurotrace"
        ? "Projects open from their saved contents. Nearby files are not added to a project. Projects saved without recording data require the matching original recording to be opened separately."
        : "The directory is checked for matching file types and complete pairs. Recording contents are verified when opened; MAT + DAT sessions still require layout confirmation. Directory review state is separate from individual-file imports."}</p>
      <footer className="directory-sessions-footer">
        <span>Clearing this list does not delete files or close sessions already open.</span>
        <button type="button" className="button secondary" disabled={busy} onClick={onClear}>Clear directory list</button>
      </footer>
    </div>
  </div>;
}
