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

The top-right `?` opens a tutorial hub with six topic tabs and 11 task-based lessons. Preview any step, then start a Back/Next walkthrough that highlights the actual workspace controls. Drag the walkthrough’s top bar to move it aside; its position stays put between steps, and ↺ restores automatic placement. The spectrogram’s `?` opens the same hub on its Spectrogram tab. Guides can reveal closed panels on request, but never load files, create annotations, or save changes automatically. Completed walkthroughs are tracked for the current app visit.

## System Overview

The browser owns the active recording and annotation state. `app/page.tsx` coordinates the interface and session workflow, `app/eeg-core.ts` parses recordings and supplies time-bounded signal windows and zoomed-out display envelopes, and the source-integrity modules compute a stable source fingerprint off the main UI thread. Annotation recovery uses browser-local storage; exports are assembled and downloaded locally.

EDF, raw DAT, and MATLAB v7.3/HDF5 recordings remain file-backed after import. The viewer requests only the records, frames, or HDF5 dataset slices needed for the current time window. MATLAB v5 recordings are decoded into memory because compressed MATLAB elements are not independently seekable.

See [STRUCTURE.md](STRUCTURE.md) for the authoritative repository map and [TODO.md](TODO.md) for prioritized engineering work.

## Recording Ingestion

- **Guided format selection and companion discovery:** The loader starts with EDF/EDF+, standalone MAT, MAT + DAT, or NeuroTrace project choices, then shows a checked requirement row for every file that format needs. A directory scan remains available inside the selected flow and catalogs matching BIDS JSON/TSV companions by subject/session/task/run entities and inheritance specificity. Additional companion files can be dropped anywhere onto an active workspace without replacing its waveform.
- **Custom definitions:** Dictionaries, word lists, equations, filtering methods, label definitions, and channel groupings can be dropped alongside recording files. They remain inert local data; NeuroTrace does not execute imported text or code.
- **EDF and EDF+:** Header metadata is parsed first, so a read-only waveform preview can open without waiting for the full file scan. Signal data is read from the local `File` in bounded time windows. A background pass verifies the exact SHA-256 identity and extracts EDF+ annotation records together; seizure-keyword events are then imported into the source-event review queue. Review edits and export remain locked until verification finishes.
- **MATLAB v5:** The largest viable numeric signal matrix is decoded in memory. Compressed elements are supported.
- **MATLAB v7.3/HDF5:** The largest viable two-dimensional numeric dataset stays file-backed and is read through bounded worker slices. Scalar `Fs`/sample-rate datasets and MATLAB cell-array channel labels are applied when present.
- **Legacy MAT + DAT:** The MAT companion supplies recoverable session metadata while the signed-int16 little-endian DAT remains file-backed. With no verified calibration, samples stay in raw ADC counts and use the MATLAB reviewer’s 15,000-count channel spacing; an optional confirmed µV/count value enables calibrated display units.
  - Legacy `sessionInfo` metadata is distinguished from standalone MAT waveforms before matrix selection. Local MAT/DAT companions match by case-insensitive basename, preferring the same selected folder; stale acquisition paths inside the MAT are ignored. The pair can be selected together or added separately. Missing companions and inconsistent metadata receive specific errors, while unrelated new recordings do not inherit pending files.
  - The confirmation screen reads `sessionInfo.sFile.header.sample_rate`, `sessionInfo.sFile.header.num_channels`, and ordered names from `sessionInfo.ChannelMat.Channel.Name` in a Level-5 MAT companion. Names can also be pasted one per line (plain text or MATLAB `{'contact'}` rows); a supplied list must match the channel count. Without names, numbered channels are used.
  - The reader follows FMAToolbox `LoadBinary.m`'s no-header, sample-major channel interleave for `int16`, with little-endian decoding (the native format on the PI's Windows platform). It does not infer the rate/count from the script's 20 kHz / one-channel defaults. The preview reports complete frames, duration, and any ignored trailing bytes; divisibility alone cannot prove the mapping is correct. Window reads cover boundary samples for plotting rather than reproducing MATLAB's duration-flooring exactly. No calibration is inferred from `int16`.

