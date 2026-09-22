import type { TutorialAction, TutorialAssistAction } from "./tutorial-events";

/** Task-based help with explicit completion signals and opt-in, view-only assistance. */
export const tutorialTopics = [
  { id: "start", title: "Get started", icon: "01" },
  { id: "navigate", title: "Navigate", icon: "02" },
  { id: "channels", title: "Channels", icon: "03" },
  { id: "spectrogram", title: "Spectrogram", icon: "04" },
  { id: "labels", title: "Labels", icon: "05" },
  { id: "save", title: "Save & reopen", icon: "06" },
] as const;

export type TutorialTopic = typeof tutorialTopics[number]["id"];
export type TutorialReveal = "recording-panel" | "label-panel" | "spectrogram" | "label-tracks";
export type TutorialStep = {
  title: string;
  instruction: string;
  target: string;
  fallback?: string;
  readyTarget?: string;
  unavailable: string;
  reveal?: TutorialReveal;
  tip?: string;
  completeOn?: readonly TutorialAction[];
  assist?: { action: TutorialAssistAction; description: string; completesStep?: boolean };
};
export type TutorialLesson = {
  id: string;
  topic: TutorialTopic;
  title: string;
  description: string;
  duration: string;
  requires: "workspace" | "recording" | "review";
  steps: readonly TutorialStep[];
};

