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

## System Overview

The browser owns the active recording and annotation state. `app/page.tsx` coordinates the interface and session workflow, `app/eeg-core.ts` parses recordings and supplies time-bounded signal windows and zoomed-out display envelopes, and the source-integrity modules compute a stable source fingerprint off the main UI thread. Annotation recovery uses browser-local storage; exports are assembled and downloaded locally.

EDF, raw DAT, and MATLAB v7.3/HDF5 recordings remain file-backed after import. The viewer requests only the records, frames, or HDF5 dataset slices needed for the current time window. MATLAB v5 recordings are decoded into memory because compressed MATLAB elements are not independently seekable.

See [STRUCTURE.md](STRUCTURE.md) for the authoritative repository map and [TODO.md](TODO.md) for prioritized engineering work.

## Recording Ingestion

- **Directory and additive companion discovery:** A directory picker catalogs every selected file and opens the first supported EDF, MAT, or DAT recording in path order. Matching BIDS JSON/TSV files are resolved by subject/session/task/run entities and inheritance specificity. Recording sidecars, participant/session/scan rows, channel names and `bad` flags, and events are applied best-effort; unrelated and unsupported files remain visible in the uploaded-file inventory. Additional companion files can be dropped anywhere onto an active workspace without replacing its waveform.
- **Custom definitions:** Dictionaries, word lists, equations, filtering methods, label definitions, and channel groupings can be dropped alongside recording files. They remain inert local data; NeuroTrace does not execute imported text or code.
- **EDF and EDF+:** Header metadata is parsed first, so a read-only waveform preview can open without waiting for the full file scan. Signal data is read from the local `File` in bounded time windows. A background pass verifies the exact SHA-256 identity and extracts EDF+ annotation records together; seizure-keyword events are then imported into the source-event review queue. Review edits and export remain locked until verification finishes.
- **MATLAB v5:** The largest viable numeric signal matrix is decoded in memory. Compressed elements are supported.
- **MATLAB v7.3/HDF5:** The largest viable two-dimensional numeric dataset stays file-backed and is read through bounded worker slices. Scalar `Fs`/sample-rate datasets and MATLAB cell-array channel labels are applied when present.
- **Legacy MAT + DAT:** The MAT companion supplies recoverable session metadata while the signed-int16 little-endian DAT remains file-backed. With no verified calibration, samples stay in raw ADC counts and use the MATLAB reviewer’s 15,000-count channel spacing; an optional confirmed µV/count value enables calibrated display units.

BrainVision, EEGLAB, BDF, NWB, and MEF3 files are catalogued when present but are not yet waveform sources.

## Review and Export

The workspace provides stacked Nyquist-resampled traces, recorded/average/bipolar montages, display-only filters, channel quality flags, a Nyquist-bounded spectrogram, exact-time labels, group selection and movement, interval handles, provenance, confidence, local draft recovery, undo/redo, an instance queue, QC checks, and a layered session map. Depth contacts follow the legacy MATLAB reviewer’s left/right/other order and anatomical group spacing. Each waveform is rendered as one continuous centerline and clipped to its own row by default; finite excursions remain connected at the boundary while a voltage-severity line reports overflow.

Seizure source events open in a 20-second event-relative viewport centered on time zero. The review bar supports onset/offset marking, reviewer initials, optional confidence 1–3 (`NA` when unrated), per-event bad/ictal-channel notes, Accept-and-advance, and auditable Skip decisions. Legacy MAT + DAT imports apply the MATLAB seizure-event keywords, let the reviewer choose candidate events before opening the recording, and enforce its 100-channel session threshold. Because browsers do not reveal absolute local file paths, the import confirmation includes editable patient/path fields for MATLAB-compatible resume and export keys.

Exports are ZIP bundles containing BIDS-style events/channels tables, recording metadata, full annotation provenance, deterministic forecasting windows, an ontology, QC report, dataset manifest, and a decision-only `matlab_compatibility.csv` using the newer MATLAB tool’s 20-column schema. Raw EEG bytes are never included in the export.

The top-bar Save control creates one versioned `.neurotrace` project file. Its checklist can include review state, workspace settings, label definitions, custom definitions, uploaded companions, and—only when explicitly selected—a copy of the original recording. The format is ZIP-compatible and contains a self-describing `manifest.json`; the system save dialog starts in Downloads and can target another folder.

## Privacy and Local State

Recording bytes are processed in the browser and are not uploaded by the application. The active `File` reference and decoded signal windows remain on the user’s device.

Annotation drafts, event candidates, reviewer initials, and channel-quality state are persisted in browser-local storage under a source-derived identifier. Recording type is detected from BIDS metadata, channel types, and channel labels rather than saved as reviewer input. These records may contain sensitive notes even though they do not contain raw EEG. Clearing the site’s browser storage removes that recovery state; exported bundles are ordinary local files managed by the user.

GitHub Pages receives normal requests for the application’s static HTML, JavaScript, CSS, and image assets. Hospital use still requires the institution’s security, privacy, governance, deployment, and validation process.

## Performance Characteristics

