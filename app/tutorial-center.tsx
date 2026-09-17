"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import "./tutorial-center.css";
import {
  placeTutorialCoach,
  tutorialBlockReason,
  tutorialLessons,
  tutorialTabIndex,
  tutorialTopics,
  type TutorialRect,
  type TutorialReveal,
  type TutorialStep,
  type TutorialTopic,
} from "./tutorials";

type TutorialCenterProps = {
  open: boolean;
  topic: TutorialTopic;
  hasRecording: boolean;
  canAnnotate: boolean;
  onTopicChange(topic: TutorialTopic): void;
  onClose(): void;
  onOpen(): void;
  onReveal(area: TutorialReveal): void;
};

type Tour = { lessonId: string; stepIndex: number };
type TourSurface = { host: HTMLElement; rect: TutorialRect | null; fallback: boolean; ready: boolean; dialogName: string | null };

/** Measure only the visible part of a target, including clipping by collapsed/scrolling panels. */
function visibleTargetRect(element: HTMLElement): TutorialRect | null {
  if (!element.getClientRects().length || getComputedStyle(element).visibility === "hidden") return null;
  const bounds = element.getBoundingClientRect();
  let left = Math.max(0, bounds.left);
  let top = Math.max(0, bounds.top);
  let right = Math.min(window.innerWidth, bounds.right);
  let bottom = Math.min(window.innerHeight, bounds.bottom);
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const rect = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      left = Math.max(left, rect.left);
      right = Math.min(right, rect.right);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
    }
  }
  return right - left > 2 && bottom - top > 2 ? { left, top, width: right - left, height: bottom - top } : null;
}

function sameSurface(a: TourSurface | null, b: TourSurface): boolean {
  return a?.host === b.host && a.fallback === b.fallback && a.ready === b.ready && a.dialogName === b.dialogName
    && JSON.stringify(a.rect) === JSON.stringify(b.rect);
}

/** Follow mounted controls without polling or changing the user's selection, files, or annotations. */
function useTourSurface(step: TutorialStep | undefined, active: boolean) {
  const [surface, setSurface] = useState<TourSurface | null>(null);
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    let observed: HTMLElement | null = null;
    const resize = new ResizeObserver(() => schedule());
    const update = () => {
      frame = 0;
      // Embed the coach in any open dialog so it stays inside the existing modal focus trap.
      const dialogs = [...document.querySelectorAll<HTMLElement>(".modal-backdrop [role='dialog']")];
      const dialog = dialogs.at(-1) ?? null;
      const scope = dialog ?? document;
      const find = (anchor?: string) => anchor
        ? scope.querySelector<HTMLElement>(`[data-tutorial="${anchor}"]`) ?? (dialog?.dataset.tutorial === anchor ? dialog : null)
        : null;
      const readyTarget = find(step?.readyTarget);
      const readyRect = readyTarget ? visibleTargetRect(readyTarget) : null;
      const target = find(step?.target);
      const fallback = !target ? find(step?.fallback) : null;
      const element = readyRect ? readyTarget : target ?? fallback;
      if (element !== observed) {
        if (observed) resize.unobserve(observed);
        if (element) resize.observe(element);
        observed = element;
      }
      const next: TourSurface = {
        host: dialog ?? document.body,
        rect: element ? visibleTargetRect(element) : null,
        fallback: Boolean(fallback),
        ready: Boolean(readyRect),
        dialogName: dialog?.getAttribute("aria-label") ?? null,
      };
      setSurface((current) => sameSurface(current, next) ? current : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "hidden", "open"] });
    resize.observe(document.body);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    // CSS panel transitions may finish after the initial measurement.
    document.addEventListener("transitionend", schedule, true);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("transitionend", schedule, true);
    };
  }, [active, step]);
  return active ? surface : null;
}