export const tutorialLessons: readonly TutorialLesson[] = [
  {
    id: "load-recording", topic: "start", title: "Open a recording", duration: "2 min", requires: "workspace",
    description: "Choose the right file format and get your signal on screen.",
    steps: [
      { completeOn: ["import-opened"], assist: { action: "open-import", description: "Open the recording loader." }, title: "Open the file loader", target: "upload", readyTarget: "import", instruction: "Click Upload at the top right. This opens the recording loader; it does not upload your files to a server.", unavailable: "Close any other dialog to reach Upload.", tip: "Session tabs keep separate workspaces. Use + first if you want a new, blank session." },
      { completeOn: ["import-format-chosen"], title: "Choose your format", target: "import-formats", fallback: "upload", instruction: "Choose EDF / EDF+, MAT v5, MAT + DAT, or NeuroTrace. For a legacy metadata MAT with separate signal bytes, choose MAT + DAT.", unavailable: "Click Upload to open the format choices." },
      { completeOn: ["import-files-ready"], title: "Supply the requested files", target: "import-files", fallback: "upload", instruction: "Choose the file in each required row. MAT + DAT needs both files. If a DAT layout form appears, confirm the channel count, sample rate, and sample format against your recording metadata.", unavailable: "Open Upload and choose a format first.", tip: "Do not guess DAT layout or calibration. Incorrect settings can produce plausible-looking but incorrect traces." },
      { completeOn: ["recording-opened"], title: "Open and check the recording", target: "import-open", fallback: "import", instruction: "Use the loader’s Open button when the required files are ready. Once the waveform appears, check the channel names, units, and duration. Close the loader if it remains open.", unavailable: "Open Upload to finish choosing your files.", tip: "A window may appear while file validation or overview indexing is still running. The loading status tells you what remains." },
    ],
  },
  {
    id: "workspace", topic: "start", title: "Find your way around", duration: "1 min", requires: "recording",
    description: "Meet the recording panel, signal tools, and labeling area.",
    steps: [
      { title: "Session tabs", target: "sessions", instruction: "Each top tab is an independent workspace. Switch tabs to return to another session; + creates a blank one.", unavailable: "Close any open dialog to see the session tabs." },
      { assist: { action: "show-recording-panel", description: "Show the recording panel." }, title: "Recording info and queue", target: "recording-panel", reveal: "recording-panel", instruction: "The left panel holds recording information, whole-session labels, and the instance queue. Queue entries jump to their time in the recording.", unavailable: "Show the left recording panel to see these tools." },
      { title: "Signal tools", target: "signal-tools", instruction: "The toolbar controls montage, filters, time window, gain, and trace display. These adjust the view; they do not rewrite raw samples.", unavailable: "Return to a session with a waveform." },
      { completeOn: ["label-panel-opened"], assist: { action: "show-label-panel", description: "Show the labeling panel." }, title: "Labeling tools", target: "label-panel", reveal: "label-panel", instruction: "The right panel holds timed context and ePhys labels. Use the panel buttons in Signal tools whenever you need more room for the waveform.", unavailable: "Show the Labeling tools panel." },
    ],
  },
  {
    id: "pan-time", topic: "navigate", title: "Move through time", duration: "1 min", requires: "recording",
    description: "Jump, pan, and page without losing your place.",
    steps: [
      { completeOn: ["overview-jumped"], assist: { action: "jump-overview", description: "Jump forward by one window (backward at the end)." }, title: "Jump from the overview", target: "overview", instruction: "Click the Full session overview to jump to a different part of the recording. Its highlighted section shows the current window.", unavailable: "Return to the recording view to see the overview." },
      { completeOn: ["waveform-panned"], assist: { action: "pan-waveform", description: "Pan by one second." }, title: "Pan the waveform", target: "waveform", instruction: "Use the mouse wheel or trackpad over the waveform to move through time. Left/Right arrows move one second; hold Shift for ten seconds.", unavailable: "Load a recording and enable at least one channel.", tip: "Keyboard navigation works when you are not typing in a field or focused on a toolbar button." },
      { completeOn: ["transport-used"], assist: { action: "page-forward", description: "Move by one window, without starting playback." }, title: "Page or play", target: "transport", instruction: "Use ‹ and › to move by a full window. Play advances through the recording; click Pause when you are done.", unavailable: "Return to the waveform toolbar." },
    ],
  },
  {
    id: "zoom-waveform", topic: "navigate", title: "Zoom into a waveform", duration: "1 min", requires: "recording",
    description: "Set an exact time window or draw a box around a detail.",
    steps: [
      { completeOn: ["window-applied"], assist: { action: "shorten-window", description: "Halve the current time window." }, title: "Set the time window", target: "window", instruction: "Enter a Window amount and use … to cycle the unit. Press the check button to apply it. Smaller windows show more detail.", unavailable: "Return to the waveform toolbar." },
      { completeOn: ["waveform-zoom-enabled"], assist: { action: "enable-waveform-zoom", description: "Turn on waveform box zoom." }, title: "Choose Box zoom", target: "waveform-zoom", instruction: "Click the Box zoom button near the playback controls. It switches waveform dragging from selecting a labeling window to zooming.", unavailable: "Return to the waveform toolbar." },
      { completeOn: ["waveform-zoomed"], assist: { action: "zoom-waveform", description: "Zoom into the middle half of the visible time range." }, title: "Draw the area to inspect", target: "waveform", instruction: "Drag a rectangle across the time and channel area you want to enlarge. The waveform fits that box. Pinch or Ctrl/⌘ +/− also changes time zoom.", unavailable: "Load a recording and enable a channel." },
      { completeOn: ["waveform-zoom-disabled"], assist: { action: "disable-waveform-zoom", description: "Turn off waveform box zoom." }, title: "Return to normal selection", target: "waveform-zoom", instruction: "Turn Box zoom off before dragging a labeling window. Use Window to widen the time range again; the channel-layout reset beside CH+ restores a vertically zoomed view.", unavailable: "Return to the waveform toolbar." },
    ],
  },
  {
    id: "choose-channels", topic: "channels", title: "Choose channels and montage", duration: "2 min", requires: "recording",
    description: "Control which sources appear and how they are referenced.",
    steps: [
      { completeOn: ["channels-opened"], assist: { action: "open-channels", description: "Open channel controls; you choose which sources to show." }, title: "Open the CH+ channel manager", target: "channels", readyTarget: "channel-dialog", instruction: "Click CH+ beside the channel names to open the detected source channels.", unavailable: "Return to the waveform view." },
      { completeOn: ["channels-closed"], title: "Choose visible sources", target: "channel-dialog", fallback: "channels", instruction: "Search by channel name and toggle the channels you want. Enable all and Disable all affect visibility only. Close the channel dialog when ready.", unavailable: "Click CH+ to open Channel controls.", tip: "These are source channels. A montage may combine them into different displayed rows." },
      { completeOn: ["montage-changed"], title: "Choose the montage", target: "montage", instruction: "Choose Recorded reference, Average reference, or Anatomical bipolar from Montage. Check the resulting row labels: they identify the sources used by each trace.", unavailable: "Close Channel controls to reach Montage.", tip: "Bipolar pairs depend on the electrode names available in the recording. Display groups are not a map of brain regions." },
    ],
  },
  {
    id: "trace-display", topic: "channels", title: "Adjust amplitude and clamping", duration: "1 min", requires: "recording",
    description: "Use gain, overflow colors, and overlapping traces.",
    steps: [
      { completeOn: ["gain-changed"], assist: { action: "increase-gain", description: "Increase the display gain by one step (decrease at the maximum)." }, title: "Adjust gain", target: "gain", instruction: "Use Gain + or − to enlarge or shrink the traces vertically. Watch the scale and channel units; this is display scaling, not a change to the recording.", unavailable: "Return to the waveform toolbar." },
      { completeOn: ["clamp-changed"], assist: { action: "toggle-clamp", description: "Switch between Clamped and Overlap." }, title: "Switch Clamped / Overlap", target: "clamp", instruction: "The button just right of Gain switches modes. Clamped keeps traces inside their rows and uses a colored heat line for overflow. Overlap allows traces to cross neighboring rows.", unavailable: "Return to the waveform toolbar.", tip: "A flat line at the row boundary in Clamped mode can be display clipping, not a flat raw signal. Switch to Overlap or lower gain to inspect it." },
      { completeOn: ["filters-opened"], assist: { action: "open-filters", description: "Open filter controls without changing any filters." }, title: "Inspect display filters", target: "filters", instruction: "Open Filters to inspect the high-pass, low-pass, and notch settings. Enabled applies them to the waveform; Reset to raw turns them off.", unavailable: "Return to the waveform toolbar.", tip: "The spectrogram uses full-resolution montage samples, not these waveform display filters." },
    ],
  },
  {
    id: "read-spectrogram", topic: "spectrogram", title: "Read the spectrogram", duration: "2 min", requires: "recording",
    description: "Understand time, frequency, colors, and channel selection.",
    steps: [
      { completeOn: ["spectrogram-opened"], assist: { action: "open-spectrogram", description: "Show the spectrogram." }, title: "Open the spectrogram", target: "spectrogram-toggle", readyTarget: "spectrogram-plot", instruction: "Click Spectrogram in Signal tools to show the time-frequency panel below the waveform. Leave it open for the next steps.", unavailable: "Return to the waveform toolbar." },
      { assist: { action: "open-spectrogram", description: "Show the spectrogram; select Next when you have read the explanation." }, title: "Read the axes and colors", target: "spectrogram-plot", reveal: "spectrogram", instruction: "Time runs left to right, aligned with the waveform. Frequency increases upward in Hz. Colors show relative whitened power, not waveform voltage: warmer colors mean higher displayed power.", unavailable: "Open Spectrogram in Signal tools.", tip: "This is a relative view, not an absolute power measurement or an automatic interpretation of the recording." },
      { completeOn: ["channel-focused"], title: "Focus a channel", target: "channel-rail", instruction: "Click a channel name to focus its spectrogram. The label beside the spectrogram identifies the selected channel.", unavailable: "Return to the waveform and channel names." },
      { completeOn: ["channel-focus-cleared"], assist: { action: "clear-channel-focus", description: "Clear channel focus and show all enabled channels in the spectrogram." }, title: "Return to all enabled channels", target: "channel-rail", instruction: "Click the waveform and press Escape to clear that selection and return to the average power of all enabled channels.", unavailable: "Return to the waveform and channel names.", tip: "The label beside the spectrogram tells you which channel or group it currently represents." },
      { completeOn: ["spectrogram-adjusted"], title: "Set frequency range and smoothing", target: "spectrogram-controls", reveal: "spectrogram", instruction: "Frequency range controls the visible Hz band. Smooth averages power over time; 0s removes that extra smoothing. C− / C+ adjust the color limits, not the signal.", unavailable: "Open Spectrogram in Signal tools.", tip: "Longer smoothing can blur brief changes. The color scale stays fixed while you pan the same signal." },
    ],
  },
  {
    id: "zoom-spectrogram", topic: "spectrogram", title: "Browse and box-zoom", duration: "1 min", requires: "recording",
    description: "Pan the spectrogram or fit a time-frequency region to the view.",
    steps: [
      { completeOn: ["spectrogram-browse"], assist: { action: "spectrogram-browse", description: "Select the spectrogram Browse tool." }, title: "Browse with B", target: "spectrogram-browse", reveal: "spectrogram", instruction: "Select B to switch to the Browse tool.", unavailable: "Open Spectrogram in Signal tools." },
      { completeOn: ["spectrogram-panned"], assist: { action: "pan-waveform", description: "Pan the waveform and spectrogram together by one second." }, title: "Pan the spectrogram", target: "spectrogram-plot", reveal: "spectrogram", instruction: "Click the spectrogram to center on a time, or hold and drag to pan. The waveform and spectrogram move together.", unavailable: "Open Spectrogram and select B." },
      { completeOn: ["spectrogram-zoom-tool"], assist: { action: "spectrogram-zoom-tool", description: "Select the spectrogram Box zoom tool." }, title: "Select the zoom tool", target: "spectrogram-zoom", reveal: "spectrogram", instruction: "Select Z, just to the right of B. This changes dragging into a time-frequency box zoom.", unavailable: "Open Spectrogram in Signal tools." },
      { completeOn: ["spectrogram-zoomed"], title: "Draw your zoom box", target: "spectrogram-plot", reveal: "spectrogram", instruction: "Drag across the time and frequency region you want to inspect, then release. The selected time span and frequency band fill the view.", unavailable: "Open Spectrogram, then select Z." },
      { completeOn: ["spectrogram-browse","spectrogram-adjusted","window-applied"], assist: { action: "spectrogram-reset", description: "Restore the default frequency range." }, title: "Browse again or widen the view", target: "spectrogram-controls", reveal: "spectrogram", instruction: "Select B to pan again. The ↺ button resets the frequency range. To widen time again, increase Window in the waveform toolbar.", unavailable: "Open Spectrogram in Signal tools." },
    ],
  },
  {
    id: "label-waveform", topic: "labels", title: "Label a moment or a window", duration: "2 min", requires: "review",
    description: "Turn a time selection into an ePhys annotation.",
    steps: [
      { completeOn: ["label-panel-opened"], assist: { action: "show-label-panel", description: "Show labeling tools without adding annotations." }, title: "Prepare the labeling tools", target: "label-panel", reveal: "label-panel", instruction: "Open Labeling tools on the right. Practice on a spare session if you do not want to add real annotations to this recording.", unavailable: "Show the right Labeling tools panel.", tip: "This guide never creates or commits labels for you. Any label you click yourself is a real edit." },
      { completeOn: ["time-selected"], assist: { action: "select-time-window", description: "Select the middle half of the visible window; no label is created." }, title: "Select a moment or time window", target: "waveform", instruction: "Make sure Box zoom is off. Click the waveform to pin a single time, or drag across time to select a window.", unavailable: "Return to the waveform view and enable a channel." },
      { completeOn: ["ephys-label-added"], title: "Choose an ePhys label", target: "ephys-palette", reveal: "label-panel", instruction: "Click the ePhys label that you intend to add. A pinned time creates an instance; a selected span creates a window label.", unavailable: "Show Labeling tools, and use … to enable the label type you need." },
      { completeOn: ["annotation-inspected"], assist: { action: "show-label-tracks", description: "Show annotation tracks so you can inspect the result.", completesStep: false }, title: "Review the result", target: "label-tracks", reveal: "label-tracks", instruction: "Find the annotation in the instance or window track. Select it to inspect timing and other details. Review before committing; Escape clears the current selection.", unavailable: "Show the bottom label tracks.", tip: "Finishing a tutorial does not commit annotations or save a project." },
    ],
  },
  {
    id: "label-types", topic: "labels", title: "Organize label types and visibility", duration: "1 min", requires: "recording",
    description: "Choose your palette, distinguish label types, and hide overlays.",
    steps: [
      { completeOn: ["label-picker-closed"], assist: { action: "open-label-picker", description: "Open the chooser; you select label types and close it when ready.", completesStep: false }, title: "Choose visible ePhys types", target: "label-picker-dialog", fallback: "label-picker", reveal: "label-panel", instruction: "Click … in the ePhys palette. Check the label types you want available, then close the chooser. This changes the palette, not existing annotations.", unavailable: "Show the right Labeling tools panel." },
      { title: "Use timed context", target: "context-palette", reveal: "label-panel", instruction: "Clinical Observation, Medication, and Other are timed context tools. Like ePhys labels, they can describe a moment or a selected span.", unavailable: "Close the label chooser and show Labeling tools." },
      { completeOn: ["session-label-picker-opened"], assist: { action: "open-session-label-picker", description: "Open the session label choices without creating a label." }, title: "Keep whole-session labels separate", target: "session-labels", reveal: "recording-panel", instruction: "Use + in the left Session Labels section for a label that applies to the entire session, rather than a point or a window.", unavailable: "Show the left recording panel." },
      { completeOn: ["labels-toggled"], assist: { action: "toggle-labels", description: "Toggle visibility of all labels; nothing is deleted." }, title: "Hide or show all annotations", target: "label-visibility", reveal: "label-panel", instruction: "Use Hide all labels at the top of the right panel to hide every label type. Click Show all labels to restore them. Neither action deletes saved labels.", unavailable: "Show the right panel." },
    ],
  },
  {
    id: "save-project", topic: "save", title: "Save and reopen your workspace", duration: "2 min", requires: "workspace",
    description: "Choose what goes into a portable NeuroTrace project.",
    steps: [
      { completeOn: ["save-opened"], assist: { action: "open-save", description: "Open save options; nothing is saved yet." }, title: "Open Save", target: "save", readyTarget: "save-dialog", instruction: "Click Save at the top right to open the project options.", unavailable: "Close any other dialog to reach Save." },
      { completeOn: ["save-options-changed"], title: "Choose what to include", target: "save-options", fallback: "save", instruction: "Review the sections and their sizes. Include the recording data if the project needs to reopen without the original signal files.", unavailable: "Click Save to open the project options.", tip: "Included recordings and metadata can contain identifying information. Review the contents before sharing a project." },
      { completeOn: ["project-saved"], title: "Save to your computer", target: "save-confirm", fallback: "save", instruction: "When ready, click Choose location & save. Keep the resulting .neurotrace file somewhere you can find it. The guide will not press Save for you.", unavailable: "Click Save to choose the project sections." },
      { title: "Reopen a project", target: "upload", instruction: "Close Save. To reopen later, use Upload, choose NeuroTrace, and select your .neurotrace file. Use a blank session if you want to keep your current workspace separate.", unavailable: "Close the save dialog to reach Upload." },
    ],
  },
];

