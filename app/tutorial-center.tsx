"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { subscribeTutorialActions, type TutorialAssistAction } from "./tutorial-events";
import "./tutorial-center.css";
import {
  placeTutorialCoach,
  clampTutorialCoachPosition,
  tutorialBlockReason,
  tutorialLessons,
  tutorialTabIndex,
  tutorialTopics,
  type TutorialRect,
  type TutorialCoachPosition,
  type TutorialReveal,
  type TutorialStep,
  type TutorialTopic,
} from "./tutorials";

type TutorialCenterProps = {
  open: boolean;
  topic: TutorialTopic;
  hasRecording: boolean;
  canAnnotate: boolean;
  sessionId: string;
  onAssist(action: TutorialAssistAction): boolean;
  onTopicChange(topic: TutorialTopic): void;
  onClose(): void;
  onOpen(): void;
  onReveal(area: TutorialReveal): void;
};

type Tour = { lessonId: string; stepIndex: number };
type TourSurface = { host: HTMLElement; rect: TutorialRect | null; fallback: boolean; ready: boolean; dialogName: string | null; viewport: { width: number; height: number } };

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
    && a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height
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
        viewport: { width: window.innerWidth, height: window.innerHeight },
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
    document.addEventListener("animationend", schedule, true);
    document.addEventListener("animationcancel", schedule, true);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("transitionend", schedule, true);
      document.removeEventListener("animationend", schedule, true);
      document.removeEventListener("animationcancel", schedule, true);
    };
  }, [active, step]);
  return active ? surface : null;
}