BrainVision, EEGLAB, BDF, NWB, and MEF3 files are catalogued when present but are not yet waveform sources.

## Review and Export

The workspace provides stacked peak-preserving traces, recorded/average/bipolar montages, display-only filters, a Nyquist-bounded spectrogram, exact-time labels, group selection and movement, interval handles, provenance, confidence, local draft recovery, undo/redo, an instance queue, and a layered session map. Depth-channel display rows are grouped by electrode-name prefix and naturally ordered by contact number, with tiny gaps and thicker group dividers. This is electrode grouping, not inferred brain-region anatomy. Clamped mode keeps each continuous trace inside its row and uses an overflow-severity line in the recording's own units; Overlap mode permits conventional cross-row excursions.

Seizure source events open in a 20-second event-relative viewport centered on time zero. The review bar supports onset/offset marking, reviewer initials, optional confidence 1–3 (`NA` when unrated), per-event ictal-channel notes, Accept-and-advance, and auditable Skip decisions. Legacy MAT + DAT imports apply the MATLAB seizure-event keywords and let the reviewer choose candidate events before opening the recording. Only that legacy event-review workflow requires at least 100 channels; waveform loading has no 100-channel cap and retains every mapped channel. Because browsers do not reveal absolute local file paths, the import confirmation includes editable patient/path fields for MATLAB-compatible resume and export keys.

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

- The app reads the recording header first, so the first waveform can appear before full-file verification finishes.
- EDF, DAT, and MATLAB v7.3 stay file-backed. Only the current time window, selected channels, and a small read-ahead area are decoded into RAM. MATLAB v5 is the exception: its full signal matrix is kept in RAM.
- File-backed reads and signal processing run in background workers. MATLAB v5 overviews scan the already-decoded matrix in short, cancellable work slices without copying the entire requested window. If the view changes, old work is canceled.
- Nearby data is reused from bounded caches: 64 MiB raw windows, 64 MiB processed windows, and 256 MiB detailed zoomed-out envelopes. Each new envelope pyramid is capped at 128 MiB. A separate 64 MiB cache protects compact whole-recording indexes from eviction by detail zooms; each all-channel index targets 2,048 buckets and at most 16 MiB. Older recordings are removed first when that cache fills.
- Existing zoom/window controls automatically use the protected whole-recording index in unfiltered recorded-reference views when its resolution is sufficient (and always for the full recording). Minute-scale windows may show its coarser exact extrema immediately with a visible refining status while their finer selected-channel window loads. Those foreground reads do not wait for whole-file validation; completed prefixes appear progressively without replacing a more complete preview with a shorter one. Enabling another channel at the index's resolution requires no new whole-file read. EDF/DAT hashing and indexing share one source pass; MAT builds its index alongside verification. All four supported source readers publish completed exact prefixes; unread regions are explicitly hatched, never drawn as zero signal. MAT v7.3 indexing yields between bounded chunks so navigation and cancellation are not queued behind an entire HDF5 scan. These indexes live in memory for open sessions, not persistent storage; reopening the file rebuilds them.
- Wide, unfiltered recorded-reference DAT/MAT v5 views that need finer detail reuse complete fixed-grid buckets during overlapping pans and read only newly exposed intervals when resolution and memory limits allow. Incremental windows keep one grid at roughly twice the display-column resolution, avoiding a synchronous pyramid rebuild or shifting bucket centers after each pan. Reused extrema, gaps, units, and timing are unchanged. The first uncached interval still requires a source scan; filtered and derived montages keep their existing exact-sample processing and window limits.
- The spectrogram shows the actively selected channel. Escape clears that focus and switches to a power-average spectrogram of all enabled channels. Exact spectrogram input is capped at 32 MiB, and the old result remains correctly time-aligned while a replacement is calculated.
- Spectrograms use full-resolution, unfiltered montage samples, independently of waveform resampling and display filters. One-second frames are anchored to recording time, with AR(2) whitening fitted separately within each frame. This is relative whitened power, not calibrated raw EEG power or an exact reproduction of TheStateEditor's whole-input whitening. The color scale stays fixed for the current signal while panning. Reads include complete seconds and 31 seconds of smoothing context on either side (clipped at recording boundaries); the final partial second keeps its actual width. Inputs above 3,072 Hz report an unsupported-rate error rather than truncating samples into the fixed FFT.
- Panning moves the current waveform and spectrogram every animation frame. After the movement pauses for 180 ms, the app loads and processes the newly visible data.
- Every completed signal window is tied to the viewport that requested it. Superseded work is canceled, and stale geometry is not stretched into a new zoom while replacement samples are prepared.
- Each source/montage/filter row receives a robust baseline that is reused across adjacent windows, so panning and zooming do not recenter the trace around each new slice.
- Horizontal zoom does not apply pixel-rate signal filtering. Exact windows retain original samples (plus any explicitly enabled display filters); drawing keeps each pixel's first/last samples and both extrema in time order. Wide views draw cached minimum/maximum ranges on their original time grid, rather than re-smoothing a representative centerline for every viewport. Peak amplitudes are preserved; within-bucket timing in an overview remains limited by its resolution.

