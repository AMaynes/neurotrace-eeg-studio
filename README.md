# NeuroTrace — Clinical EEG Studio

NeuroTrace is a local-first EEG/iEEG review and annotation workstation for research data curation and seizure-forecasting workflows. It is designed for reviewers who need precise context, window, and instance labeling without uploading the source recording to an application server.

Canonical public app: https://amaynes.github.io/neurotrace-eeg-studio/

NeuroTrace is a research annotation and data-curation workspace. It is not a diagnostic system or autonomous clinical decision tool.

## Running the Project

NeuroTrace supports current macOS, Linux, and Windows development environments with Node.js 22.13 or newer.

### One-click local launch on macOS

Double-click **`Launch NeuroTrace.command`** in the copied or cloned project folder. Enter any available port from 1024 through 65535 in the popup and select **Start**. The launcher prepares the viewer when needed, hosts it only on this Mac, and opens it in the default browser.

Keep the Terminal window opened by the launcher running while using NeuroTrace. Press **Control-C** in that window to stop the local viewer. The first launch requires an internet connection if the project dependencies have not already been installed.

### Command-line development

```bash
npm install
npm run dev
```

The development server prints the local URL after startup.

### Reproducible GitHub Pages release

`main` is the canonical project branch and the only routine push target. The
`backup` branch is a point-in-time safety copy; it is not part of the normal
development or deployment flow.

The canonical static release is built from `main` without a server adapter:

```bash
npm ci
npm run check
```

`npm run check` type-checks and lints the source, builds both supported targets,
and tests the generated Pages artifact. To produce only the static artifact, run
`npm run build:pages`; it recreates `pages-dist/` with `index.html`, hashed
JavaScript and CSS under `assets/`, and `og.png`. All runtime asset references are
document-relative so the output works at the GitHub project path as well as from a
local static server.

Every push to `main` runs the GitHub Pages workflow, which:

1. Installs the locked dependencies.
2. Runs the complete type-check, lint, build, and test suite.
3. Uploads `pages-dist/` as the exact GitHub Pages artifact.
4. Publishes only after verification succeeds.

`app/pages-client.tsx`, `index.html`, and `vite.pages.config.ts` are the committed
source of this artifact. Generated files in `pages-dist/` and the deployed bundle
must not be hand-edited or committed.

## Tutorials

The top-right `?` opens a tutorial hub with six topic tabs and 11 task-based lessons. Steps advance automatically when their action is completed; reading-only steps wait for Next, and Back/Next remain available throughout. A slow pulsing outline highlights the target (steady when reduced motion is preferred). “Do it for me” can open tools, navigate, adjust the view, or select an example time window; it never chooses files, creates annotations, or saves a project. Each button explains its action. Drag the walkthrough’s top bar to move it aside; it keeps your preferred position unless that covers the highlighted target. The guide moves clear of the target, including inside dialogs, or covers the smallest possible area when space is tight. ↺ restores automatic placement. The spectrogram’s `?` opens the same hub on its Spectrogram tab. Completed walkthroughs are tracked for the current app visit.

## System Overview

The browser owns the active recording and annotation state. `app/page.tsx` coordinates the interface and session workflow, `app/eeg-core.ts` parses recordings and supplies time-bounded signal windows and zoomed-out display envelopes, and the source-integrity modules compute a stable source fingerprint off the main UI thread. Annotation recovery uses browser-local storage; exports are assembled and downloaded locally.

EDF, raw DAT, and MATLAB v7.3/HDF5 recordings remain file-backed after import. The viewer requests only the records, frames, or HDF5 dataset slices needed for the current time window. MATLAB v5 recordings are decoded into memory because compressed MATLAB elements are not independently seekable.

See [STRUCTURE.md](STRUCTURE.md) for the authoritative repository map and [TODO.md](TODO.md) for prioritized engineering work.

## Recording Ingestion