export function tutorialBlockReason(lesson: TutorialLesson, hasRecording: boolean, canAnnotate: boolean): string | null {
  if (lesson.requires !== "workspace" && !hasRecording) return "Open a recording first to try this in the workspace. You can still read every step here.";
  if (lesson.requires === "review" && !canAnnotate) return "Wait for file validation before adding labels. You can read the steps in the meantime.";
  return null;
}

/** Roving tab focus wraps horizontally; Home/End jump to the edges. */
export function tutorialTabIndex(key: string, current: number): number | null {
  if (key === "Home") return 0;
  if (key === "End") return tutorialTopics.length - 1;
  if (key === "ArrowRight") return (current + 1) % tutorialTopics.length;
  if (key === "ArrowLeft") return (current + tutorialTopics.length - 1) % tutorialTopics.length;
  return null;
}

export type TutorialRect = { left: number; top: number; width: number; height: number };
export type TutorialCoachPosition = { left: number; top: number; width: number };

/** Keep a manually placed coach reachable after dragging, resizing, or changing steps. */
export function clampTutorialCoachPosition(position: TutorialCoachPosition, viewport: { width: number; height: number }, height: number): TutorialCoachPosition {
  const margin = 12;
  const width = Math.max(1, Math.min(position.width, viewport.width - margin * 2));
  const visibleHeight = Math.max(1, Math.min(height, viewport.height - margin * 2));
  return {
    left: Math.max(margin, Math.min(position.left, viewport.width - width - margin)),
    top: Math.max(margin, Math.min(position.top, viewport.height - visibleHeight - margin)),
    width,
  };
}