**Main files:**

- `app/page.tsx` — loading flow, cache limits, panning/zooming, display updates, and spectrogram coordination.
- `app/eeg-core.ts` — EDF, DAT, and MAT readers plus window and envelope data structures.
- `app/file-window.ts` — exact EDF/DAT window reads.
- `app/edf-envelope.ts` and `app/raw-dat-envelope.ts` — zoomed-out min/max summaries.
- `app/mat73-worker.ts` — file-backed MATLAB v7.3 reads.
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

### Clinical 0–200 Hz display preparation

The retained clinical-preparation utility implements the department’s fixed method below. The live viewer now bypasses this automatic, zoom-dependent reduction to preserve source peak amplitudes; explicitly enabled display filters still apply.

1. The clinical reduction factor is `min(2, floor(samples / horizontal pixels))`. A factor of two is allowed only when `sample_rate / 4 >= 250 Hz`; otherwise the signal remains at its source rate.
2. Before 2× reduction, each channel receives one causal pass of a 96th-order, 97-tap linear-phase FIR with a Kaiser window (`beta = 5.65`). Its passband edge is 200 Hz, its stopband edge is `min(245 Hz, sample_rate / 4 - 5 Hz)`, and the design cutoff is the midpoint. At 1,000 Hz, the cutoff is 222.5 Hz.
3. Coefficients are normalized to unity DC gain. The fixed 48-source-sample group delay is removed from the display time base; no forward/backward filtering is used for this FIR.
4. Every second globally aligned sample and its matching timestamp are retained. Processed display buffers remain single-precision.

If the factor is one, this FIR/2× step is skipped. This preserves the intended 0–200 Hz content whenever the viewport has enough horizontal resolution to show that bandwidth.

### Wide-window resampling and trace rendering

- The live viewer bypasses automatic clinical/screen decimation. Only explicitly enabled display filters change the source signal. Peak-preserving geometry reduction limits drawing work without changing peak values as zoom changes.
- File-backed overviews retain cached minimum/maximum ranges and bucket centers across viewport crops. Their representative signals remain available as metadata but are not used as the plotted peak amplitudes.
- The canvas draws one peak-preserving path. Only a real gap or non-finite sample breaks the path; a finite value outside its row stays connected at the boundary rather than becoming dots or detached diagonal segments.
- Clamped mode contains traces within their inset row boundaries and shows a dark-green-to-orange severity line for excursions beyond those actual boundaries. The threshold follows gain, baseline, and row height in the recording's own units, including raw DAT/MAT counts; one visible span of additional excess reaches maximum intensity. Gaps interrupt the color halo. Overlap mode uses the full waveform area and omits that row-boundary indicator.

**Files:** `app/eeg-core.ts` retains the tested clinical/screen-resampling utilities and envelope-pyramid functions; `app/display-processing-worker.ts` runs exact-window preparation in the background; `app/waveform-peak-path.ts` retains original peak samples for drawing; `app/waveform-geometry.ts` owns stable baselines and clipping metadata; `app/page.tsx` selects the cached level and draws the waveform.