- **Recording selection:** Click **Load a recording**, then choose **EDF / EDF+**, **MAT**, **MAT + DAT**, or **NeuroTrace**. Next, click **Files** to open the file picker or **Folder** to open the directory picker. Files supports one or multiple selections; for MAT + DAT, select both matching files together. Folder includes subfolders automatically. A single recording selected through Files opens normally; multiple recordings or a folder become a same-format session collection, even if the folder contains just one recording.
- **Drag and drop:** The homepage and workspace accept individual files, including multiple recordings or a MAT + DAT pair. Folder drops are accepted only inside **Load a recording**, after choosing a format and clicking **Folder**. To drop instead of browse, cancel the directory picker and drop the folder into that dialog. Additional companion files can be dropped onto an active workspace without replacing its waveform.
- **Full-directory session loading:** The loader filters folders by your selected recording format (or auto-detects a collection when no format was explicitly chosen), previews matching sessions, then offers **Load N sessions**. Folder selection and folder drops include subfolders; sessions are listed in natural path order. Use the **Directory** button beside the session tabs to open or resume any entry. The paginated list retains local file references and a small event-label index, not decoded waveforms or recording hashes. Each selected recording opens in its own tab through the existing verification workflow; MAT + DAT still requires its own layout confirmation. Selecting a new directory replaces the list, not open tabs; clearing the list never deletes files. The file-reference list lasts for the current browser session and must be selected again after a reload.
  - **Filter by event label:** In the directory list, type a label keyword or click **…** beside the search field for editable presets such as Seizure, Spikes, Artifact, and Stimulation. Matching is case-insensitive literal text: commas mean **any** keyword, and spaces remain a phrase (for example, `seizure, EEG onset`). This searches existing event-label text, not filenames, and does not classify signals or infer diagnoses. **Clear** restores the list. Filtering only changes this list; header previous/next navigation retains the original directory order.
  - **Background label checks:** While the list is open, a local worker checks EDF+ annotations, known Level-5 MAT `sessionInfo.sFile.events` metadata (including MAT + DAT companions), matching events TSVs, and saved project labels. DAT samples are never read for this search. Uncompressed MAT waveform payloads are skipped; compressed containers must be streamed through, so their first check can take longer. Closing the list or starting an import stops the scan; reopening reuses completed checks. Progress, incomplete checks, **Include unchecked / partially checked sessions**, and **Retry** prevent unreadable files from looking like confirmed non-matches. Unsupported MAT formats (including v7.3/HDF5 event metadata), malformed data, or safety-limit failures remain explicitly incomplete. Search does not verify recordings or alter review state; cached labels/query are memory-only and reset when a directory is selected again or the page reloads.
  - **Format-filtered folders:** Mixed folders are allowed. Choosing **EDF / EDF+**, **MAT**, **MAT + DAT**, or **NeuroTrace** includes only that type; other recording types are ignored, not attached as metadata. No matching files produces an explicit message rather than opening another format. Automatic detection without a chosen folder format still rejects mixed collections instead of guessing. Duplicate case-insensitive selected paths and incomplete MAT + DAT pairs remain errors. MAT + DAT requires matching basenames in the same folder; a namesake in another folder is not a partner. JSON/TSV and other non-recording companions are allowed. Filename discovery is not content validation: each opened MAT is checked against the collection format, and unreadable or mismatched entries show a retryable error instead of silently changing formats. Projects use their saved contents, not nearby companion files. Projects opened from a collection must include their recording; for a reference-only project, open its original recording first and then open the project through Files.
  - **Session isolation:** A recording receives only matching companions in its own folder or ancestor folders, never a sibling session's files. Per-recording sidecars require compatible filenames; ambiguous non-BIDS sidecars are not automatically attached. Distinct directory paths keep separate tabs and path-scoped local recovery even when source bytes are identical. Single-file imports retain their existing content-based recovery; open a recording individually to access review state saved through that workflow. Renaming/moving a directory changes its path-scoped recovery key, so export important review state first.