Every imported source receives a complete SHA-256 integrity pass in bounded chunks. Verification still scales linearly with file size, but it runs in a worker after the file-backed preview opens, leaving navigation responsive. EDF+ annotation extraction shares that same sequential pass rather than rereading the recording.

For uniform 16-bit EDF/DAT recordings, approximate source size is:

```text
bytes ≈ 2 × channel_count × sample_rate_hz × duration_seconds
```

After import, EDF/DAT navigation is windowed: total recording length has little effect on an individual seek. Wide unfiltered referential views use bounded multiresolution envelopes, but only their Nyquist-filtered representative centerline is drawn; exact minima and maxima remain metadata for clipping and dropout indicators. Higher-rate clinical preparation, filters, and derived montages run in a cancellable worker. Adjacent windows are cached under fixed memory budgets, superseded reads are canceled, wheel zoom is frame-coalesced, and expanded channel mode draws only visible rows. MAT v5 import time and memory scale with the complete decoded matrix.

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
- File reads and signal processing run in background workers, so they do not block the interface. If the view changes, old work is canceled.
- Nearby data is reused from three bounded caches: 64 MiB raw windows, 64 MiB processed windows, and 256 MiB zoomed-out envelopes. Older entries are removed when a cache is full.
- The spectrogram loads one focused channel, with a 32 MiB input limit. Its old result remains visible and correctly time-aligned while the new view is calculated.
- Panning moves the current waveform and spectrogram every animation frame. After the movement pauses for 180 ms, the app loads and processes the newly visible data.
- Every completed signal window is tied to the viewport that requested it. Superseded work is canceled, and stale geometry is not stretched into a new zoom while replacement samples are prepared.
- Wide views draw one low-pass, Nyquist-safe representative centerline per row. Exact minima and maxima remain available for clipping and dropout indicators rather than appearing as extra waveform strokes.

**Main files:**

- `app/page.tsx` — loading flow, cache limits, panning/zooming, display updates, and spectrogram coordination.
- `app/eeg-core.ts` — EDF, DAT, and MAT readers plus window and envelope data structures.
- `app/file-window.ts` — exact EDF/DAT window reads.
- `app/edf-envelope.ts` and `app/raw-dat-envelope.ts` — zoomed-out min/max summaries.
- `app/mat73-worker.ts` — file-backed MATLAB v7.3 reads.
- `app/waveform-geometry.ts` — bounds clipping, dropout, and waveform drawing work.

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
- **Anatomical order:** accepts only letter-and-number contact names, applies the MATLAB exclusion list, then shows left, right, and unlateralized groups while preserving the source order. Four blank row spaces separate electrode groups.

Channels with incompatible units, sample rates, or timing are not combined. Gaps remain gaps.

**Files:** `app/eeg-core.ts` (`buildMontage`, `orderAnatomicalChannelIndices`, and `anatomicalChannelGroup`) contains the montage and ordering algorithms; `app/page.tsx` applies the order, group spacing, unit checks, and source-channel links.

### Clinical 0–200 Hz display preparation

The near-view clinical path follows the department’s fixed method:

1. The clinical reduction factor is `min(2, floor(samples / horizontal pixels))`. A factor of two is allowed only when `sample_rate / 4 >= 250 Hz`; otherwise the signal remains at its source rate.
2. Before 2× reduction, each channel receives one causal pass of a 96th-order, 97-tap linear-phase FIR with a Kaiser window (`beta = 5.65`). Its passband edge is 200 Hz, its stopband edge is `min(245 Hz, sample_rate / 4 - 5 Hz)`, and the design cutoff is the midpoint. At 1,000 Hz, the cutoff is 222.5 Hz.
3. Coefficients are normalized to unity DC gain. The fixed 48-source-sample group delay is removed from the display time base; no forward/backward filtering is used for this FIR.
4. Every second globally aligned sample and its matching timestamp are retained. Processed display buffers remain single-precision.

If the factor is one, this FIR/2× step is skipped. This preserves the intended 0–200 Hz content whenever the viewport has enough horizontal resolution to show that bandwidth.

### Wide-window resampling and trace rendering

- A window containing more samples than horizontal pixels needs a lower screen-only rate. After the clinical step, a separate zero-phase anti-alias stage low-passes below the new display Nyquist limit before globally aligned samples are removed. Zooming back in returns to the exact or clinical 0–200 Hz path.
- File-backed overviews apply the same Nyquist rule to their representative signal through multiresolution levels. Exact extrema are retained only for clipping severity and missing-data metadata.
- The canvas draws one continuous centerline. Only a real gap or non-finite sample breaks the path; a finite value outside its row stays connected at the boundary rather than becoming dots or detached diagonal segments.
- By default, traces remain inside their rows and a dark-green-to-orange severity line marks excursions beyond ±100 µV from the row baseline.

**Files:** `app/eeg-core.ts` (`clinicalDecimationFactor`, `designClinicalDecimationFir`, `displayDecimationFactor`, `prepareClinicalDisplaySignals`, and the envelope-pyramid functions) contains the clinical and screen-resampling algorithms; `app/display-processing-worker.ts` runs exact-window preparation in the background; `app/waveform-geometry.ts` owns clipping metadata and drawing budgets; `app/page.tsx` selects the correct level and draws the continuous centerline.
