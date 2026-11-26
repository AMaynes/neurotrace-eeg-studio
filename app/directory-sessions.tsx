/*
Purpose: Defines directory sessions for the NeuroTrace workspace.
File Dependencies: app/directory-import-filters.tsx, app/directory-import.ts, app/directory-sessions.css.
*/


"use client";

import { useMemo, useState } from "react";
import type { DirectoryImportPlan, DirectoryRecording } from "./directory-import";
import "./directory-sessions.css";
import { DirectoryImportFilters } from "./directory-import-filters";

export type DirectorySessionStatus = {
  state: "opening" | "confirmation" | "loaded" | "error";
  message?: string;
};

type DirectorySessionsProps = {
  plan: DirectoryImportPlan;
  busy: boolean;
  statuses: Record<string, DirectorySessionStatus>;
  onOpen(recording: DirectoryRecording): void;
  onFilter?(plan: DirectoryImportPlan): void;
  reviewMode?: boolean;
  reviewProgress?(recording: DirectoryRecording): string | undefined;
  canOpen?(recording: DirectoryRecording): boolean;
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

/** Lists skipped MAT/DAT files in batches so large folders keep the dialog responsive. */
export function DirectoryPairFailures({ failures, initiallyOpen = false }: {
  failures: DirectoryImportPlan["missingCompanions"];
  initiallyOpen?: boolean;
}) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  if (!failures?.length) return null;
  return <details className="directory-pair-failures" open={initiallyOpen}>
    <summary>{failures.length.toLocaleString()} {failures.length === 1 ? "file" : "files"} skipped · missing MAT/DAT companion</summary>
    <div className="directory-pair-failures-body">
      <ul aria-label="Files missing a MAT or DAT companion">
        {failures.slice(0, visibleCount).map(({ filePath, expectedPath }) => <li key={filePath}>
          <strong>{filePath}</strong>
          <span>Missing {expectedPath}</span>
        </li>)}
      </ul>
      {visibleCount < failures.length && <button type="button" className="button secondary"
        onClick={() => setVisibleCount((current) => current + PAGE_SIZE)}>
        Show {Math.min(PAGE_SIZE, failures.length - visibleCount)} more skipped files
      </button>}
    </div>
  </details>;
}

/** On-demand session catalog with a cancellable, metadata-only event-label index. */
export function DirectorySessions({ plan, busy, statuses, onOpen, onClose, onClear, reviewMode, reviewProgress, canOpen, onFilter }: DirectorySessionsProps) {
  const fullPlan = useMemo(() => plan.unfilteredRecordings ? { ...plan, recordings: [...plan.unfilteredRecordings] } : plan, [plan]);
  const [requestedPage, setRequestedPage] = useState(0);
  const catalogBusy = busy;
  const pageCount = Math.max(1, Math.ceil(plan.recordings.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount - 1);
  const first = page * PAGE_SIZE;
  const visible = plan.recordings.slice(first, first + PAGE_SIZE).map((recording, offset) => ({ recording, index: first + offset }));
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
      <DirectoryPairFailures failures={plan.missingCompanions} />
      {onFilter && <section className="directory-folder-filters" aria-label="Folder filters">
        {plan.eventKeywordFilter && <p>Folder filter · {plan.eventKeywordFilter}</p>}
        <DirectoryImportFilters plan={fullPlan} busy={busy} mode="update" onLoad={onFilter} />
      </section>}
      <ol className="directory-sessions-list" aria-label="Recordings in directory" start={first + 1}>
        {visible.map(({ recording, index }) => {
          const status = statuses[recording.id];
          const progress = reviewProgress?.(recording);
          const locked = canOpen?.(recording) === false;
          const action = status?.state === "loaded" || status?.state === "confirmation" ? "Resume"
            : status?.state === "error" ? "Retry"
              : status?.state === "opening" ? "Opening…" : "Open";
          return <li className="directory-session-row" key={recording.id} data-recording-id={recording.id}>
            <div className="directory-session-info">
              <strong className="directory-session-path">{recording.relativePath}</strong>
              <span className="directory-session-meta">Session {(index + 1).toLocaleString()} · {FORMAT_NAMES[plan.format]}{plan.format === "mat-dat" ? " pair" : ""}</span>
              <span className="directory-session-state" data-state={status?.state ?? "ready"}>{status ? status.message || STATUS_LABELS[status.state] : "Ready to open"}</span>
              {(progress || locked) && <span className="directory-session-state">{progress}{locked ? `${progress ? " · " : ""}Locked by blind review` : ""}</span>}

            </div>
            <button type="button" className="button secondary" disabled={catalogBusy || status?.state === "opening" || locked} aria-label={`${action} ${recording.relativePath}`} onClick={() => onOpen(recording)}>{action}</button>
          </li>;
        })}
        {!visible.length && <li className="directory-event-empty">No recordings match the folder filter.</li>}
      </ol>
      {pageCount > 1 && <nav className="directory-sessions-pagination" aria-label="Directory pages">
        <button type="button" className="button secondary" disabled={page === 0} aria-label="Previous sessions" onClick={() => setRequestedPage(page - 1)}>Previous</button>
        <span aria-live="polite">{(first + 1).toLocaleString()}–{Math.min(first + PAGE_SIZE, plan.recordings.length).toLocaleString()} of {plan.recordings.length.toLocaleString()} · Page {page + 1} of {pageCount}</span>
        <button type="button" className="button secondary" disabled={page === pageCount - 1} aria-label="Next sessions" onClick={() => setRequestedPage(page + 1)}>Next</button>
      </nav>}
      <p className="directory-sessions-note">{plan.format === "neurotrace"
        ? "Projects open from their saved contents. Nearby files are not added to a project. Projects saved without recording data require the matching original recording to be opened separately."
        : "Recordings are checked as they open. MAT + DAT pairs use their companion metadata when available. Directory review state is separate from individual-file imports."}</p>
      <footer className="directory-sessions-footer">
        <span>{reviewMode ? "Review progress is kept in this browser." : "Clearing this list does not delete files or close sessions already open."}</span>
        <button type="button" className="button secondary" disabled={busy} onClick={onClear}>{reviewMode ? "Close folder" : "Clear directory list"}</button>
      </footer>
    </div>
  </div>;
}