- **Custom definitions:** Dictionaries, word lists, equations, filtering methods, label definitions, and channel groupings can be dropped alongside recording files. They remain inert local data; NeuroTrace does not execute imported text or code.
- **EDF and EDF+:** Header metadata is parsed first, so a read-only waveform preview can open without waiting for the full file scan. Signal data is read from the local `File` in bounded time windows. A background pass verifies the exact SHA-256 identity and extracts EDF+ annotation records together; all valid annotations become unreviewed recording labels, while seizure-keyword events also enter the separate source-event review queue. Review edits and export remain locked until verification finishes.
- **MATLAB v5:** The largest viable numeric signal matrix is decoded in memory. Compressed elements are supported.
- **MATLAB v7.3/HDF5:** The largest viable two-dimensional numeric dataset stays file-backed and is read through bounded worker slices. Scalar `Fs`/sample-rate datasets and MATLAB cell-array channel labels are applied when present.
- **Legacy MAT + DAT:** The MAT companion supplies recoverable session metadata while the signed-int16 little-endian DAT remains file-backed. With no verified calibration, samples stay in raw ADC counts and use the MATLAB reviewer’s 15,000-count channel spacing; an optional confirmed µV/count value enables calibrated display units.
  - Legacy `sessionInfo` metadata is distinguished from standalone MAT waveforms before matrix selection. Local MAT/DAT companions match by case-insensitive basename, preferring the same selected folder; stale acquisition paths inside the MAT are ignored. The pair can be selected together or added separately. Missing companions and inconsistent metadata receive specific errors, while unrelated new recordings do not inherit pending files.
  - The confirmation screen reads `sessionInfo.sFile.header.sample_rate`, `sessionInfo.sFile.header.num_channels`, and ordered names from `sessionInfo.ChannelMat.Channel.Name` in a Level-5 MAT companion. Names can also be pasted one per line (plain text or MATLAB `{'contact'}` rows); a supplied list must match the channel count. Without names, numbered channels are used.
  - The reader follows FMAToolbox `LoadBinary.m`'s no-header, sample-major channel interleave for `int16`, with little-endian decoding (the native format on the PI's Windows platform). It does not infer the rate/count from the script's 20 kHz / one-channel defaults. The preview reports complete frames, duration, and any ignored trailing bytes; divisibility alone cannot prove the mapping is correct. The low-level reader may include boundary samples, but the default MATLAB display preparation selects exactly `floor(start * Fs)` and `floor(duration * Fs)` before filtering. No calibration is inferred from `int16`.

BrainVision, EEGLAB, BDF, NWB, and MEF3 files are catalogued when present but are not yet waveform sources.

## Review and Export

The workspace provides stacked traces, recorded/average/bipolar montages, display-only filters, a MATLAB-derived Gabor spectrogram with corrected frequency placement and a Nyquist-limited axis, exact-time labels, group selection and movement, interval handles, provenance, confidence, local draft recovery, undo/redo, an instance queue, and a layered session map. Depth-channel display rows are grouped by electrode-name prefix and naturally ordered by contact number, with tiny gaps and thicker group dividers. This is electrode grouping, not inferred brain-region anatomy. Clamped mode keeps each continuous trace inside its row and uses an overflow-severity line in the recording's own units; Overlap mode permits conventional cross-row excursions.

Seizure source events open in a 20-second event-relative viewport centered on time zero. The review bar supports onset/offset marking, reviewer initials, optional confidence 1–3 (`NA` when unrated), per-event ictal-channel notes, Accept-and-advance, and auditable Skip decisions. Legacy MAT + DAT imports apply the MATLAB seizure-event keywords and let the reviewer choose candidate events before opening the recording. Only that legacy event-review workflow requires at least 100 channels; waveform loading has no 100-channel cap and retains every mapped channel. Because browsers do not reveal absolute local file paths, the import confirmation includes editable patient/path fields for MATLAB-compatible resume and export keys.

### Automatic recording-label discovery

Opening a recording automatically imports its existing event labels after verification, with no extra label file or import button. These are recording-supplied labels, not a new signal detector: their presence alone does not establish whether a machine or a person created them.

