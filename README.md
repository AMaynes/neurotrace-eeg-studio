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

The workspace provides stacked min/max-envelope traces, recorded/average/bipolar montages, display-only filters, channel quality flags, a Nyquist-bounded spectrogram, exact-time labels, group selection and movement, interval handles, provenance, confidence, local draft recovery, undo/redo, an instance queue, QC checks, and a layered session map. Depth contacts follow the legacy MATLAB reviewer’s left/right/other order and anatomical group spacing. Each waveform is clipped to its own row with an overflow indicator so artifacts cannot obscure neighboring channels.

Seizure source events open in a 20-second event-relative viewport centered on time zero. The review bar supports onset/offset marking, reviewer initials, optional confidence 1–3 (`NA` when unrated), per-event bad/ictal-channel notes, Accept-and-advance, and auditable Skip decisions. Legacy MAT + DAT imports apply the MATLAB seizure-event keywords, let the reviewer choose candidate events before opening the recording, and enforce its 100-channel session threshold. Because browsers do not reveal absolute local file paths, the import confirmation includes editable patient/path fields for MATLAB-compatible resume and export keys.

Exports are ZIP bundles containing BIDS-style events/channels tables, recording metadata, full annotation provenance, deterministic forecasting windows, an ontology, QC report, dataset manifest, and a decision-only `matlab_compatibility.csv` using the newer MATLAB tool’s 20-column schema. Raw EEG bytes are never included in the export.

The top-bar Save control creates one versioned `.neurotrace` project file. Its checklist can include review state, workspace settings, label definitions, custom definitions, uploaded companions, and—only when explicitly selected—a copy of the original recording. The format is ZIP-compatible and contains a self-describing `manifest.json`; the system save dialog starts in Downloads and can target another folder.

## Privacy and Local State

Recording bytes are processed in the browser and are not uploaded by the application. The active `File` reference and decoded signal windows remain on the user’s device.

Annotation drafts, event candidates, reviewer initials, channel-quality state, and recording type are persisted in browser-local storage under a source-derived identifier. These records may contain sensitive notes even though they do not contain raw EEG. Clearing the site’s browser storage removes that recovery state; exported bundles are ordinary local files managed by the user.

GitHub Pages receives normal requests for the application’s static HTML, JavaScript, CSS, and image assets. Hospital use still requires the institution’s security, privacy, governance, deployment, and validation process.

## Performance Characteristics

Every imported source receives a complete SHA-256 integrity pass in bounded chunks. Verification still scales linearly with file size, but it runs in a worker after the file-backed preview opens, leaving navigation responsive. EDF+ annotation extraction shares that same sequential pass rather than rereading the recording.

For uniform 16-bit EDF/DAT recordings, approximate source size is:

```text
bytes ≈ 2 × channel_count × sample_rate_hz × duration_seconds
```

After import, EDF/DAT navigation is windowed: total recording length has little effect on an individual seek. Unfiltered referential views use bounded min/max envelopes when more source samples are visible than the canvas can represent and no clinical FIR/2× preparation is required. Higher-rate clinical preparation, filters, and derived montages retain the MATLAB-compatible signal path but run in a cancellable worker. Adjacent windows are cached under fixed memory budgets, superseded reads are canceled, wheel zoom is frame-coalesced, and expanded channel mode draws only visible rows. MAT v5 import time and memory scale with the complete decoded matrix.

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
