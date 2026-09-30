"use client";

import { useState } from "react";
import type { DirectoryImportPlan, DirectoryRecording } from "./directory-import";
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

/** File-reference catalog only: selecting a folder never decodes its recordings here. */
export function DirectorySessions({ plan, busy, statuses, onOpen, onClose, onClear }: DirectorySessionsProps) {
  const [requestedPage, setRequestedPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(plan.recordings.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount - 1);
  const first = page * PAGE_SIZE;
  const visible = plan.recordings.slice(first, first + PAGE_SIZE);
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
        <p id="directory-sessions-description">Every entry must match the selected recording format. Files stay on this device and open on demand, one session at a time.</p>
      </header>
      <div className="directory-sessions-summary" role="status" aria-live="polite">
        <strong>{FORMAT_NAMES[plan.format]}</strong>
        <span>{plan.recordings.length.toLocaleString()} session{plan.recordings.length === 1 ? "" : "s"}</span>
        <span>{loadedCount.toLocaleString()} open</span>
        {errorCount > 0 && <span>{errorCount.toLocaleString()} need attention</span>}
      </div>
      <ol className="directory-sessions-list" aria-label="Recordings in directory" start={first + 1}>
        {visible.map((recording, index) => {
          const status = statuses[recording.id];
          const action = status?.state === "loaded" || status?.state === "confirmation" ? "Resume"
            : status?.state === "error" ? "Retry"
              : status?.state === "opening" ? "Opening…" : "Open";
          return <li className="directory-session-row" key={recording.id} data-recording-id={recording.id}>
            <div className="directory-session-info">
              <strong className="directory-session-path">{recording.relativePath}</strong>
              <span className="directory-session-meta">Session {(first + index + 1).toLocaleString()} · {FORMAT_NAMES[plan.format]}{plan.format === "mat-dat" ? " pair" : ""}</span>
              <span className="directory-session-state" data-state={status?.state ?? "ready"}>{status ? status.message || STATUS_LABELS[status.state] : "Ready to open"}</span>
            </div>
            <button type="button" className="button secondary" disabled={busy || status?.state === "opening"} aria-label={`${action} ${recording.relativePath}`} onClick={() => onOpen(recording)}>{action}</button>
          </li>;
        })}
      </ol>
      {pageCount > 1 && <nav className="directory-sessions-pagination" aria-label="Directory pages">
        <button type="button" className="button secondary" disabled={page === 0} aria-label="Previous sessions" onClick={() => setRequestedPage(page - 1)}>Previous</button>
        <span aria-live="polite">{(first + 1).toLocaleString()}–{Math.min(first + PAGE_SIZE, plan.recordings.length).toLocaleString()} of {plan.recordings.length.toLocaleString()} · Page {page + 1} of {pageCount}</span>
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