- **MAT + DAT:** Reads every occurrence in Level-5 `sessionInfo.sFile.events`, not just seizure keywords or the first timestamp. The known schema uses `label` and `times` in seconds: `1×N` point markers or `2×N` start/end columns. Optional per-occurrence `channels` and `notes` are retained. Standalone Level-5 MAT waveforms with this same embedded structure are supported too. Unrelated variables and unknown schemas are not guessed; this does not add v7.3 event-metadata decoding.
- **EDF+:** Imports all valid annotation text and durations from the existing verification pass, including non-seizure markers.
- **Review:** Labels appear in the timeline, session map, and left **Instance Queue**. Search by label text, `imported`, or status; navigation follows the search, and the queue initially renders 100 matches. Open an annotation to see its original source text, timing, channels, and notes. New imports stay unreviewed (`suggestion`), with no inferred clinical category or confidence. The existing show/hide-labels control applies to them.
- **Safety and persistence:** Invalid timing, unmapped epochs, and ambiguous channel references produce source warnings. Out-of-file markers are skipped; intervals crossing the end are clipped for display while preserving original timing. Local recovery and saved review projects retain edits, provenance, and completed-import state, avoiding duplicates and respecting deletions. JSONL exports retain unreviewed labels; the events TSV remains committed-only.

The separate MATLAB-style seizure-review selector still uses the original first occurrence and stable candidate IDs, so prior review decisions remain compatible. Its keyword selection and 100-channel requirement do **not** filter automatic recording-label import.

Exports are ZIP bundles containing BIDS-style events/channels tables, recording metadata, full annotation provenance, deterministic forecasting windows, an ontology, a dataset manifest, and a decision-only `matlab_compatibility.csv`. Raw EEG bytes are never included in the export.

The top-bar Save control creates one versioned `.neurotrace` project file. Its checklist can include review state, workspace settings, label definitions, custom definitions, uploaded companions, and—only when explicitly selected—a copy of the original recording. The guided loader can reopen that file without copying a large embedded recording into an additional in-memory buffer. Projects saved without recording bytes can restore onto the matching recording after it is opened separately. The format is ZIP-compatible and contains a self-describing `manifest.json`; the system save dialog starts in Downloads and can target another folder.

## Privacy and Local State

Recording bytes are processed in the browser and are not uploaded by the application. The active `File` reference and decoded signal windows remain on the user’s device.

Annotation drafts, event candidates, and reviewer initials are persisted in browser-local storage under a source-derived identifier. Recording type is detected from BIDS metadata, channel types, and channel labels rather than saved as reviewer input. These records may contain sensitive notes even though they do not contain raw EEG. Clearing the site’s browser storage removes that recovery state; exported bundles are ordinary local files managed by the user.

GitHub Pages receives normal requests for the application’s static HTML, JavaScript, CSS, and image assets. Hospital use still requires the institution’s security, privacy, governance, deployment, and validation process.

## Performance Characteristics

Every imported source receives a complete SHA-256 integrity pass in bounded chunks. Verification still scales linearly with file size, but it runs in a worker after the file-backed preview opens, leaving navigation responsive. EDF+ annotation extraction shares that same sequential pass rather than rereading the recording.

For uniform 16-bit EDF/DAT recordings, approximate source size is:

```text
bytes ≈ 2 × channel_count × sample_rate_hz × duration_seconds
```

After import, EDF/DAT navigation is windowed: total recording length has little effect on an individual seek. Wide unfiltered referential views use bounded multiresolution envelopes and draw their exact minimum/maximum ranges on the cached grid. Signal preparation and filters run in a cancellable worker; zoom does not add signal filtering. Adjacent windows are cached under fixed memory budgets, superseded reads are canceled, wheel zoom is frame-coalesced, and expanded channel mode draws only visible rows. MAT v5 import time and memory scale with the complete decoded matrix.

Measured large-file budgets are tracked in [TODO.md](TODO.md); do not present implementation-level complexity estimates as benchmark results.

## Validation

Run the checks in this order:

```bash
npx tsc --noEmit
npm run lint
npm test
```

The Node test suite covers signal integrity, source hashing, server rendering, and key interaction contracts. Browser-level interaction coverage is still planned for pointer and gesture workflows.

## Known Constraints

