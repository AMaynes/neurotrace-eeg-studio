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
      { completeOn: ["import-opened"], assist: { action: "open-import", description: "Open the recording loader." }, title: "Open the file loader", target: "upload", readyTarget: "import", instruction: "Click Upload at the top right. This opens the recording loader; it does not upload your files to a server.", unavailable: "Close any other dialog to reach Upload.", tip: "Session tabs keep separate workspaces. Use + first if you want a new, blank session." },
      { completeOn: ["import-format-chosen"], title: "Choose your format", target: "import-formats", fallback: "upload", instruction: "Choose EDF / EDF+, MAT, MAT + DAT, or NeuroTrace. This reveals Files and Folder choices for that format. For a legacy metadata MAT with separate signal bytes, choose MAT + DAT.", unavailable: "Click Upload to open the format choices." },
      { completeOn: ["import-files-ready", "recording-opened"], title: "Choose files or a folder", target: "import-files", fallback: "import-formats", instruction: "Click Files to open the file picker and select one or multiple files; select both the MAT and DAT for a pair. Or click Folder to select a directory, including its subfolders. One recording selected through Files opens automatically; multiple recordings or a folder show a session list preview.", unavailable: "Choose a recording format to reveal Files and Folder.", tip: "Drop individual files onto the homepage or workspace. For a folder drop, choose a format, click Folder, cancel the directory picker, then drop inside the loader dialog. Folders include only your selected recording type and ignore other types." },
      { title: "Open and check the recording", target: "waveform", fallback: "import", instruction: "For a batch, click Load N sessions, then Open beside a session. If a DAT layout form appears, verify its channel count, sample rate, sample format, and calibration before confirming. Once the waveform appears, check the channel names, units, and duration, then select Next.", unavailable: "Finish the loader or session list to open a recording.", tip: "Do not guess DAT layout or calibration. A waveform can look plausible with incorrect settings. Review becomes available after the recording setup finishes. The whole-session overview and EDF+ event labels can continue loading in the background; you do not need to wait for a full-file scan." },
    ],
  },
  {
    id: "workspace", topic: "start", title: "Find your way around", duration: "1 min", requires: "recording",
    description: "Meet the recording panel, signal tools, and labeling area.",
    steps: [
      { title: "Session tabs", target: "sessions", instruction: "Each top tab is an independent workspace. Switch tabs to return to another session; + creates a blank one.", unavailable: "Close any open dialog to see the session tabs." },
      { title: "Recording info and queue", target: "recording-panel", reveal: "recording-panel", instruction: "The left panel holds recording information, whole-session labels, and the instance queue. Queue entries jump to their time in the recording.", unavailable: "Show the left recording panel to see these tools." },
      { title: "Signal tools", target: "signal-tools", instruction: "The toolbar controls montage, filters, time window, gain, and trace display. These adjust the view; they do not rewrite raw samples.", unavailable: "Return to a session with a waveform." },
      { title: "Labeling tools", target: "label-panel", reveal: "label-panel", instruction: "The right panel holds timed context and ePhys labels. Use the panel buttons in Signal tools whenever you need more room for the waveform.", unavailable: "Show the Labeling tools panel." },
    ],
  },
  {
    id: "load-directory", topic: "directories", title: "Load a directory", duration: "2 min", requires: "workspace",
    description: "Choose a folder and open recordings from its session list.",
    steps: [
      { completeOn: ["import-opened"], assist: { action: "open-import", description: "Open the recording loader. You choose the files." }, title: "Open the loader", target: "upload", readyTarget: "import", instruction: "Click Upload at the top right, or Load a recording on the homepage.", unavailable: "Close any other dialog to reach Upload." },
      { completeOn: ["import-format-chosen"], title: "Choose one format", target: "import-formats", fallback: "upload", instruction: "Choose EDF / EDF+, MAT, MAT + DAT, or NeuroTrace. The folder list includes only the type you select; other recording types are ignored. Use MAT + DAT when the MAT metadata and signal bytes are separate files.", unavailable: "Open Upload to choose a format.", tip: "MAT + DAT still requires complete same-name pairs in the same folder. Signal contents are checked when you open each session." },
      { completeOn: ["directory-files-ready"], title: "Choose Folder", target: "import-folder", fallback: "import-formats", instruction: "Click Folder, select the directory in the file picker, and confirm it. Subfolders are included. Use Files instead if you want to select individual files or several recordings without choosing a whole folder.", unavailable: "Choose a format to reveal the Folder button.", tip: "The homepage accepts individual files, including a MAT + DAT pair, but not folder drops. To drop a folder, first choose the format and Folder, cancel the picker, then drop inside the loader." },
      { completeOn: ["directory-list-opened"], title: "Confirm the session list", target: "import-open", fallback: "import", readyTarget: "directory-list", instruction: "Check the detected paths and session count, then click Load N sessions. This creates the directory list; it does not read every recording into memory.", unavailable: "Select a folder first. If there is an error, correct the file selection before continuing." },
      { title: "Open one recording", target: "directory-list", fallback: "sessions", instruction: "Click Open beside a recording. If a MAT + DAT layout form appears, verify its settings before confirming. Check the waveform, channel names, units, and duration once it opens.", unavailable: "Click the directory name above the tabs to reopen its session list.", tip: "Resume beside a recording returns to its already-open session; Continue reviewing uses saved CSVs to resume across files. Keep DAT channel count, sample rate, sample format, and calibration based on known metadata, not guesses." },
    ],
  },
  {
    id: "directory-navigation", topic: "directories", title: "Navigate directory files", duration: "1 min", requires: "recording",
    description: "Use the directory header and its Previous and Next buttons.",
    steps: [
      { title: "Find the directory header", target: "directory-header", fallback: "sessions", instruction: "The directory name sits above its session tabs and spans adjacent tabs from that directory. Select a recording tab from the directory you want to browse.", unavailable: "Load a directory and open one of its recordings first.", tip: "These buttons change files. The playback arrows in Signal tools move through time within one recording." },
      { title: "Next file", target: "directory-next", fallback: "sessions", instruction: "The right arrow opens the next recording in the directory list and closes the currently viewed tab after the new recording loads successfully. If that next recording is already open, it switches to its tab instead of loading it again.", unavailable: "Close any dialog and select an open directory recording.", tip: "Next is gray at the last file. Navigation is also unavailable while a file is opening or waiting for DAT layout confirmation. This guide will not change files for you." },
      { title: "Previous file", target: "directory-previous", fallback: "sessions", instruction: "The left arrow does the same thing in reverse. It is gray at the first file. When Bias Locks is enabled in Settings, a lock replaces this arrow and backward directory navigation is disabled.", unavailable: "Close any dialog and select an open directory recording.", tip: "The buttons follow the directory list order, not the order of open tabs. They do not wrap around at either end." },
      { title: "Open the full list", target: "directory-header", readyTarget: "directory-list", fallback: "sessions", instruction: "Click the directory name to see its sessions. Keyword searching is not supported for EDF. For other formats, type event keywords, or choose them from …. Press Enter or Search to add filter tags; typing alone does not filter. Any tag can match. Remove a tag with ×. Incomplete checks are shown separately. Open loads a recording; Resume beside a recording returns to its open tab. Continue reviewing resumes from saved CSVs.", unavailable: "Load a directory to show its header above the tabs.", tip: "Opening from this list keeps other tabs open. Filtering only affects this list, not the header arrows. Bias Locks does not block manual selection. Close the list when finished." },
    ],
  },
  {
    id: "bias-locks", topic: "directories", title: "Bias Locks", duration: "1 min", requires: "workspace",
    description: "Enable or disable the directory Previous button.",
    steps: [
      { completeOn: ["settings-opened"], assist: { action: "open-settings", description: "Open Settings without changing any options." }, title: "Open Settings", target: "settings", readyTarget: "settings-dialog", instruction: "Click the gear at the top right to open Settings. Bias Locks is at the top.", unavailable: "Close any other dialog to reach Settings." },
      { completeOn: ["bias-locks-changed"], title: "Enable or disable Bias Locks", target: "bias-locks", fallback: "settings", instruction: "Set Bias Locks to Enabled to disable the directory Previous button. Set it to Disabled to allow Previous again. Leave it as it is and select Next if you do not want to change the setting.", unavailable: "Open Settings to reach Bias Locks.", tip: "The setting applies across directory tabs and is remembered in this browser. This guide never changes it for you." },
      { title: "Check the lock icon", target: "directory-previous", fallback: "sessions", instruction: "Close Settings and look at the directory header. When enabled, a lock replaces the left arrow. Next still works unless you are at the last file or a recording is loading.", unavailable: "Close Settings, then load a directory and open a recording to see its navigation buttons.", tip: "Bias Locks only blocks the directory Previous control. It does not block the full session list, switching open tabs, or moving backward in waveform time." },
    ],
  },
  {
    id: "pan-time", topic: "navigate", title: "Move through time", duration: "1 min", requires: "recording",
    description: "Jump, pan, and page without losing your place.",
    steps: [
      { completeOn: ["overview-jumped"], assist: { action: "jump-overview", description: "Jump forward by one window (backward at the end)." }, title: "Jump from the overview", target: "overview", instruction: "Click the Full session overview to jump to a different part of the recording. Its highlighted section shows the current window.", unavailable: "Return to the recording view to see the overview." },
      { completeOn: ["waveform-panned"], assist: { action: "pan-waveform", description: "Pan by one second." }, title: "Pan the waveform", target: "waveform", instruction: "Use the mouse wheel or trackpad over the waveform to move through time. One-second keys: {shortcut:panLeft} / {shortcut:panRight}. Ten-second keys: {shortcut:panLeftFast} / {shortcut:panRightFast}.", unavailable: "Load a recording and enable at least one channel.", tip: "Keyboard navigation works when you are not typing in a field or focused on a toolbar button. Change shortcuts in Settings." },
      { completeOn: ["transport-used"], assist: { action: "page-forward", description: "Move by one window, without starting playback." }, title: "Page or play", target: "transport", instruction: "Use ‹ and › to move by a full window. Play keeps the playhead centered while data scrolls underneath it and loads ahead. Click Pause when you are done; long waits hold the waveform and clock together.", unavailable: "Return to the waveform toolbar." },
    ],
  },
  {
    id: "zoom-waveform", topic: "navigate", title: "Zoom into a waveform", duration: "1 min", requires: "recording",
    description: "Set an exact time window or draw a box around a detail.",
    steps: [
      { completeOn: ["window-applied"], assist: { action: "shorten-window", description: "Halve the current time window." }, title: "Set the time window", target: "window", instruction: "Enter a Window amount and use … to cycle the unit. Press the check button to apply it. Smaller windows show more detail.", unavailable: "Return to the waveform toolbar." },
      { completeOn: ["waveform-zoom-enabled"], assist: { action: "enable-waveform-zoom", description: "Turn on waveform box zoom." }, title: "Choose Box zoom", target: "waveform-zoom", instruction: "Click the Box zoom button near the playback controls. It switches waveform dragging from selecting a labeling window to zooming.", unavailable: "Return to the waveform toolbar." },
      { completeOn: ["waveform-zoomed"], assist: { action: "zoom-waveform", description: "Zoom into the middle half of the visible time range." }, title: "Draw the area to inspect", target: "waveform", instruction: "Drag a rectangle across the time and channel area you want to enlarge. The waveform fits that box. Pinch also changes time zoom. Zoom keys: {shortcut:zoomIn} / {shortcut:zoomOut}.", unavailable: "Load a recording and enable a channel." },
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
      { completeOn: ["gain-changed"], assist: { action: "increase-gain", description: "Increase the display gain by one step (decrease at the maximum)." }, title: "Adjust gain", target: "gain", instruction: "Enter a Gain from 0.01× to 4×, then press {shortcut:gainApply} or leave the field to apply. Use {shortcut:clear} while typing to cancel, or + / − to adjust the gain. This scales the display without changing the recording.", unavailable: "Return to the waveform toolbar.", tip: "Traces center automatically on the current time window. Vertical scrolling and gain changes keep those centers fixed. Centering changes only display position, not recorded values, drift, or missing samples." },
      { completeOn: ["clamp-changed"], assist: { action: "toggle-clamp", description: "Switch between Clamped and Overlap." }, title: "Switch Clamped / Overlap", target: "clamp", instruction: "The button just right of Gain switches modes. Clamped keeps traces inside their rows and uses a colored heat line for overflow. Overlap allows traces to cross neighboring rows.", unavailable: "Return to the waveform toolbar.", tip: "A flat line at the row boundary in Clamped mode can be display clipping, not a flat raw signal. Switch to Overlap or lower gain to inspect it." },
      { completeOn: ["filters-opened"], assist: { action: "open-filters", description: "Open filter controls without changing any filters." }, title: "Inspect display filters", target: "filters", instruction: "Open Filters to inspect the optional high-pass, low-pass, and notch settings. When these are off, the waveform uses the MATLAB reviewer's display preparation, including its automatic FIR filtering at wider windows.", unavailable: "Return to the waveform toolbar.", tip: "The spectrogram uses full-resolution raw source channels, not waveform filters or montage differences." },
    ],
  },
  {
    id: "read-spectrogram", topic: "spectrogram", title: "Read the spectrogram", duration: "2 min", requires: "recording",
    description: "Understand time, frequency, colors, and channel selection.",
    steps: [
      { completeOn: ["spectrogram-opened"], assist: { action: "open-spectrogram", description: "Show the spectrogram." }, title: "Open the spectrogram", target: "spectrogram-toggle", readyTarget: "spectrogram-plot", instruction: "Click Spectrogram in Signal tools to show the time-frequency panel below the waveform. Leave it open for the next steps.", unavailable: "Return to the waveform toolbar." },
      { title: "Read the axes and colors", target: "spectrogram-plot", reveal: "spectrogram", instruction: "Time runs left to right, aligned with the waveform. Frequency increases upward in Hz. Colors show Gabor wavelet log-power as standard deviations from the pre-click baseline: warm colors are above that baseline and cool colors are below it.", unavailable: "Open Spectrogram in Signal tools.", tip: "This matches the MATLAB reviewer's relative log-power view, not absolute voltage or an automatic interpretation. Very short pre-click baselines use its first-half fallback." },
      { completeOn: ["channel-focused"], title: "Focus a channel", target: "channel-rail", instruction: "Click a channel name to select its raw electrode group. The spectrogram averages power across that complete source group, including contacts hidden from the waveform; ungrouped channels are analyzed individually.", unavailable: "Return to the waveform and channel names." },
      { title: "Check the analyzed window", target: "spectrogram-plot", reveal: "spectrogram", instruction: "The spectrogram covers the entire visible time window. Double-click the waveform to choose the pre-click baseline anchor. Long windows show a full-window wavelet overview; zoom in for exact short-window detail.", unavailable: "Open Spectrogram in Signal tools.", tip: "Long views use overlapping sections and time-bin averaging with one shared baseline. Recorded-reference, average-reference, and bipolar display choices do not change the raw channels used for group power." },
      { completeOn: ["spectrogram-adjusted"], title: "Set frequency and color range", target: "spectrogram-controls", reveal: "spectrogram", instruction: "Frequency range controls the visible Hz band. C− / C+ adjust the symmetric color limits, not the signal. The initial limits use the 98th percentile of absolute Z-scores in the retained frequency rows, with a minimum of ±1.", unavailable: "Open Spectrogram in Signal tools.", tip: "The MATLAB wavelet calculation is retained, with up to 60 original log-spaced frequency centers placed at their true Hz positions. Centers above 150 Hz or half the sample rate (Nyquist) are excluded. No extra whitening or smoothing is applied." },
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
      { completeOn: ["annotation-inspected"], assist: { action: "show-label-tracks", description: "Show annotation tracks so you can inspect the result.", completesStep: false }, title: "Review the result", target: "label-tracks", reveal: "label-tracks", instruction: "Find the annotation in the instance or window track. Select it to inspect timing and other details. Review before committing; Clear selection uses {shortcut:clear}.", unavailable: "Show the bottom label tracks.", tip: "Finishing a tutorial does not commit or save labels. These manual labels stay in browser recovery; the top-bar CSV contains accepted source-event seizure reviews only. Settings offers the model-ready bundle for other annotation data." },
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
    id: "save-project", topic: "save", title: "Save annotations to CSV", duration: "1 min", requires: "recording",
    description: "Save accepted seizure reviews in the MATLAB format.",
    steps: [
      { completeOn: ["save-opened"], assist: { action: "open-save", description: "Open Save; nothing is saved yet." }, title: "Open Save", target: "save", readyTarget: "save-dialog", instruction: "Click Save at the top right. The CSV contains accepted seizure reviews, using the same columns as the MATLAB viewer.", unavailable: "Close any other dialog to reach Save." },
      { title: "Check the details", target: "save-details", fallback: "save", instruction: "Check reviewer initials and source paths. MATLAB stores full paths; the browser cannot supply those automatically. Bad channels come from the separate field in the source-event review bar. Drafts, skipped events, and other label types are not saved to this CSV. With no accepted source-event reviews, it contains only the 14 column headers.", unavailable: "Click Save to check the details." },
      { completeOn: ["annotations-saved"], title: "Save to your computer", target: "save-confirm", fallback: "save", instruction: "Click Save CSV. Choose an existing MATLAB annotation CSV to retain its earlier rows and update matching events. Browsers without a save-location dialog download a new file. Loaded folder reviews are retained even if their recordings were not reopened. The guide will not press Save for you.", unavailable: "Click Save to open the CSV dialog." },
    ],
  },
  {
    id: "resume-directory-review", topic: "directories", title: "Resume a saved folder review", duration: "2 min", requires: "workspace",
    description: "Use saved CSVs to continue at the first unfinished source event.",
    steps: [
      { completeOn: ["directory-list-opened"], assist: { action: "open-directory-list", description: "Show the current directory list without opening a recording." }, title: "Reopen your recording folder", target: "directory-header", fallback: "upload", readyTarget: "directory-list", instruction: "Select the same recording folder through Upload, choose Load N sessions, then open its directory list. If it is already loaded, click its name above the tabs.", unavailable: "Use Load a directory first, or reopen a loaded directory from its header.", tip: "After reloading the browser you must select the local folders again. This resumes saved event reviews, rather than an exact paused playback time." },
      { completeOn: ["review-csvs-loaded"], title: "Load saved reviews", target: "directory-review-files", fallback: "directory-list", instruction: "Annotation CSVs inside the recording folder load automatically. For files stored elsewhere, choose Load saved CSVs or Choose reviews folder. Check the matched review count; use Next if the CSVs were already loaded.", unavailable: "Open Directory sessions to find Continue reviewing.", tip: "Unmatched or ambiguous paths and unreadable CSVs are reported. Keep the original folder structure and MATLAB source paths when possible. A header-only CSV has no completed events to skip." },
      { completeOn: ["directory-review-found"], title: "Find the first unfinished event", target: "directory-review-resume", fallback: "directory-list", instruction: "Click Resume first unfinished event. The app checks source events in folder order and skips accepted reviews. Cancel stops the search. If every supported event is complete, or no seizure events exist, read the summary and select Next.", unavailable: "Open the directory list and load your saved reviews.", tip: "Incomplete event metadata stops resume with an explanation; it is not treated as completed review. The guide never starts this scan or chooses a recording for you." },
      { title: "Check the resumed event", target: "source-review", fallback: "import", instruction: "For MAT + DAT, confirm the known layout before opening. Check the selected source event and its absolute time. Accepted marks and bad-channel notes are restored, and local drafts and decisions are kept. Save CSV when you want to write your latest accepted reviews to disk.", unavailable: "Finish any import confirmation, or close the completed-review summary to inspect the recording.", tip: "Earlier matched CSV rows remain in later saves, including reviews from recordings you did not reopen." },
    ],
  },
  {
    id: "jump-timestamp", topic: "navigate", title: "Jump to an exact timestamp", duration: "1 min", requires: "recording",
    description: "Go directly to recording time in seconds or clock notation.",
    steps: [
      { title: "Find Jump to", target: "timestamp-jump", instruction: "Find Jump to beside Window. It accepts seconds, mm:ss, or hh:mm:ss, including decimals: for example, 90.5 or 00:01:30.5.", unavailable: "Return to the recording toolbar.", tip: "Enter time from the start of the recording, even when the waveform axis is relative to a source event." },
      { completeOn: ["timestamp-jumped"], title: "Enter a time and go", target: "timestamp-jump", instruction: "Enter a time you want to inspect, then press Enter or click Go. The time must fall within this recording. An invalid entry shows an explanation and leaves the view unchanged.", unavailable: "Load a recording to enable Jump to." },
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
      { completeOn: ["groups-changed"], title: "Toggle Groups", target: "channel-groups", instruction: "Click Groups beside Montage. If grouping is already on, use Next to inspect it. Grouping starts off for new recordings and is remembered separately in each open session.", unavailable: "Load a recording with channel names and return to the waveform toolbar." },
      { title: "Read groups and contacts", target: "channel-rail", instruction: "Related contacts share a group name and are spaced together. MAT + DAT uses MATLAB-style anatomical name rules. EDF / EDF+ uses channel-name families, such as LA1 and LA2, and keeps auxiliary or unrecognized channels visible.", unavailable: "Show the waveform's channel names.", tip: "Names alone do not confirm anatomy. Grouping changes layout, not the recorded signal or montage. MATLAB grouping can hide auxiliary rows when recognized groups exist; toggle Groups off to see the full selected list again." },
      { completeOn: ["groups-changed"], title: "Return to the original layout", target: "channel-groups", instruction: "Toggle Groups off to restore the ungrouped layout. Group changes also participate in {shortcut:undo} and {shortcut:redo}. The view resets vertical zoom and channel scrolling when the grouping changes.", unavailable: "Return to the Groups button beside Montage." },
    ],
  },
  {
    id: "filter-label-display", topic: "labels", title: "Filter which labels are displayed", duration: "1 min", requires: "recording",
    description: "Hide selected label types while keeping their saved data.",
    steps: [
      { completeOn: ["label-filter-opened"], assist: { action: "open-label-filter", description: "Open Filter labels without changing any visibility choices." }, title: "Open Filter labels", target: "label-filter", fallback: "label-panel", readyTarget: "label-filter-dialog", reveal: "label-panel", instruction: "Click Filter labels at the top of the right panel. It controls existing file labels and annotation types, separately from the ePhys palette chooser.", unavailable: "Show the right Labeling tools panel." },
      { completeOn: ["label-filter-changed"], title: "Choose types to hide", target: "label-filter-dialog", instruction: "Find a type by name and uncheck it to hide that type. Check it to show it again. File label and Annotation type identify the two kinds of entries.", unavailable: "Open Filter labels first.", tip: "Hidden types disappear from the waveform, tracks, session labels, and event queues. Saving and exporting still retain their data. Hiding does not mean reviewed, skipped, or deleted." },
      { completeOn: ["label-filter-closed"], title: "Inspect the filtered view", target: "label-filter-dialog", instruction: "Click Done or close the filter. Inspect the waveform and queues; their visible counts can change. Existing recording events may be in the instance queue rather than the whole-session Session Labels section.", unavailable: "Return to the waveform to inspect the result." },
      { completeOn: ["label-filter-changed"], assist: { action: "open-label-filter", description: "Reopen the filter; you choose Show all types.", completesStep: false }, title: "Restore hidden types", target: "label-filter-reset", fallback: "label-filter", reveal: "label-panel", instruction: "Reopen Filter labels and click Show all types to restore them. Hide all labels is a separate master visibility control; turn it back on too if annotations are still hidden.", unavailable: "Open Filter labels to reach Show all types." },
    ],
  },
  {
    id: "review-source-event", topic: "labels", title: "Accept a source-event review", duration: "2 min", requires: "review",
    description: "Create the accepted onset/offset review used by the MATLAB CSV.",
    steps: [
      { title: "Select a source event", target: "source-review", fallback: "recording-panel", reveal: "recording-panel", instruction: "Open a recording with seizure-source events and choose an event from the queue. The Source event review bar shows its original label, absolute time, and review status. A recording-supplied event is not an accepted review by itself.", unavailable: "Open an EDF+ or MAT + DAT recording with supported seizure-source events. If the bar is hidden, show its event type in Filter labels.", tip: "The separate legacy MAT + DAT seizure-review workflow requires at least 100 channels. That limit does not restrict ordinary waveform loading." },
      { title: "Check the review fields", target: "source-review-fields", fallback: "source-review", instruction: "Enter your reviewer initials. Add bad-channel notes when needed; they are separate from ictal-channel notes. Confidence and ictal-channel notes are optional and are not columns in the MATLAB annotation CSV.", unavailable: "Select a supported source event to show its review fields." },
      { title: "Place onset and offset", target: "source-review-mark", fallback: "source-review", instruction: "Click Mark onset / offset, then click the onset and offset times on the waveform using your review criteria. The offset must follow onset. Inspect both marks before accepting; use Redo marks if they need correction.", unavailable: "Select an unreviewed source event, or use Revise marks for an accepted review.", tip: "The walkthrough never places, chooses, or accepts marks for you. Your clicks are real review edits." },
      { completeOn: ["source-review-accepted"], title: "Accept and continue", target: "source-review-accept", fallback: "source-review", instruction: "When satisfied, click Accept & next. Resolve any advisory deliberately. A successful acceptance commits the interval and advances to the next unfinished event when one exists. Skip records a separate decision and does not add an accepted CSV row.", unavailable: "Place valid onset/offset marks and enter reviewer initials before accepting." },
      { title: "Write the CSV", target: "save", instruction: "Use Save to write accepted reviews to a CSV on your computer. Accept & next keeps review state in this browser; it does not itself write the CSV. Folder resume can then use that CSV when you return.", unavailable: "Close any open dialog to reach Save.", tip: "Without accepted source-event reviews, the CSV contains its 14 column headers and no data rows. Other label types and drafts remain outside this MATLAB-format export." },
    ],
  },
  {
    id: "recover-browser-review", topic: "save", title: "Restore an older browser review", duration: "1 min", requires: "review",
    description: "Recover a review saved before the recording-loading changes.",
    steps: [
      { completeOn: ["settings-opened"], assist: { action: "open-settings", description: "Open Settings without changing preferences." }, title: "Open the matching recording", target: "settings", readyTarget: "settings-dialog", instruction: "Open the original recording first, then open Settings. Current per-recording recovery loads automatically; older browser reviews can be selected explicitly here.", unavailable: "Open the matching recording, then Settings.", tip: "Recovery is local to this browser. Clearing site storage removes it; a saved CSV is the portable option for accepted source-event reviews." },
      { completeOn: ["older-review-opened"], title: "Show older reviews", target: "older-review-open", fallback: "settings-dialog", readyTarget: "older-review-dialog", instruction: "In Settings, click Restore older browser review. Read the available recording name, date, reviewer, and label/event counts.", unavailable: "Open Settings to find browser recovery." },
      { title: "Choose the correct review", target: "older-review-picker", fallback: "older-review-dialog", instruction: "Select the review that belongs to this recording. Some older entries have no useful filename; verify the source before choosing. If no entries exist or you cannot identify the correct one, cancel instead of guessing.", unavailable: "Open Restore older browser review.", tip: "This is browser recovery, separate from the folder list's saved CSV resume." },
      { completeOn: ["older-review-restored"], title: "Restore and inspect", target: "older-review-restore", fallback: "older-review-dialog", instruction: "Click Restore selected review only when the source matches. The app validates its labels and keeps the current review as a browser backup. After success, inspect the restored marks before continuing or saving.", unavailable: "Select an available review for the currently loaded recording. The walkthrough never restores data for you." },
    ],
  },
];

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