export function TutorialCenter({ open, topic, hasRecording, canAnnotate, sessionId, onAssist, onTopicChange, onClose, onOpen, onReveal }: TutorialCenterProps) {
  const [selectedId, setSelectedId] = useState(tutorialLessons[0].id);
  const [preview, setPreview] = useState<{ lessonId: string; index: number } | null>(null);
  const [tour, setTour] = useState<Tour | null>(null);
  const [completed, setCompleted] = useState<Set<string>>(() => new Set());
  const [coachSize, setCoachSize] = useState({ width: 360, height: 320 });
  const [coachPosition, setCoachPosition] = useState<TutorialCoachPosition | null>(null);
  const [assistFailure, setAssistFailure] = useState<Tour | null>(null);
  const coachRef = useRef<HTMLElement>(null);
  const coachDragRef = useRef<{ pointerId: number; grabX: number; grabY: number; width: number } | null>(null);
  const advancedTourRef = useRef<Tour | null>(null);
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
    if (open || tourBlock || !tour || !activeLesson || !activeStep?.completeOn) return;
    const expectedTour = tour;
    return subscribeTutorialActions(activeStep.completeOn, () => {
      if (advancedTourRef.current === expectedTour) return;
      advancedTourRef.current = expectedTour;
      const nextIndex = Math.min(activeLesson.steps.length, expectedTour.stepIndex + 1);
      setTour((current) => current === expectedTour ? { ...current, stepIndex: nextIndex } : current);
      if (nextIndex === activeLesson.steps.length) setCompleted((current) => new Set([...current, activeLesson.id]));
    });
  }, [open, tourBlock, tour, activeLesson, activeStep, sessionId]);

  useEffect(() => () => { coachDragRef.current = null; }, [open, surface?.host]);

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
    advancedTourRef.current = tour;
    setTour(null);
    // Do not strand keyboard focus on a removed floating guide.
    if (!embedded) document.querySelector<HTMLElement>("[data-tutorial='help']")?.focus();
    else surface?.host.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  };
  const openLibrary = () => {
    advancedTourRef.current = tour;
    if (activeLesson) {
      onTopicChange(activeLesson.topic);
      setSelectedId(activeLesson.id);
    }
    setTour(null);
    onOpen();
  };
  const advance = () => {
    if (!tour || !activeLesson || advancedTourRef.current === tour) return;
    advancedTourRef.current = tour;
    const nextIndex = Math.min(activeLesson.steps.length, tour.stepIndex + 1);
    setTour({ ...tour, stepIndex: nextIndex });
    if (nextIndex === activeLesson.steps.length) setCompleted((current) => new Set([...current, activeLesson.id]));
  };

  const moveCoach = (left: number, top: number, width: number) => {
    const height = coachRef.current?.getBoundingClientRect().height ?? coachSize.height;
    setCoachPosition(clampTutorialCoachPosition({ left, top, width }, { width: window.innerWidth, height: window.innerHeight }, height));
  };
  const dragCoach = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = coachDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    moveCoach(event.clientX - drag.grabX, event.clientY - drag.grabY, drag.width);
  };
  const stopDraggingCoach = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (coachDragRef.current?.pointerId !== event.pointerId) return;
    coachDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const resetCoachPosition = () => {
    coachDragRef.current = null;
    setCoachPosition(null);
    // The reset button disappears; leave focus on the persistent drag handle.
    coachRef.current?.querySelector<HTMLButtonElement>(".tutorial-drag-handle")?.focus({ preventScroll: true });
  };
  const coachStyle: CSSProperties | undefined = surface && coachPosition ? {
    ...clampTutorialCoachPosition(coachPosition, surface.viewport, coachSize.height),
    maxHeight: surface.viewport.height - 24,
  } : !embedded && surface ? { ...placeTutorialCoach(
    surface.viewport,
    { width: 360, height: Math.max(260, coachSize.height) },
    surface.rect,
  ), maxHeight: surface.viewport.height - 24 } : undefined;

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
          <div><p>Steps advance when you complete the action. “Do it for me” can open tools or adjust the view. You choose files, labels, and final saves. Workspace actions are real.</p>
            {blockReason && <p className="tutorial-prerequisite" role="status">{blockReason}</p>}</div>
          <button className="button primary tutorial-start" disabled={Boolean(blockReason)} onClick={() => {
            advancedTourRef.current = tour;
            resetCoachPosition();
            setTour({ lessonId: selected.id, stepIndex: 0 });
            onClose();
          }}>{completed.has(selected.id) ? "Replay walkthrough" : "Start walkthrough"}<span aria-hidden="true"> →</span></button>
        </footer>
      </div>
    </div>}
    {surface && activeLesson && tour && createPortal(<>
      <section
        ref={coachRef}
        className={`tutorial-coach ${embedded ? "tutorial-coach-embedded" : ""} ${coachPosition ? "tutorial-coach-manual" : ""}`}
        style={coachStyle}
        aria-label={`${activeLesson.title} walkthrough`}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); endTour(); } }}
      >
        <header>
          <button
            className="tutorial-drag-handle"
            aria-label="Move walkthrough panel"
            title="Drag to move · Arrow keys to nudge · Home to reset position"
            onPointerDown={(event) => {
              if (event.button !== 0 || !event.isPrimary) return;
              const rect = coachRef.current?.getBoundingClientRect();
              if (!rect) return;
              event.preventDefault();
              event.currentTarget.focus({ preventScroll: true });
              event.currentTarget.setPointerCapture(event.pointerId);
              coachDragRef.current = { pointerId: event.pointerId, grabX: event.clientX - rect.left, grabY: event.clientY - rect.top, width: rect.width };
              moveCoach(rect.left, rect.top, rect.width);
            }}
            onPointerMove={dragCoach}
            onPointerUp={(event) => { dragCoach(event); stopDraggingCoach(event); }}
            onPointerCancel={stopDraggingCoach}
            onLostPointerCapture={stopDraggingCoach}
            onKeyDown={(event) => {
              if (event.key === "Home") { event.preventDefault(); resetCoachPosition(); return; }
              const delta = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[event.key];
              const rect = coachRef.current?.getBoundingClientRect();
              if (!delta || !rect) return;
              event.preventDefault();
              event.stopPropagation();
              const distance = event.shiftKey ? 40 : 10;
              moveCoach(rect.left + delta[0] * distance, rect.top + delta[1] * distance, rect.width);
            }}
          ><span aria-hidden="true">⠿</span><span>{activeStep ? `STEP ${tour.stepIndex + 1} OF ${activeLesson.steps.length}` : "WALKTHROUGH COMPLETE"}</span><small>Drag to move</small></button>
          {coachPosition && <button aria-label="Reset walkthrough position" title="Reset position" onClick={resetCoachPosition}>↺</button>}
          <button aria-label="End walkthrough" title="End walkthrough" onClick={endTour}>×</button>
        </header>
        <div className="tutorial-progress" aria-hidden="true">{activeLesson.steps.map((step, index) => <i key={step.title} className={index <= tour.stepIndex ? "active" : ""} />)}</div>
        <div className="tutorial-coach-copy" aria-live="polite" aria-atomic="true">
          <span className="tutorial-coach-lesson">{activeLesson.title}</span>
          <h3>{activeStep?.title ?? "You’ve reached the end."}</h3>
          <p>{surface.ready ? "That area is already open. Select Next to continue." : activeStep?.instruction ?? "Replay whenever you need a refresher, or choose another lesson. This completes the guide, not a save or commit."}</p>
          {activeStep?.tip && <p className="tutorial-tip">{activeStep.tip}</p>}
          {tourBlock && <p className="tutorial-prerequisite">{tourBlock}</p>}
          {activeStep && !tourBlock && !surface.ready && (!surface.rect || surface.fallback) && <p className="tutorial-prerequisite">{embedded && !surface.rect ? `Close ${surface.dialogName} to continue in the workspace. ` : ""}{activeStep.unavailable}</p>}
        </div>
        {activeStep?.assist && !tourBlock && (!embedded || surface.ready) && <div className="tutorial-assistance">
          <button className="tutorial-do" onClick={() => {
            if (!onAssist(activeStep.assist!.action)) { setAssistFailure(tour); return; }
            setAssistFailure(null);
            // Opening a chooser/revealing a reading step is assistance, not completion.
            if (activeStep.completeOn && activeStep.assist!.completesStep !== false) advance();
          }}>Do it for me</button>
          <small>{activeStep.assist.description}</small>
          {assistFailure === tour && <small role="status">This action is unavailable here. Show the highlighted area, or select Next to continue.</small>}
        </div>}
        {activeStep && <p className="tutorial-advance-hint">{activeStep.completeOn ? "Advances automatically when done · Next skips this step" : "Read this step, then select Next"}</p>}
        {activeStep?.reveal && !surface.rect && !embedded && !tourBlock && <button className="tutorial-reveal" onClick={() => {
          onReveal(activeStep.reveal!);
          // Wait for the requested panel to mount before bringing an offscreen control into view.
          requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-tutorial="${activeStep.target}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
        }}>Show this area</button>}
        <footer>
          <button className="tutorial-library-link" disabled={embedded} title={embedded ? "Close this dialog first to return to tutorials" : "Choose another lesson"} onClick={openLibrary}>All tutorials</button>
          <div><button disabled={tour.stepIndex === 0} onClick={() => { advancedTourRef.current = tour; setTour({ ...tour, stepIndex: Math.max(0, tour.stepIndex - 1) }); }}>Back</button>
            {activeStep ? <button className="tutorial-next" onClick={advance}>Next →</button> : <button className="tutorial-next" onClick={endTour}>Done</button>}</div>
        </footer>
      </section>
    </>, surface.host)}
    {surface?.rect && activeStep && !tourBlock && createPortal(<div className="tutorial-spotlight" aria-hidden="true" style={surface.rect} />, embedded ? surface.host.closest(".modal-backdrop") ?? document.body : document.body)}
  </>;
}