- MATLAB v7.3/HDF5 inputs currently require a two-dimensional numeric signal dataset; nonstandard compression filters may require conversion to uncompressed HDF5, MATLAB v5, or EDF.
- Large MAT v5 files can exhaust browser memory because they are decoded eagerly.
- EDF window reads consume complete records and interleaved DAT reads consume complete frames even when only some channels are visible; display envelopes bound conversion and rendering work, but hiding channels still reduces less file I/O than it does display work.
- This application has not completed institutional clinical deployment validation.

## Dependencies

- Node.js 22.13 or newer
- npm
- Next.js-compatible React components compiled through vinext and Vite
- Cloudflare development adapters retained for the original Sites build path
- Drizzle/D1 scaffolding retained but not used by the current local-first product

## How It Works

NeuroTrace runs locally in the browser. It does not upload the recording, and display filters or montages never rewrite the source file.

### Loading, memory, panning, and zooming

Zooms share the annotation undo/redo chain: **Ctrl/Cmd+Z** undoes the latest edit or zoom, and **Ctrl/Cmd+Shift+Z** redoes it. This includes time-window changes, pinch/keyboard zoom, waveform and spectrogram box zoom (both axes together), frequency range changes, gain, and channel-layout resets. A continuous pinch is one history step. Each session keeps its own history; typing in a text field retains native text undo.

**Controls** lists every application keyboard shortcut, grouped by focus area. Search, click a binding to replace it, use **+ Add** for alternatives, or **×** to disable one. Conflicts in overlapping focus areas are blocked. Preferences persist locally and with workspace saves; existing letter bindings migrate automatically. Key hints and tutorial instructions follow remaps. Tab, native text editing, and pointer gestures remain standard and are documented separately. A non-Ctrl/Cmd undo binding also cancels a pending ictal onset before undoing history.

- The app reads the recording header first, so the first waveform can appear before full-file verification finishes.
- EDF, DAT, and MATLAB v7.3 stay file-backed. Only the current time window, selected channels, and a small read-ahead area are decoded into RAM. MATLAB v5 is the exception: its full signal matrix is kept in RAM.
- File-backed reads and signal processing run in background workers. MATLAB v5 overviews scan the already-decoded matrix in short, cancellable work slices without copying the entire requested window. If the view changes, old work is canceled.
- Nearby data is reused from bounded caches: 64 MiB raw windows, 64 MiB processed windows, and 256 MiB detailed zoomed-out envelopes. Each new envelope pyramid is capped at 128 MiB. A separate 64 MiB cache protects compact whole-recording indexes from eviction by detail zooms; each all-channel index targets 2,048 buckets and at most 16 MiB. Older recordings are removed first when that cache fills.
- The Full session navigator uses a compact raw-source index. EDF/DAT hashing and indexing share one source pass; MAT builds its index alongside verification. All four supported source readers publish completed exact prefixes; unread regions are explicitly marked, never drawn as zero signal. These indexes live in memory for open sessions, not persistent storage; reopening the file rebuilds them. They are not substituted for the MATLAB-prepared waveform: its filter and edge behavior depend on the requested loaded window.
- With optional filters off, the live waveform now computes the supplied MATLAB reviewer's FIR/decimation and montage in bounded chunks, then reduces the resulting samples to screen-column extrema. Completed windows use a separate 48 MiB/four-entry cache. Uncached hour-scale views still need to read and process the requested source interval; bounded memory and worker cancellation do not make that source scan free.
- The spectrogram analyzes the focused channel's complete raw electrode group in source order, including hidden contacts; ungrouped channels are analyzed individually. It does not average the displayed montage or all enabled channels. Double-clicking chooses an anchor sample; the crop includes both endpoints of ±15 seconds, bounded by the loaded waveform window. Exact page input is capped at 32 MiB; the analysis also enforces 128 MiB input and 64 MiB output limits, returning an explicit zoom/group-size error rather than silently reducing the data.
- Spectrograms implement the supplied `awt_freqlist` Gabor-5 equations with an exact-length circular transform. They retain the reference's log-spaced frequency centers from 1 to 150 Hz only where they are at or below the recording's Nyquist limit (half its sample rate): at most 60 centers, with none shifted to fit the shortened range. Each row is placed at its actual frequency on a linear Hz axis. This intentionally corrects the MATLAB viewer's uniform image-row placement and above-Nyquist display. Power is averaged across raw group channels before `10*log10(power + eps)`, then normalized by the pre-click mean and sample standard deviation; the reference's first-half fallback is retained when fewer than five pre-click samples exist. Default color limits use the 98th percentile of absolute Z-scores in the retained rows, with a minimum of ±1, so colors can differ from MATLAB when unsupported rows are omitted. No AR whitening, STFT framing, or extra smoothing is applied. Scales outside the toolbox's valid interval still produce zero power and a warning, as in the reference. Transform work runs in a terminable worker, with no main-thread fallback. Independent direct-DFT tests verify the equations and odd/even endpoints; this is not a completed MATLAB-runtime golden comparison.
- Panning moves the current waveform and spectrogram every animation frame. After the movement pauses for 180 ms, the app loads and processes the newly visible data.
- Every completed signal window is tied to the viewport that requested it. Superseded work is canceled, and stale geometry is not stretched into a new zoom while replacement samples are prepared.
- Each source/montage/filter row receives a robust baseline that is reused across adjacent windows, so panning and zooming do not recenter the trace around each new slice.
- **Recenter**, directly above Gain, manually replaces the centers of all enabled traces using a robust median estimate of the visible, already-loaded display samples (bucket means for overviews). Gaps are ignored; loading/refining windows cannot be recentered. Centers remain fixed through panning/zooming, are separate for each montage/filter/channel identity, follow the shared undo/redo chain, and are saved with the session/workspace. A new recording starts without overrides. Only vertical placement changes: gain, recorded values, cursor readouts, filters, spectrograms, and signal exports are untouched. Recenter cannot remove drift or recover missing samples.
- Horizontal zoom can change the MATLAB display factor from one to two, which activates the reference FIR. Screen geometry preserves peaks of those prepared samples, not necessarily peaks of the original raw signal. The spectrogram always reads raw samples independently. Within-bucket timing in a wide waveform remains limited by screen resolution.

