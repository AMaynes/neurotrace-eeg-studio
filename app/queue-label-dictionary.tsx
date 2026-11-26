/*
Purpose: Lists and searches detected label types for queue keyword selection.
File Dependencies: app/event-keywords.ts, app/label-visibility.ts.
*/


"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { COMMON_EVENT_KEYWORDS, eventKeywordPresetState, eventKeywords } from "./event-keywords";
import type { LabelTypeOption } from "./label-visibility";

/** Displays the queue label filters with keyword entry and a bounded list of label types. */
export function QueueLabelDictionary({ options, hiddenTypes, keywords, onKeywordsChange, onChange, open, onOpenChange }: {
  open: boolean;
  onOpenChange(value: boolean): void;
  options: readonly LabelTypeOption[];
  hiddenTypes: ReadonlySet<string>;
  keywords: string;
  onKeywordsChange(value: string): void;
  onChange(value: Set<string>): void;
}) {
  const [limit, setLimit] = useState(100);
  const container = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    /** Fits the dictionary popup above or below its anchor within the viewport. */
    const fit = () => {
      const anchor = container.current?.parentElement;
      const popup = popover.current;
      if (!anchor || !popup) return;
      const bounds = anchor.getBoundingClientRect();
      const below = window.innerHeight - bounds.bottom - 12;
      const above = bounds.top - 12;
      const upwards = below < 200 && above > below;
      popup.style.top = upwards ? "auto" : "100%";
      popup.style.bottom = upwards ? "100%" : "auto";
      popup.style.maxHeight = `${Math.max(40, Math.min(330, upwards ? above : below))}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (container.current?.parentElement) observer.observe(container.current.parentElement);
    window.addEventListener("resize", fit);
    return () => { observer.disconnect(); window.removeEventListener("resize", fit); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    /** Closes the dictionary when a pointer event occurs outside it. */
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) onOpenChange(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [onOpenChange, open]);
  const terms = eventKeywords(keywords);
  const detected = options.filter((option) => option.count > 0);
  return <div className="queue-dictionary" ref={container} data-shortcut-scope="queue-dictionary"
    onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); onOpenChange(false); } }}>
    <button type="button" className="queue-mini-button" aria-label="Label dictionary" title="Common keywords and detected label types"
      data-tutorial="label-filter" aria-expanded={open} onClick={() => onOpenChange(!open)}>☷</button>
    {open && <div ref={popover} className="queue-dictionary-popover" role="region" aria-label="Label dictionary" data-tutorial="label-filter-dialog">
      <header><strong>Common keywords</strong><button type="button" aria-label="Close label dictionary" onClick={() => onOpenChange(false)}>×</button></header>
      <div className="queue-keyword-presets">{COMMON_EVENT_KEYWORDS.map((preset) => {
        const { selected, toggledQuery } = eventKeywordPresetState(terms, preset.query);
        return <button type="button" key={preset.name} aria-pressed={selected} title={preset.query}
          onClick={() => onKeywordsChange(toggledQuery)}>{preset.name}</button>;
      })}</div>
      <div className="queue-dictionary-actions">
        <strong>Detected labels</strong>
        <button type="button" data-tutorial="label-filter-reset" onClick={() => { onKeywordsChange(""); onChange(new Set()); }}>Show all</button>
      </div>
      <div className="queue-dictionary-types">{detected.slice(0, limit).map((option) =>
        <label key={option.key}><input type="checkbox" checked={!hiddenTypes.has(option.key)} onChange={(event) => {
          const next = new Set(hiddenTypes);
          if (event.target.checked) next.delete(option.key);
          else next.add(option.key);
          onChange(next);
        }} /><span title={option.name}>{option.name}</span><small>{option.count}</small></label>)}
        {detected.length > limit && <button type="button" onClick={() => setLimit((current) => current + 100)}>More labels</button>}
      </div>
    </div>}
  </div>;
}
