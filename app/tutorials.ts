/*
Purpose: Defines tutorials for the NeuroTrace workspace.
File Dependencies: app/tutorial-events.ts.
*/


import type { TutorialAction, TutorialAssistAction } from "./tutorial-events";

/** Task-based help with explicit completion signals and opt-in, view-only assistance. */
export const tutorialTopics = [
  { id: "start", title: "Get started", icon: "01" },
  { id: "directories", title: "Directories", icon: "02" },
  { id: "navigate", title: "Navigate", icon: "03" },
  { id: "channels", title: "Channels", icon: "04" },
  { id: "spectrogram", title: "Spectrogram", icon: "05" },
  { id: "labels", title: "Labels", icon: "06" },
  { id: "save", title: "Save & reopen", icon: "07" },
] as const;

export type TutorialTopic = typeof tutorialTopics[number]["id"];
export type TutorialReveal = "recording-panel" | "label-panel" | "spectrogram" | "label-tracks" | "view-panel" | "window-panel" | "session-labels" | "event-labels" | "file-panel";
export type TutorialStep = {
  title: string;
  instruction: string;
  target: string;
  fallback?: string;
  readyTarget?: string;
  /** Follow a workflow into its dialog without replacing its instructions. */
  dialogTarget?: string;
  unavailable: string;
  reveal?: TutorialReveal;
  tip?: string;
} & (
  // Reading-only steps cannot offer an action or advance on unrelated workspace activity.
  | { completeOn?: never; assist?: never }
  | { completeOn: readonly [TutorialAction, ...TutorialAction[]]; assist?: { action: TutorialAssistAction; description: string; completesStep?: boolean } }
);
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
      { completeOn: ["import-opened"], assist: { action: "open-import", description: "Open the recording loader." }, title: "Open the file loader", target: "upload", readyTarget: "import", instruction: "Click Upload at the bottom right. This opens the recording loader; it does not upload your files to a server.", unavailable: "Close any other dialog to reach Upload.", tip: "Session tabs keep separate workspaces. Use + first if you want a new, blank session." },
      { completeOn: ["import-files-ready", "recording-opened"], title: "Choose files or a folder", target: "import-files", fallback: "import-formats", instruction: "Click Files to browse all files, including companions. Select both the MAT and DAT with the same name before the extension. You can select them together or add the matching file in the same loader. Use Folder to include subfolders. NeuroTrace detects recording formats. The optional format cards filter mixed folders.", unavailable: "Open Upload to reach Files and Folder.", tip: "Drop individual files onto the homepage or workspace. Drop a folder inside the loader." },
      { completeOn: ["recording-opened"], title: "Open the selection", target: "import-open", fallback: "import", readyTarget: "waveform", instruction: "Click Open selected files or Load N sessions. The first recording opens directly. If your DAT has no usable mapping, provide the sample rate and channel count before opening it.", unavailable: "Choose files or a folder to preview the selection." },
      { title: "Check the recording", target: "waveform", fallback: "import", instruction: "Check channel names, units, and duration once the waveform appears. File labels and the full session overview can finish loading in the background.", unavailable: "Finish the loader to see the recording." },
    ],
  },
  {
    id: "workspace", topic: "start", title: "Find your way around", duration: "1 min", requires: "recording",
    description: "Meet the recording panel, signal tools, and labeling area.",
    steps: [
      { title: "Session tabs", target: "sessions", instruction: "Each top tab is an independent workspace. Switch tabs to return to another session; + creates a blank one.", unavailable: "Close any open dialog to see the session tabs." },
      { title: "Recording info and queue", target: "recording-panel", reveal: "recording-panel", instruction: "The left sidebar has Info, Viewing Tools, and Labels tabs. Info has Folder/File and Window/Performance subtabs. Folder/File groups folder counts, file details, and display settings. Window/Performance pairs the visible start and end and shows signal status above Performance & loading info. Labels contains Session, Window / Instance, and Create sections.", unavailable: "Show the left recording panel to see these tools." },
      { title: "Signal tools", target: "signal-tools", instruction: "The toolbar keeps previous/play/next, Jump to, Window, and Box zoom together. Use + at its right end to add or remove optional tools. Your toolbar choices are remembered and included in workspace JSON.", unavailable: "Return to a session with a waveform." },
      { title: "Labeling tools", target: "label-panel", reveal: "label-panel", instruction: "Open Labels → Create in the left sidebar for timed context, ePhys, and dictionary labels. Session holds whole-recording labels and the map; Window / Instance holds window labels, instance labels, file events and their filters.", unavailable: "Open Labels → Create." },
      { title: "Viewing tools", target: "view-tools", reveal: "view-panel", instruction: "Viewing Tools holds montage, grouping, filters, gain, clamping, and spectrogram. Use the long Channels bar beside the recording to enable or disable channels. Click + beside a tool to add a toolbar copy; − removes that copy. All tools remain in Viewing Tools.", unavailable: "Open the Viewing Tools tab." },
      { title: "Window and performance", target: "window-info", reveal: "window-panel", instruction: "The upper Window info pane shows start/end, Curr. RAM Usage, loading, the clicked point and its labels. The lower Performance & loading info pane uses compact rows; hover a value for its detailed measurements. File details, montage and current filters stay under Info → Folder/File.", unavailable: "Open Info → Window/Performance." },
    ],
  },
  {
    id: "load-directory", topic: "directories", title: "Load a directory", duration: "2 min", requires: "workspace",
    description: "Choose a folder and open recordings from its session list.",
    steps: [
      { completeOn: ["import-opened"], assist: { action: "open-import", description: "Open the recording loader. You choose the files." }, title: "Open the loader", target: "upload", readyTarget: "import", instruction: "Click Upload at the bottom right, or Load a recording on the homepage.", unavailable: "Close any other dialog to reach Upload." },
      { completeOn: ["directory-files-ready"], title: "Choose Folder", target: "import-folder", fallback: "import", instruction: "Click Folder and select a directory in the file picker. Subfolders are included. Choose an optional format first if you only want one type from a mixed folder. You can also drop a folder into the loader.", unavailable: "Open Upload to reach Folder." },
      { completeOn: ["recording-opened"], title: "Load the folder", target: "import-open", fallback: "import", readyTarget: "waveform", instruction: "Check the detected paths and click Load N sessions. The first recording opens directly. To restrict the folder to matching event labels, choose Add filters, enter keywords, then click Load matching sessions.", unavailable: "Select a folder first." },
      { title: "Browse the folder", target: "directory-header", fallback: "sessions", instruction: "Use the arrows above the tab to change files, or click the folder name to open its full list. Use the Instance Queue arrows to move between matching labels; its small across-sessions toggle can continue into later files.", unavailable: "Load a folder to see its header.", tip: "Reopen a saved CSV for labels and recording references, or JSON for the exact window and settings." },
    ],
  },
  {
    id: "directory-navigation", topic: "directories", title: "Navigate directory files", duration: "1 min", requires: "recording",
    description: "Use the directory header and its Previous and Next buttons.",
    steps: [
      { title: "Find the directory header", target: "directory-header", fallback: "sessions", instruction: "The directory name sits above its session tabs and spans adjacent tabs from that directory. Select a recording tab from the directory you want to browse.", unavailable: "Load a directory and open one of its recordings first.", tip: "These buttons change files. The playback arrows in Signal tools move through time within one recording." },
      { title: "Next file", target: "directory-next", fallback: "sessions", instruction: "The right arrow opens the next recording in the directory list and closes the currently viewed tab after the new recording loads successfully. If that next recording is already open, it switches to its tab instead of loading it again.", unavailable: "Close any dialog and select an open directory recording.", tip: "Next is gray at the last file. Navigation is also unavailable while a file is opening or waiting for DAT layout confirmation. This guide will not change files for you." },
      { title: "Previous file", target: "directory-previous", fallback: "sessions", instruction: "The left arrow does the same thing in reverse. It is gray at the first file. When Bias Locks is enabled in Settings, a lock replaces this arrow and backward directory navigation is disabled.", unavailable: "Close any dialog and select an open directory recording.", tip: "The buttons follow the directory list order, not the order of open tabs. They do not wrap around at either end." },
      { title: "Jump to the next event", target: "directory-next-event", fallback: "directory-header", reveal: "event-labels", instruction: "In Labels → Window / Instance, enter keywords in the Instance Queue and use its right arrow to jump to the next match. Enable Continue events across sessions beside search to continue into the next recording with a match.", unavailable: "Open Labels → Window / Instance. Across-session navigation requires a recording from a loaded folder." },
      { title: "Open the full list", target: "directory-header", readyTarget: "directory-list", fallback: "sessions", instruction: "Click the directory name or Open Loaded Folder in Info → Folder/File to see its sessions. Choose Change folder filters, enter comma-separated event keywords, then press Enter or Apply to folder. Any keyword can match. Remove filters restores the full list. Open loads a recording; Resume returns to its open tab.", unavailable: "Load a directory to show its header above the tabs.", tip: "Opening from this list keeps other tabs open. Folder filters also restrict the header arrows to matching recordings. Bias Locks does not block manual selection. Close the list when finished." },
    ],
  },
  {
    id: "bias-locks", topic: "directories", title: "Bias Locks", duration: "1 min", requires: "workspace",
    description: "Enable or disable the directory Previous button.",
    steps: [
      { completeOn: ["settings-opened"], assist: { action: "open-settings", description: "Open Settings without changing any options." }, title: "Open Settings", target: "settings", readyTarget: "settings-dialog", instruction: "Click the gear at the bottom right to open Settings. Bias Locks is at the top.", unavailable: "Close any other dialog to reach Settings." },
      { completeOn: ["bias-locks-changed"], title: "Enable or disable Bias Locks", target: "bias-locks", fallback: "settings", instruction: "Set Bias Locks to Enabled to disable the directory Previous button. Set it to Disabled to allow Previous again. Leave it as it is and select Next if you do not want to change the setting.", unavailable: "Open Settings to reach Bias Locks.", tip: "The setting applies across directory tabs and is remembered in this browser. This guide never changes it for you." },
      { title: "Check the lock icon", target: "directory-previous", fallback: "sessions", instruction: "Close Settings and look at the directory header. When enabled, a lock replaces the left arrow. Next still works unless you are at the last file or a recording is loading.", unavailable: "Close Settings, then load a directory and open a recording to see its navigation buttons.", tip: "Bias Locks only blocks the directory Previous control. It does not block the full session list, switching open tabs, or moving backward in waveform time." },
    ],
  },
  {
    id: "pan-time", topic: "navigate", title: "Move through time", duration: "1 min", requires: "recording",
    description: "Jump, pan, and page without losing your place.",
    steps: [
      { completeOn: ["overview-jumped"], assist: { action: "jump-overview", description: "Jump forward by one window (backward at the end)." }, title: "Jump from the overview", target: "overview", instruction: "Click anywhere on the full-session overview to jump. Its highlighted section marks the current window. The overview builds automatically in the background, and hovering shows its coverage.", unavailable: "Return to the recording view to see the overview." },
      { completeOn: ["waveform-panned"], assist: { action: "pan-waveform", description: "Pan by one second." }, title: "Pan the waveform", target: "waveform", instruction: "Use horizontal scrolling or Shift + wheel over the waveform to move through time. A vertical wheel scrolls channels when they extend beyond the view; otherwise it pans time. One-second keys: {shortcut:panLeft} / {shortcut:panRight}. Ten-second keys: {shortcut:panLeftFast} / {shortcut:panRightFast}.", unavailable: "Load a recording and enable at least one channel.", tip: "Keyboard navigation works when you are not typing in a field or focused on a toolbar button. Change shortcuts in Settings." },
      { completeOn: ["transport-used"], assist: { action: "page-forward", description: "Move by one window, without starting playback." }, title: "Page or play", target: "transport", instruction: "Use ‹ and › to move by a full window. Play keeps the playhead centered while data scrolls underneath it and loads ahead. Click Pause when you are done; long waits hold the waveform and clock together.", unavailable: "Return to the waveform toolbar." },
    ],
  },
  {
    id: "zoom-waveform", topic: "navigate", title: "Zoom into a waveform", duration: "1 min", requires: "recording",
    description: "Set an exact time window or draw a box around a detail.",
    steps: [
      { completeOn: ["window-applied"], assist: { action: "shorten-window", description: "Halve the current time window." }, title: "Set the time window", target: "window", instruction: "Click the Window amount to select its full value. Type the replacement and press Enter or click away to apply it. Click the underlined unit to convert the amount without changing the duration. Amounts display to one decimal, up to 999.9.", unavailable: "Return to the waveform toolbar." },
      { completeOn: ["waveform-zoom-enabled"], assist: { action: "enable-waveform-zoom", description: "Turn on waveform box zoom." }, title: "Choose Box zoom", target: "waveform-zoom", instruction: "Click the Box zoom button near the playback controls. It switches waveform dragging from selecting a labeling window to zooming.", unavailable: "Return to the waveform toolbar." },
      { completeOn: ["waveform-zoomed"], assist: { action: "zoom-waveform", description: "Zoom into the middle half of the visible time range." }, title: "Draw the area to inspect", target: "waveform", instruction: "Drag a rectangle across the time and channel area you want to enlarge. The waveform fits that box. Pinch also changes time zoom. Zoom keys: {shortcut:zoomIn} / {shortcut:zoomOut}.", unavailable: "Load a recording and enable a channel." },
      { completeOn: ["waveform-zoom-disabled"], assist: { action: "disable-waveform-zoom", description: "Turn off waveform box zoom." }, title: "Return to normal selection", target: "waveform-zoom", instruction: "Turn Box zoom off before dragging a labeling window. Double-click the waveform to return to the view before the last box zoom. Repeat to step back through earlier boxes.", unavailable: "Return to the waveform toolbar." },
    ],
  },
  {
    id: "choose-channels", topic: "channels", title: "Choose channels and montage", duration: "2 min", requires: "recording",
    description: "Control which sources appear and how they are referenced.",
    steps: [
      { completeOn: ["channels-opened"], assist: { action: "open-channels", description: "Open channel controls; you choose which sources to show." }, title: "Open Channel controls", target: "channel-visibility", fallback: "channel-rail", readyTarget: "channel-dialog", instruction: "Click the long Channels bar to the left of the channel names to enable or disable individual channels or whole groups.", unavailable: "Return to the waveform view." },
      { completeOn: ["channels-closed"], title: "Choose visible sources", target: "channel-dialog", fallback: "channel-visibility", instruction: "Search by channel or group name. Check a group to enable all of its channels, or use the individual checkboxes. Click Done when ready.", unavailable: "Click the long Channels bar to open channel controls.", tip: "These are source channels. A montage may combine them into different displayed rows." },
      { completeOn: ["montage-changed"], title: "Choose the montage", target: "montage", reveal: "view-panel", instruction: "Choose Recorded reference, Average reference, or the available bipolar montage from Montage. Scalp recordings offer Longitudinal bipolar; intracranial recordings use Anatomical bipolar. Check the resulting row labels: they identify the sources used by each trace.", unavailable: "Close Channel controls, then open Viewing Tools to reach Montage.", tip: "Bipolar pairs depend on the electrode names available in the recording. Display groups are not a map of brain regions." },
      { title: "Fit and space groups", target: "channel-fit", instruction: "Click ≡ above the channel names to fit all enabled channels with tighter spacing. Click it again to restore your previous layout and scroll position. Drag a separator between groups to adjust all gaps together. Shift-click channel names to select channels for an averaged spectrogram.", unavailable: "Enable at least one channel and grouping." },
    ],
  },
  {
    id: "trace-display", topic: "channels", title: "Adjust amplitude and clamping", duration: "1 min", requires: "recording",
    description: "Use gain, overflow colors, and overlapping traces.",
    steps: [
      { completeOn: ["gain-changed"], assist: { action: "increase-gain", description: "Increase the display gain by one step (decrease at the maximum)." }, title: "Adjust gain", target: "gain", reveal: "view-panel", instruction: "Enter a Gain from 0.01× to 4×, then press {shortcut:gainApply} or leave the field to apply. Use {shortcut:clear} while typing to cancel, or + / − to adjust the gain. This scales the display without changing the recording.", unavailable: "Open Viewing Tools, or use a pinned toolbar copy.", tip: "Traces center automatically on the current time window. Vertical scrolling and gain changes keep those centers fixed. Centering changes only display position, not recorded values, drift, or missing samples." },
      { completeOn: ["clamp-changed"], assist: { action: "toggle-clamp", description: "Switch between Clamped and Overlap." }, title: "Switch Clamped / Overlap", target: "clamp", reveal: "view-panel", instruction: "The Clamping control in Viewing Tools switches modes. Clamped keeps traces inside their rows and uses a colored heat line for overflow. Overlap allows traces to cross neighboring rows.", unavailable: "Open Viewing Tools, or use a pinned toolbar copy.", tip: "A flat line at the row boundary in Clamped mode can be display clipping, not a flat raw signal. Switch to Overlap or lower gain to inspect it." },
      { completeOn: ["filters-opened"], assist: { action: "open-filters", description: "Open filter controls without changing any filters." }, title: "Inspect display filters", target: "filters", reveal: "view-panel", instruction: "Open Filters to inspect the optional high-pass, low-pass, and notch settings. When these are off, the waveform uses the MATLAB reviewer's display preparation, including its automatic FIR filtering at wider windows.", unavailable: "Open Viewing Tools, or use a pinned toolbar copy.", tip: "The spectrogram uses full-resolution raw source channels, not waveform filters or montage differences." },
    ],
  },
  {
    id: "read-spectrogram", topic: "spectrogram", title: "Read the spectrogram", duration: "2 min", requires: "recording",
    description: "Understand time, frequency, colors, and channel selection.",
    steps: [
      { completeOn: ["spectrogram-opened"], assist: { action: "open-spectrogram", description: "Show the spectrogram." }, title: "Open the spectrogram", target: "spectrogram-toggle", reveal: "view-panel", readyTarget: "spectrogram-plot", instruction: "Click Spectrogram in Viewing Tools (or pin it to the toolbar) to show the time-frequency panel below the waveform. Leave it open for the next steps.", unavailable: "Open Viewing Tools, or use a pinned toolbar copy." },
      { title: "Read the axes and colors", target: "spectrogram-plot", reveal: "spectrogram", instruction: "Time runs left to right, aligned with the waveform. Frequency increases upward in Hz. Colors show Gabor wavelet log-power as standard deviations from the pre-click baseline: warm colors are above that baseline and cool colors are below it.", unavailable: "Open Spectrogram from Viewing Tools or its pinned toolbar button.", tip: "This matches the MATLAB reviewer's relative log-power view, not absolute voltage or an automatic interpretation. Very short pre-click baselines use its first-half fallback." },
      { completeOn: ["channel-focused"], title: "Focus a channel", target: "channel-rail", instruction: "Click a channel name to select its raw electrode group. The spectrogram averages power across that complete source group, including contacts hidden from the waveform; ungrouped channels are analyzed individually. Click a group name to select all its contacts. Hold Shift and click channel names to combine contacts, then open Spectrogram. Selected names stay highlighted and the spectrogram identifies the average. Selected contacts must share a sample rate.", unavailable: "Return to the waveform and channel names." },
      { title: "Check the analyzed window", target: "spectrogram-plot", reveal: "spectrogram", instruction: "The spectrogram covers the entire visible time window. Click the waveform to choose the pre-click baseline anchor. Long windows show a full-window wavelet overview; zoom in for exact short-window detail.", unavailable: "Open Spectrogram from Viewing Tools or its pinned toolbar button.", tip: "Long views use overlapping sections and time-bin averaging with one shared baseline. Recorded-reference, average-reference, and bipolar display choices do not change the raw channels used for group power." },
      { completeOn: ["spectrogram-adjusted"], title: "Set frequency and color range", target: "spectrogram-controls", reveal: "spectrogram", instruction: "Frequency range controls the visible Hz band. Use − or + beside the ± Z-score value to adjust the color limits. Narrower limits increase contrast. The initial limits use the 98th percentile of absolute Z-scores in the retained frequency rows, with a minimum of ±1.", unavailable: "Open Spectrogram from Viewing Tools or its pinned toolbar button.", tip: "The MATLAB wavelet calculation is retained, with up to 60 original log-spaced frequency centers placed at their true Hz positions. Centers above 150 Hz or half the sample rate (Nyquist) are excluded. No extra whitening or smoothing is applied." },
    ],
  },
  {
    id: "zoom-spectrogram", topic: "spectrogram", title: "Browse and box-zoom", duration: "1 min", requires: "recording",
    description: "Pan the spectrogram or fit a time-frequency region to the view.",
    steps: [
      { completeOn: ["spectrogram-browse"], assist: { action: "spectrogram-browse", description: "Select the spectrogram Browse tool." }, title: "Select Browse", target: "spectrogram-browse", reveal: "spectrogram", instruction: "Select Browse (B on narrow plots) to switch to the pan tool.", unavailable: "Open Spectrogram from Viewing Tools or its pinned toolbar button." },
      { completeOn: ["spectrogram-panned"], assist: { action: "pan-waveform", description: "Pan the waveform and spectrogram together by one second." }, title: "Pan the spectrogram", target: "spectrogram-plot", reveal: "spectrogram", instruction: "Click the spectrogram to center on a time, or hold and drag to pan. The waveform and spectrogram move together.", unavailable: "Open Spectrogram and select Browse." },
      { completeOn: ["spectrogram-zoom-tool"], assist: { action: "spectrogram-zoom-tool", description: "Select the spectrogram Box zoom tool." }, title: "Select the zoom tool", target: "spectrogram-zoom", reveal: "spectrogram", instruction: "Select Box zoom (Z on narrow plots). This changes dragging into a time-frequency box zoom.", unavailable: "Open Spectrogram from Viewing Tools or its pinned toolbar button." },
      { completeOn: ["spectrogram-zoomed"], title: "Draw your zoom box", target: "spectrogram-plot", reveal: "spectrogram", instruction: "Drag across the time and frequency region you want to inspect, then release. The selected time span and frequency band fill the view.", unavailable: "Open Spectrogram, then select Box zoom." },
      { completeOn: ["spectrogram-browse","spectrogram-adjusted","window-applied"], assist: { action: "spectrogram-reset", description: "Restore the default frequency range." }, title: "Browse again or widen the view", target: "spectrogram-controls", reveal: "spectrogram", instruction: "Select Browse to pan again. The ↺ button resets the frequency range. To widen time again, increase Window in the waveform toolbar.", unavailable: "Open Spectrogram from Viewing Tools or its pinned toolbar button." },
    ],
  },
  {
    id: "label-waveform", topic: "labels", title: "Label a moment or a window", duration: "2 min", requires: "review",
    description: "Turn a time selection into an ePhys annotation.",
    steps: [
      { completeOn: ["label-panel-opened"], assist: { action: "show-label-panel", description: "Show labeling tools without adding annotations." }, title: "Prepare the labeling tools", target: "label-panel", reveal: "label-panel", instruction: "Open Labels → Create in the left sidebar. Practice on a spare session if you do not want to add real annotations to this recording.", unavailable: "Open Labels → Create.", tip: "This guide never creates or commits labels for you. Any label you click yourself is a real edit." },
      { completeOn: ["time-selected"], assist: { action: "select-time-window", description: "Select the middle half of the visible window; no label is created." }, title: "Select a moment or time window", target: "waveform", instruction: "Make sure Box zoom is off. Click the waveform to pin a single time, or drag across time to select a window.", unavailable: "Return to the waveform view and enable a channel." },
      { completeOn: ["ephys-label-added"], title: "Choose an ePhys label", target: "ephys-palette", dialogTarget: "label-confidence", reveal: "label-panel", instruction: "Click the ePhys label that you intend to add, enter a confidence percentage, then click Add label. A pinned time creates an instance; a selected span creates a window label.", unavailable: "Show Labeling tools, and use … to enable the label type you need." },
      { completeOn: ["annotation-inspected"], assist: { action: "show-label-tracks", description: "Show annotation tracks so you can inspect the result.", completesStep: false }, title: "Review the result", target: "label-tracks", reveal: "label-tracks", instruction: "Find the annotation in the instance or window track. Select it to inspect timing and other details. Review before committing; Clear selection uses {shortcut:clear}.", unavailable: "Show the bottom label tracks.", tip: "Finishing a tutorial does not commit or save labels. Use Save → Download CSV + JSON to export drafts and committed labels with a portable workspace." },
    ],
  },
  {
    id: "label-types", topic: "labels", title: "Organize label types and visibility", duration: "1 min", requires: "recording",
    description: "Choose your palette, distinguish label types, and hide overlays.",
    steps: [
      { completeOn: ["label-picker-closed"], assist: { action: "open-label-picker", description: "Open the chooser; you select label types and close it when ready.", completesStep: false }, title: "Choose visible ePhys types", target: "label-picker-dialog", fallback: "label-picker", reveal: "label-panel", instruction: "Click … in the ePhys palette. Check the label types you want available, then close the chooser. This changes the palette, not existing annotations.", unavailable: "Open Labels → Create, then click … to choose ePhys label types." },
      { title: "Use timed context", target: "context-palette", reveal: "label-panel", instruction: "Clinical Observation, Medication, and Other are timed context tools. Like ePhys labels, they can describe a moment or a selected span.", unavailable: "Close the label chooser and show Labeling tools." },
      { title: "Put a label on the toolbar", target: "label-toolbar-pin", fallback: "label-panel", reveal: "label-panel", instruction: "Click + beside a label you use often to pin a shortcut. Use the shortcut after choosing a time or span. Click − beside the label or uncheck it in Customize toolbar to remove the shortcut.", unavailable: "Open Labels → Create and enable the label you want to pin." },
      { title: "Edit the label library", target: "label-library", dialogTarget: "label-library-dialog", fallback: "label-panel", reveal: "label-panel", instruction: "Open Edit label library to add an alias or description to a detected label, or create a dictionary label with a name, code word, and description. Dictionary labels appear in Create.", unavailable: "Open Labels → Create." },
      { completeOn: ["session-label-picker-opened"], assist: { action: "open-session-label-picker", description: "Open the session label choices without creating a label." }, title: "Keep whole-session labels separate", target: "session-labels", reveal: "session-labels", instruction: "Use + in the left Session Labels section for a label that applies to the entire session, rather than a point or a window.", unavailable: "Open Labels → Session." },
      { completeOn: ["labels-toggled"], assist: { action: "toggle-labels", description: "Toggle visibility of all labels; nothing is deleted." }, title: "Hide or show all annotations", target: "label-visibility", reveal: "event-labels", instruction: "Use Hide all labels beside the Instance Queue search in Labels → Window / Instance to hide every label type. Click Show all labels to restore them. Neither action deletes saved labels.", unavailable: "Open Labels → Window / Instance." },
    ],
  },
  {
    id: "save-project", topic: "save", title: "Save CSV and workspace JSON", duration: "1 min", requires: "recording",
    description: "Download annotations and a portable workspace together.",
    steps: [
      { completeOn: ["save-opened"], assist: { action: "open-save", description: "Open Save; nothing is downloaded yet." }, title: "Open Save", target: "save", readyTarget: "save-dialog", instruction: "Click Save at the bottom right. Your CSV includes detected and reviewer-added labels, drafts, confidence, and recording references. The label_source column distinguishes their origins.", unavailable: "Close any other dialog to reach Save." },
      { title: "Sign the review", target: "save-details", fallback: "save", instruction: "Enter your reviewing signature. It is saved with your manual labels and used in both filenames, together with the numbered review session. A managed folder keeps its existing reviewer ID.", unavailable: "Open Save to enter your signature." },
      { completeOn: ["annotations-saved"], title: "Download both files", target: "save-confirm", fallback: "save", instruction: "Click Download CSV + JSON. Both files download automatically. CSV restores labels and recording references; JSON also restores the exact window, cursor, settings, aliases, and dictionaries. Browser autosave continues in the background. The guide will not save for you.", unavailable: "Open Save first." },
    ],
  },
  {
    id: "resume-directory-review", topic: "directories", title: "Reopen a saved folder review", duration: "1 min", requires: "workspace",
    description: "Reconnect saved CSV or JSON to the original recordings.",
    steps: [
      { title: "Choose your save file", target: "upload", dialogTarget: "import", instruction: "Open Upload and use Files to select your workspace JSON or annotation CSV. JSON restores the exact place and settings; CSV alone restores annotations and the recording set.", unavailable: "Close the current dialog to reach Upload.", tip: "Raw recordings stay on your computer. The browser requires you to select them again." },
      { title: "Select the original recordings", target: "import-files", fallback: "upload", instruction: "Choose the original recording folder or files. The loader shows the detected recordings and the staged save file. Check the reviewer ID, then confirm once to load. No saved-review chooser is needed.", unavailable: "Open Upload to choose the source recordings." },
      { title: "Continue reviewing", target: "recording-panel", fallback: "import", instruction: "Check the restored labels. JSON also restores the window and cursor. With the same reviewer ID, opening the same folder resumes its browser autosave automatically. Save downloads updated portable CSV and JSON copies.", unavailable: "Confirm the staged recording import first." },
    ],
  },
  {
    id: "jump-timestamp", topic: "navigate", title: "Jump to an exact timestamp", duration: "1 min", requires: "recording",
    description: "Go directly to recording time in seconds or clock notation.",
    steps: [
      { title: "Find Jump to", target: "timestamp-jump", instruction: "Find Jump to beside Window. It accepts seconds, mm:ss, or hh:mm:ss, including decimals: for example, 90.5 or 00:01:30.5.", unavailable: "Return to the recording toolbar.", tip: "Enter time from the start of the recording, even when the waveform axis is relative to a source event." },
      { completeOn: ["timestamp-jumped"], title: "Enter a time and go", target: "timestamp-jump", instruction: "Type a time in the Jump to hh:mm:ss bar, then press Enter. The time must fall within this recording. An invalid entry shows an explanation and leaves the view unchanged.", unavailable: "Load a recording to enable Jump to." },
      { title: "Check the pinned time", target: "waveform", instruction: "The app pauses playback, pins your chosen time, and centers the view where the file boundaries allow. Check the timestamp beside the playhead or in the bottom cursor readout before continuing.", unavailable: "Return to the waveform and enable a channel." },
    ],
  },
  {
    id: "continuous-playback", topic: "navigate", title: "Play with a centered playhead", duration: "1 min", requires: "recording",
    description: "Follow continuously scrolling data and understand buffering.",
    steps: [
      { completeOn: ["playback-started"], title: "Start playback", target: "transport", instruction: "Click Play in the waveform toolbar. If playback is already running, use Next. The guide will not start playback for you.", unavailable: "Load a recording and return to its waveform toolbar." },
      { title: "Follow the centered playhead", target: "waveform", instruction: "The playhead stays in the center while the waveform moves underneath it. Data loads ahead of the visible window. At the beginning or end of the recording, empty space may appear outside the file's actual time range.", unavailable: "Return to the waveform view.", tip: "Short background loads do not show a loading overlay. If data runs out, the clock and waveform wait together; Preparing signal window appears after about 300 ms. Playback resumes when the data is ready." },
      { completeOn: ["playback-stopped"], title: "Pause to inspect", target: "transport", instruction: "Click Pause before inspecting a detail, or let playback reach the recording's end. Clicking the waveform also pauses playback so you can pin a time or select a window.", unavailable: "Return to the playback controls.", tip: "Pausing during a wait preserves your current time. The guide never changes playback or chooses a timestamp for you." },
    ],
  },
  {
    id: "channel-groups", topic: "channels", title: "Group channels by name", duration: "1 min", requires: "recording",
    description: "Arrange related contacts together in MAT and EDF recordings.",
    steps: [
      { completeOn: ["groups-changed"], title: "Check the grouped view", target: "channel-groups", reveal: "view-panel", instruction: "New recordings open grouped. In Viewing Tools, click Group if grouping is off. Use Next if the control already says Ungroup.", unavailable: "Load a recording with channel names and return to the waveform toolbar." },
      { title: "Read groups and contacts", target: "channel-rail", instruction: "Related contacts share a group name and are spaced together. MAT + DAT uses MATLAB-style anatomical name rules. EDF / EDF+ uses channel-name families, such as LA1 and LA2, and keeps auxiliary or unrecognized channels visible.", unavailable: "Show the waveform's channel names.", tip: "Names alone do not confirm anatomy. Grouping changes layout, not the recorded signal or montage. MATLAB grouping can hide auxiliary rows when recognized groups exist; click Ungroup to see the full selected list again." },
      { completeOn: ["groups-changed"], title: "Return to the original layout", target: "channel-groups", reveal: "view-panel", instruction: "Click Ungroup to switch to the ungrouped layout. Group changes also participate in {shortcut:undo} and {shortcut:redo}. The view resets vertical zoom and channel scrolling when the grouping changes.", unavailable: "Return to the Ungroup button beside Montage." },
    ],
  },
  {
    id: "filter-label-display", topic: "labels", title: "Filter which labels are displayed", duration: "1 min", requires: "recording",
    description: "Hide selected label types while keeping their saved data.",
    steps: [
      { completeOn: ["label-filter-opened"], assist: { action: "open-label-filter", description: "Open Filter labels without changing any visibility choices." }, title: "Open Filter labels", target: "label-filter", fallback: "label-panel", readyTarget: "label-filter-dialog", reveal: "recording-panel", instruction: "Click the small Label dictionary button next to the Instance Queue search. It shows common keyword presets and detected label types.", unavailable: "Open Labels → Window / Instance." },
      { completeOn: ["label-filter-changed"], title: "Choose types to hide", target: "label-filter-dialog", instruction: "Enter comma-separated keywords in the Instance Queue search, or click a common keyword preset. The Seizure / Sz / Seiz preset searches the MATLAB aliases together, including tonic and EEG onset. Any keyword can match. Uncheck specific label types to hide them.", unavailable: "Open Filter labels first.", tip: "Hidden types disappear from the waveform, tracks, session labels, and event queues. Saving and exporting still retain their data. Hiding does not mean reviewed, skipped, or deleted." },
      { completeOn: ["label-filter-closed"], title: "Inspect the filtered view", target: "label-filter-dialog", instruction: "Close the dictionary using its × button. Inspect the waveform and queues; their visible counts can change. Existing recording events may be in the instance queue rather than the whole-session Session Labels section.", unavailable: "Return to the waveform to inspect the result." },
      { completeOn: ["label-filter-changed"], assist: { action: "open-label-filter", description: "Reopen the filter; you choose Show all.", completesStep: false }, title: "Restore hidden types", target: "label-filter-reset", fallback: "label-filter", reveal: "recording-panel", instruction: "Reopen the Instance Queue dictionary and click Show all to restore them. If annotations are still hidden, click Show all labels beside the same search.", unavailable: "Open Filter labels to reach Show all." },
    ],
  },
  {
    id: "review-source-event", topic: "labels", title: "Accept a source-event review", duration: "2 min", requires: "review",
    description: "Mark and accept an interval linked to a recording event.",
    steps: [
      { title: "Select a source event", target: "source-review", fallback: "recording-panel", reveal: "recording-panel", instruction: "Open a recording with seizure-source events and choose an event from the queue. The Source event review bar shows its original label, absolute time, and review status. A recording-supplied event is not an accepted review by itself.", unavailable: "Open an EDF+ or MAT + DAT recording with supported seizure-source events. If the bar is hidden, enable its type in the Instance Queue dictionary.", tip: "The separate legacy MAT + DAT seizure-review workflow requires at least 100 channels. That limit does not restrict ordinary waveform loading." },
      { title: "Check the review fields", target: "source-review-fields", fallback: "source-review", instruction: "Enter your reviewer initials. Add bad-channel notes when needed; they are separate from ictal-channel notes. Confidence and ictal-channel notes are retained in the saved review.", unavailable: "Select a supported source event to show its review fields." },
      { title: "Place onset and offset", target: "source-review-mark", dialogTarget: "label-confidence", fallback: "source-review", instruction: "Click Mark onset / offset, then click the onset and offset times on the waveform using your review criteria. The offset must follow onset. Enter the label’s confidence after marking the offset. Inspect both marks before accepting; use Redo marks if they need correction.", unavailable: "Select an unreviewed source event, or use Revise marks for an accepted review.", tip: "The walkthrough never places, chooses, or accepts marks for you. Your clicks are real review edits." },
      { completeOn: ["source-review-accepted"], title: "Accept and continue", target: "source-review-accept", dialogTarget: "commit-advisory", fallback: "source-review", instruction: "When satisfied, click Accept & next. Resolve any advisory deliberately. Acceptance commits the interval and advances to the next visible unfinished event. Skip records a separate decision and retains the skip decision in the saved review.", unavailable: "Place valid onset/offset marks and enter reviewer initials before accepting." },
      { title: "Write the CSV", target: "save", dialogTarget: "save-dialog", instruction: "Use Save, enter your reviewing signature, and download CSV + JSON. Accept & next keeps review state in this browser; it does not itself write the CSV. Reopen the CSV or JSON with your recording folder when you return.", unavailable: "Close any open dialog to reach Save.", tip: "All labels and drafts are retained, and recordings with no labels still have metadata rows. JSON also retains your exact position and settings." },
    ],
  },
  {
    id: "recover-browser-review", topic: "save", title: "Restore an older browser review", duration: "1 min", requires: "review",
    description: "Recover a review saved before the recording-loading changes.",
    steps: [
      { completeOn: ["settings-opened"], assist: { action: "open-settings", description: "Open Settings without changing preferences." }, title: "Open the matching recording", target: "settings", readyTarget: "settings-dialog", instruction: "Open the original recording first, then open Settings. Current per-recording recovery loads automatically; older browser reviews can be selected explicitly here.", unavailable: "Open the matching recording, then Settings.", tip: "Recovery is local to this browser. Clearing site storage removes it; saved CSV and JSON files provide portable copies of your review." },
      { completeOn: ["older-review-opened"], title: "Show older reviews", target: "older-review-open", fallback: "settings-dialog", readyTarget: "older-review-dialog", instruction: "In Settings, click Restore older browser review. Read the available recording name, date, reviewer, and label/event counts. This control is disabled in managed folder reviews. For older browser recovery, open the original recording separately using Files; folder reviews use their own saved progress.", unavailable: "Open Settings to find browser recovery." },
      { title: "Choose the correct review", target: "older-review-picker", fallback: "older-review-dialog", instruction: "Select the review that belongs to this recording. Some older entries have no useful filename; verify the source before choosing. If no entries exist or you cannot identify the correct one, cancel instead of guessing.", unavailable: "Open Restore older browser review.", tip: "This is browser recovery, separate from reopening CSV or JSON through Upload." },
      { completeOn: ["older-review-restored"], title: "Restore and inspect", target: "older-review-restore", fallback: "older-review-dialog", instruction: "Click Restore selected review only when the source matches. If no older reviews are listed, cancel and end this walkthrough. The app validates its labels and keeps the current review as a browser backup. After success, inspect the restored marks before continuing or saving.", unavailable: "Select an available review for the currently loaded recording. The walkthrough never restores data for you." },
    ],
  },
];

/** Explains why the current walkthrough action is unavailable. */
export function tutorialBlockReason(lesson: TutorialLesson, hasRecording: boolean, canAnnotate: boolean): string | null {
  if (lesson.requires !== "workspace" && !hasRecording) return "Open a recording first to try this in the workspace. You can still read every step here.";
  if (lesson.requires === "review" && !canAnnotate) return "Finish opening the recording before adding labels. You can read the steps in the meantime.";
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
  /** Calculates the overlap area between a coach position and its padded target. */
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