**Main files:**

- `app/page.tsx` — loading flow, cache limits, panning/zooming, display updates, and spectrogram coordination.
- `app/eeg-core.ts` — EDF, DAT, and MAT readers plus window and envelope data structures.
- `app/file-window.ts` — exact EDF/DAT window reads.
- `app/edf-envelope.ts` and `app/raw-dat-envelope.ts` — zoomed-out min/max summaries.
- `app/mat73-worker.ts` — file-backed MATLAB v7.3 reads.
- `app/matlab-display-processing.ts` and `app/matlab-display-window.ts` — reference FIR, loaded-window timing, bounded processing, and post-montage extrema.
- `app/matlab-spectrogram.ts` and `app/matlab-spectrogram-input.ts` — Gabor power/baseline computation and raw-group click-window planning.
- `app/waveform-geometry.ts` — maintains stable row baselines and bounds clipping/dropout geometry.

### Filters

Optional filters are disabled by default and affect only the displayed signal. They run in this order:

```text
high-pass -> notch -> low-pass
```

High-pass and low-pass use second-order Butterworth-style filters. Notch filtering removes either 50 or 60 Hz line noise. Each optional filter is run forward and backward, which prevents a phase shift in the displayed waveform. Extra samples are loaded around the visible window to reduce edge artifacts. Gaps remain gaps and are not filtered across. This bidirectional user-filter path is separate from the single-pass clinical FIR decimator described below.

**Files:** `app/eeg-core.ts` (`applyDisplayFilters`) contains the filter math; `app/display-processing-worker.ts` runs it off the main thread; `app/page.tsx` manages settings, padding, and cropping.

### Montages

