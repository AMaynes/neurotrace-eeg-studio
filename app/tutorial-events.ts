/**
 * Semantic, payload-free tutorial notifications from completed workspace actions.
 * These never execute commands or contain recording/annotation data. The coach
 * listens only during a live step and consumes at most one match per subscription.
 */
export type TutorialAction =
  | "import-opened" | "import-format-chosen" | "import-files-ready" | "recording-opened"
  | "overview-jumped" | "waveform-panned" | "transport-used" | "window-applied"
  | "waveform-zoom-enabled" | "waveform-zoom-disabled" | "waveform-zoomed"
  | "channels-opened" | "channels-closed" | "montage-changed" | "gain-changed"
  | "clamp-changed" | "filters-opened" | "spectrogram-opened" | "channel-focused"
  | "channel-focus-cleared" | "spectrogram-adjusted" | "spectrogram-browse"
  | "spectrogram-zoom-tool" | "spectrogram-zoomed" | "spectrogram-panned"
  | "label-panel-opened" | "time-selected" | "ephys-label-added" | "annotation-inspected"
  | "label-picker-opened" | "label-picker-closed" | "session-label-picker-opened"
  | "labels-toggled" | "save-opened" | "save-options-changed" | "project-saved";

/** Allowlisted view-only assistance. File, label, montage and save choices stay manual. */
export type TutorialAssistAction =
  | "open-import" | "open-save" | "show-recording-panel" | "show-label-panel" | "show-label-tracks"
  | "jump-overview" | "pan-waveform" | "page-forward" | "shorten-window"
  | "enable-waveform-zoom" | "disable-waveform-zoom" | "zoom-waveform" | "open-channels"
  | "increase-gain" | "toggle-clamp" | "open-filters" | "open-spectrogram"
  | "clear-channel-focus" | "spectrogram-browse" | "spectrogram-zoom-tool" | "spectrogram-reset"
  | "select-time-window" | "open-label-picker" | "open-session-label-picker" | "toggle-labels";

const EVENT_NAME = "neurotrace:tutorial-action";

/** Call after an operation succeeds, never merely when a file/save request starts. */
export function notifyTutorialAction(action: TutorialAction): void {
  if (typeof document !== "undefined") document.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: action }));
}

/** One event cannot cascade through multiple steps, even if handlers emit twice. */
export function subscribeTutorialActions(actions: readonly TutorialAction[], complete: () => void, target: EventTarget = document): () => void {
  let consumed = false;
  const listener = (event: Event) => {
    if (consumed || !actions.includes((event as CustomEvent<TutorialAction>).detail)) return;
    consumed = true;
    complete();
  };
  target.addEventListener(EVENT_NAME, listener);
  return () => { consumed = true; target.removeEventListener(EVENT_NAME, listener); };
}