/** Keep the preferred position when clear; otherwise move as little as possible to uncover the target. */
export function placeTutorialCoach(
  viewport: { width: number; height: number },
  size: { width: number; height: number },
  target: TutorialRect | null,
  preferred?: TutorialCoachPosition | null,
) {
  const margin = 12;
  const gap = 12;
  const width = Math.max(1, Math.min(size.width, viewport.width - margin * 2));
  const height = Math.max(1, Math.min(size.height, viewport.height - margin * 2));
  const right = Math.max(margin, viewport.width - width - margin);
  const bottom = Math.max(margin, viewport.height - height - margin);
  const origin = clampTutorialCoachPosition({ left: preferred?.left ?? right, top: preferred?.top ?? bottom, width }, viewport, height);
  if (!target) return { ...origin, maxHeight: height };

  // Overlap changes at these edges. Including the preferred coordinates finds the
  // nearest clear position, not just a corner; edges also minimize unavoidable overlap.
  const xs = [origin.left, margin, right, target.left - width - gap, target.left - width, target.left + target.width, target.left + target.width + gap];
  const ys = [origin.top, margin, bottom, target.top - height - gap, target.top - height, target.top + target.height, target.top + target.height + gap];
  const overlap = (position: TutorialCoachPosition, padding: number) =>
    Math.max(0, Math.min(position.left + width, target.left + target.width + padding) - Math.max(position.left, target.left - padding))
      * Math.max(0, Math.min(position.top + height, target.top + target.height + padding) - Math.max(position.top, target.top - padding));
  const candidates = xs.flatMap((left) => ys.map((top) => {
    const position = clampTutorialCoachPosition({ left, top, width }, viewport, height);
    return {
      position,
      overlap: overlap(position, 0),
      clearanceOverlap: overlap(position, gap),
      distance: (position.left - origin.left) ** 2 + (position.top - origin.top) ** 2,
    };
  }));
  // Never sacrifice a clear target merely to preserve the optional breathing room.
  candidates.sort((a, b) => a.overlap - b.overlap || a.clearanceOverlap - b.clearanceOverlap || a.distance - b.distance);
  return { ...candidates[0].position, maxHeight: height };
}