- **Recorded / referential:** shows each channel as it exists in the file.
- **Average reference (CAR):** finds the largest group with matching rate, sample count, and start time, then subtracts its finite sample-by-sample average from every channel in that group. Incompatible channels are omitted with a warning.
- **Bipolar:** matches the MATLAB reviewer: contacts stay in `ChannelMat` order within each electrode group, and each result is the following listed contact minus the current contact. A row labeled `LA1-2` therefore contains `LA2 - LA1`; contact numbers do not need to be consecutive if their source order is consecutive.
- **Electrode display order:** keeps each letter-prefix electrode together, showing L-prefixed groups, R-prefixed groups, then other groups. Groups are alphabetical within each section and contacts use natural numeric order. Selected auxiliary/unclassified channels remain at the end in recorded-reference mode. Gaps occupy 0.12 of a channel row with 2-pixel dividers; CAR and bipolar display labels use the same grouping. Display sorting preserves source identities and does not redefine legacy bipolar pairs, which still use original contact order.

Channels with incompatible units, sample rates, or timing are not combined. Gaps remain gaps.

**Files:** `app/eeg-core.ts` (`buildMontage`, `orderAnatomicalChannelIndices`, and `anatomicalChannelGroup`) contains the montage and ordering algorithms; `app/page.tsx` applies the order, group spacing, unit checks, and source-channel links.

### Supplied MATLAB display preparation

With optional user filters off, the live viewer follows `seizure_annotation_tool_update.m`, including its actual equations rather than its inaccurate 100 Hz comment.

1. The factor is `min(2, max(1, floor(samples / max(round(horizontal pixels), 1000))))`.
2. At factor two, each channel receives one causal pass of a 64th-order, 65-tap Hann-windowed FIR with cutoff 0.2 cycles per source sample and unity DC gain. At 1,000 Hz the cutoff is 200 Hz; it is not a fixed 100 Hz filter.
3. The first 32 causal outputs are removed and the last causal value repeated 32 times, exactly as the reference shifts its loaded-window result. There is no forward/backward pass. Filter state, leading zero context, retained-sample parity, and repeated tail belong to the complete requested window, not each read chunk.
4. The retained indices are `1, 1+D, ...` relative to that window. Plot times start at the requested window start plus `1/Fs`, even for a fractional source seek; filter and montage arithmetic use double precision. Factor one skips the FIR.

The older clinical-preparation utility remains tested but is not this default live-view path. Optional high-pass/notch/low-pass filters use the separate user-filter path described above; they are not claimed to reproduce the MATLAB script.

Parity is defined for the same input samples, requested loaded window, channel mapping, and horizontal pixel width. Browser zoom requests a new loaded window; MATLAB can also zoom an already-prepared window without reloading it. Absolute recording times and MATLAB event-relative times differ by the event-origin offset. Browser row spacing, baseline centering, and optional clamping remain presentation choices, not MATLAB pixel-for-pixel reproductions. Regression fixtures independently translate the source equations; no MATLAB-runtime golden-output comparison has been performed.

### Wide-window resampling and trace rendering

- The default live viewer first prepares the exact MATLAB-filtered/decimated samples and montage, then limits drawing work with peak-preserving geometry. Geometry does not introduce another signal filter, but the MATLAB factor itself can change with zoom.
- File-backed overviews retain cached minimum/maximum ranges and bucket centers across viewport crops. Their representative signals remain available as metadata but are not used as the plotted peak amplitudes.
- The canvas draws one peak-preserving path. Only a real gap or non-finite sample breaks the path; a finite value outside its row stays connected at the boundary rather than becoming dots or detached diagonal segments.
- Clamped mode contains traces within their inset row boundaries and shows a dark-green-to-orange severity line for excursions beyond those actual boundaries. The threshold follows gain, baseline, and row height in the recording's own units, including raw DAT/MAT counts; one visible span of additional excess reaches maximum intensity. Gaps interrupt the color halo. Overlap mode uses the full waveform area and omits that row-boundary indicator.

**Files:** `app/eeg-core.ts` retains the tested clinical/screen-resampling utilities and raw envelope-pyramid functions; `app/matlab-display-worker.ts` runs default reference preparation in the background, while `app/display-processing-worker.ts` handles optional user-filter preparation; `app/waveform-peak-path.ts` retains prepared peak samples for drawing; `app/waveform-geometry.ts` owns stable baselines and clipping metadata; `app/page.tsx` coordinates the caches and draws the waveform.