export function TutorialCenter({ open, topic, hasRecording, canAnnotate, onTopicChange, onClose, onOpen, onReveal }: TutorialCenterProps) {
  const [selectedId, setSelectedId] = useState(tutorialLessons[0].id);
  const [preview, setPreview] = useState<{ lessonId: string; index: number } | null>(null);
  const [tour, setTour] = useState<Tour | null>(null);
  const [completed, setCompleted] = useState<Set<string>>(() => new Set());
  const [coachSize, setCoachSize] = useState({ width: 360, height: 320 });
  const coachRef = useRef<HTMLElement>(null);
  const lessons = tutorialLessons.filter((lesson) => lesson.topic === topic);
  const selected = lessons.find((lesson) => lesson.id === selectedId) ?? lessons[0];
  const previewIndex = preview?.lessonId === selected.id ? preview.index : 0;
  const previewStep = selected.steps[previewIndex];
  const blockReason = tutorialBlockReason(selected, hasRecording, canAnnotate);
  const activeLesson = tour ? tutorialLessons.find((lesson) => lesson.id === tour.lessonId) : null;
  const activeStep = activeLesson && tour ? activeLesson.steps[tour.stepIndex] : undefined;
  const tourBlock = activeLesson ? tutorialBlockReason(activeLesson, hasRecording, canAnnotate) : null;
  const surface = useTourSurface(activeStep, Boolean(tour) && !open);
  const embedded = Boolean(surface?.dialogName);

  useEffect(() => {
    const coach = coachRef.current;
    if (!coach || !surface || open) return;
    const resize = new ResizeObserver(() => {
      const { width, height } = coach.getBoundingClientRect();
      setCoachSize((current) => current.width === width && current.height === height ? current : { width, height });
    });
    resize.observe(coach);
    return () => resize.disconnect();
  }, [open, surface?.host, surface]);

  const endTour = () => {
    setTour(null);
    // Do not strand keyboard focus on a removed floating guide.
    if (!embedded) document.querySelector<HTMLElement>("[data-tutorial='help']")?.focus();
    else surface?.host.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  };
  const openLibrary = () => {
    if (activeLesson) {
      onTopicChange(activeLesson.topic);
      setSelectedId(activeLesson.id);
    }
    setTour(null);
    onOpen();
  };
  const advance = () => {
    if (!tour || !activeLesson) return;
    const nextIndex = Math.min(activeLesson.steps.length, tour.stepIndex + 1);
    setTour({ ...tour, stepIndex: nextIndex });
    if (nextIndex === activeLesson.steps.length) setCompleted((current) => new Set([...current, activeLesson.id]));
  };

  const coachStyle: CSSProperties | undefined = !embedded && surface ? { ...placeTutorialCoach(
    { width: window.innerWidth, height: window.innerHeight },
    { width: 360, height: Math.max(260, coachSize.height) },
    surface.rect,
  ), maxHeight: window.innerHeight - 24 } : undefined;

  return <>
    {open && <div className="modal-backdrop tutorial-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal tutorial-hub" role="dialog" aria-modal="true" aria-label="Help" aria-labelledby="tutorial-title" tabIndex={-1}>
        <button className="modal-close" onClick={onClose} aria-label="Close Help">×</button>
        <header className="tutorial-header">
          <span className="modal-eyebrow">NEUROTRACE / LEARN BY DOING</span>
          <h2 id="tutorial-title">What would you like to do?</h2>
          <p>Pick a lesson. Follow it step by step in your workspace, at your own pace.</p>
          <span className="tutorial-session-progress">{completed.size} / {tutorialLessons.length} walkthroughs completed this visit</span>
          {tour && <button className="tutorial-resume" onClick={onClose}>Resume: {activeLesson?.title} →</button>}
        </header>
        <div className="tutorial-tabs" role="tablist" aria-label="Tutorial topics">
          {tutorialTopics.map((item, index) => <button
            key={item.id} id={`tutorial-tab-${item.id}`} role="tab" aria-selected={topic === item.id}
            aria-controls="tutorial-topic-panel" tabIndex={topic === item.id ? 0 : -1}
            onClick={() => onTopicChange(item.id)}
            onKeyDown={(event) => {
              const next = tutorialTabIndex(event.key, index);
              if (next === null) return;
              event.preventDefault();
              onTopicChange(tutorialTopics[next].id);
              document.getElementById(`tutorial-tab-${tutorialTopics[next].id}`)?.focus();
            }}
          ><span aria-hidden="true">{item.icon}</span>{item.title}</button>)}
        </div>
        <div className="tutorial-topic-panel" id="tutorial-topic-panel" role="tabpanel" aria-labelledby={`tutorial-tab-${topic}`}>
          <nav className="tutorial-lesson-list" aria-label="Lessons">
            <span className="tutorial-section-label">CHOOSE A WALKTHROUGH</span>
            {lessons.map((lesson) => <button key={lesson.id} aria-pressed={selected.id === lesson.id} onClick={() => setSelectedId(lesson.id)}>
              <span className="tutorial-lesson-heading"><strong>{lesson.title}</strong>{completed.has(lesson.id) && <span aria-label="Walkthrough completed">✓</span>}</span>
              <span>{lesson.description}</span>
              <small>{lesson.steps.length} steps · About {lesson.duration}</small>
            </button>)}
          </nav>
          <section className="tutorial-detail" aria-label={selected.title}>
            <span className="tutorial-section-label">YOUR MISSION</span>
            <h3>{selected.title}</h3>
            <p>{selected.description}</p>
            <ol className="tutorial-step-list" aria-label="Preview lesson steps">
              {selected.steps.map((step, index) => <li key={step.title}><button
                aria-current={index === previewIndex ? "step" : undefined}
                onClick={() => setPreview({ lessonId: selected.id, index })}
              ><span>{index + 1}</span>{step.title}</button></li>)}
            </ol>
            <div className="tutorial-step-preview" aria-live="polite">
              <strong>{previewStep.title}</strong>
              <p>{previewStep.instruction}</p>
              {previewStep.tip && <p className="tutorial-tip">{previewStep.tip}</p>}
            </div>
          </section>
        </div>
        <footer className="tutorial-footer">
          <div><p>You stay in control. Guides never load files, create labels, or save changes for you. Actions you take in the workspace are real.</p>
            {blockReason && <p className="tutorial-prerequisite" role="status">{blockReason}</p>}</div>
          <button className="button primary tutorial-start" disabled={Boolean(blockReason)} onClick={() => {
            setTour({ lessonId: selected.id, stepIndex: 0 });
            onClose();
          }}>{completed.has(selected.id) ? "Replay walkthrough" : "Start walkthrough"}<span aria-hidden="true"> →</span></button>
        </footer>
      </div>
    </div>}
    {surface && activeLesson && tour && createPortal(<>
      <section
        ref={coachRef}
        className={`tutorial-coach ${embedded ? "tutorial-coach-embedded" : ""}`}
        style={coachStyle}
        aria-label={`${activeLesson.title} walkthrough`}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); endTour(); } }}
      >
        <header><span>{activeStep ? `STEP ${tour.stepIndex + 1} OF ${activeLesson.steps.length}` : "WALKTHROUGH COMPLETE"}</span><button aria-label="End walkthrough" title="End walkthrough" onClick={endTour}>×</button></header>
        <div className="tutorial-progress" aria-hidden="true">{activeLesson.steps.map((step, index) => <i key={step.title} className={index <= tour.stepIndex ? "active" : ""} />)}</div>
        <div className="tutorial-coach-copy" aria-live="polite" aria-atomic="true">
          <span className="tutorial-coach-lesson">{activeLesson.title}</span>
          <h3>{activeStep?.title ?? "You’ve reached the end."}</h3>
          <p>{surface.ready ? "That area is open. Keep it open and select Next to continue." : activeStep?.instruction ?? "Replay whenever you need a refresher, or choose another lesson. This completes the guide, not a save or commit."}</p>
          {activeStep?.tip && <p className="tutorial-tip">{activeStep.tip}</p>}
          {tourBlock && <p className="tutorial-prerequisite">{tourBlock}</p>}
          {activeStep && !tourBlock && !surface.ready && (!surface.rect || surface.fallback) && <p className="tutorial-prerequisite">{embedded && !surface.rect ? `Close ${surface.dialogName} to continue in the workspace. ` : ""}{activeStep.unavailable}</p>}
        </div>
        {activeStep?.reveal && !surface.rect && !embedded && !tourBlock && <button className="tutorial-reveal" onClick={() => {
          onReveal(activeStep.reveal!);
          // Wait for the requested panel to mount before bringing an offscreen control into view.
          requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-tutorial="${activeStep.target}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
        }}>Show this area</button>}
        <footer>
          <button className="tutorial-library-link" disabled={embedded} title={embedded ? "Close this dialog first to return to tutorials" : "Choose another lesson"} onClick={openLibrary}>All tutorials</button>
          <div><button disabled={tour.stepIndex === 0} onClick={() => setTour({ ...tour, stepIndex: Math.max(0, tour.stepIndex - 1) })}>Back</button>
            {activeStep ? <button className="tutorial-next" onClick={advance}>Next →</button> : <button className="tutorial-next" onClick={endTour}>Done</button>}</div>
        </footer>
      </section>
    </>, surface.host)}
    {surface?.rect && activeStep && !tourBlock && createPortal(<div className="tutorial-spotlight" aria-hidden="true" style={surface.rect} />, document.body)}
  </>;
}
