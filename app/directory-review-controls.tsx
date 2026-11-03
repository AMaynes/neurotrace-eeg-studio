"use client";

import { useEffect, useRef, useState } from "react";
import type { DirectoryImportPlan, DirectoryRecording } from "./directory-import";
import { directoryReviewCache, findNextDirectoryReview, isReviewCsv, loadDirectoryReviewCsvs } from "./directory-review-resume";
import { notifyTutorialAction } from "./tutorial-events";

/** Saved reviews may live beside recordings or in a separately selected output folder. */
export function DirectoryReviewControls({ plan, busy, onResume, onBusyChange, onPrepareResume }: {
  plan: DirectoryImportPlan; busy: boolean;
  onResume(recording: DirectoryRecording): void;
  onBusyChange(busy: boolean): void;
  onPrepareResume?(): void;
}) {
  const [working, setWorking] = useState(() => plan.format !== "neurotrace" && plan.supportingFiles.some(isReviewCsv));
  const [message, setMessage] = useState("");
  const [, refresh] = useState(0);
  const csvInput = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null);
  const operation = useRef<AbortController | null>(null);
  const cache = directoryReviewCache(plan);
  const supported = plan.format !== "neurotrace";
  useEffect(() => {
    if (!supported) return;
    const controller = new AbortController();
    const previousFiles = cache.files.size;
    operation.current = controller;
    void Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      setWorking(true); onBusyChange(true);
      return loadDirectoryReviewCsvs(plan, plan.supportingFiles.filter(isReviewCsv), controller.signal);
    })
      .then(() => {
        if (controller.signal.aborted) return;
        refresh(value => value + 1);
        if (cache.files.size > previousFiles) notifyTutorialAction("review-csvs-loaded");
      })
      .catch(error => { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Could not read saved reviews."); })
      .finally(() => { if (!controller.signal.aborted) { setWorking(false); onBusyChange(false); } });
    return () => { controller.abort(); operation.current?.abort(); onBusyChange(false); };
  }, [cache, onBusyChange, plan, supported]);

  const loadFiles = async (files: File[]) => {
    if (working || busy || !files.length) return;
    const controller = new AbortController(); operation.current = controller;
    const previousFiles = cache.files.size;
    setWorking(true); onBusyChange(true); setMessage("");
    try {
      await loadDirectoryReviewCsvs(plan, files, controller.signal);
      if (!controller.signal.aborted) {
        refresh(value => value + 1);
        if (cache.files.size > previousFiles) notifyTutorialAction("review-csvs-loaded");
      }
    } catch (error) { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Could not read saved reviews.");
    } finally { if (!controller.signal.aborted) { setWorking(false); onBusyChange(false); } }
  };
  const resume = async () => {
    if (working || busy) return;
    const controller = new AbortController(); operation.current = controller;
    setWorking(true); onBusyChange(true);
    try {
      onPrepareResume?.();
      const next = await findNextDirectoryReview(plan, controller.signal, file => setMessage(`Checking ${file}…`));
      if (next) { onResume(next.recording); notifyTutorialAction("directory-review-found"); }
      else setMessage("All supported seizure events in this folder have been reviewed, or no seizure events were found.");
    } catch (error) { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Could not resume review."); }
    finally { if (!controller.signal.aborted) { setWorking(false); onBusyChange(false); } }
  };
  if (!supported) return null;
  const matched = [...cache.byRecording.values()].reduce((count, rows) => count + rows.length, 0);
  return <section className="directory-review-resume" aria-label="Resume saved review">
    <strong>Continue reviewing</strong>
    <p>{cache.files.size ? `${matched} accepted reviews matched to this folder${cache.rows.length > matched ? ` · ${cache.rows.length - matched} rows unmatched or ambiguous` : ""}.` : "Saved annotation CSVs in this folder load automatically. Select CSVs or your output folder if they are stored elsewhere."}</p>
    <div className="directory-review-actions" data-tutorial="directory-review-files">
      <button type="button" className="button secondary" disabled={working || busy} onClick={() => csvInput.current?.click()}>Load saved CSVs</button>
      <button type="button" className="button secondary" disabled={working || busy} onClick={() => folderInput.current?.click()}>Choose reviews folder</button>
      <button type="button" className="button primary" data-tutorial="directory-review-resume" disabled={working || busy} onClick={() => void resume()}>Resume first unfinished event</button>
      {working && <button type="button" className="button secondary" onClick={() => { operation.current?.abort(); setWorking(false); onBusyChange(false); setMessage("Resume canceled. No recording was opened."); }}>Cancel</button>}
    </div>
    <input ref={csvInput} type="file" accept=".csv" multiple hidden aria-label="Saved annotation CSVs" onChange={event => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; void loadFiles(files); }} />
    <input ref={node => { folderInput.current = node; if (node) (node as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true; }} type="file" multiple hidden aria-label="Saved reviews folder" onChange={event => { const files = [...(event.currentTarget.files ?? [])].filter(isReviewCsv); event.currentTarget.value = ""; if (!files.length) setMessage("No *_annotations.csv files found in that folder."); else void loadFiles(files); }} />
    {message && <p role="status">{message}</p>}
    {!!cache.warnings.length && <details><summary>Some CSVs could not be loaded</summary>{cache.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
  </section>;
}
