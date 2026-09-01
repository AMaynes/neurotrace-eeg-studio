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

Annotation drafts, event candidates, reviewer initials, and channel-quality state are persisted in browser-local storage under a source-derived identifier. Recording type is detected from BIDS metadata, channel types, and channel labels rather than saved as reviewer input. These records may contain sensitive notes even though they do not contain raw EEG. Clearing the site’s browser storage removes that recovery state; exported bundles are ordinary local files managed by the user.

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

## How things work

This section describes the implemented signal path for a technical or PI review. The application is a local, browser-based viewer: recording bytes remain on the user's computer, and the processing below changes the displayed traces rather than rewriting the source file.

### How is loading, panning, and zooming fast?

1. **It opens metadata before scanning the full recording.** EDF import initially reads the 256-byte fixed header and then the declared header, which is enough to identify channels, rates, units, and duration. The UI installs a read-only preview before the full SHA-256/EDF+ annotation pass finishes. For EDF and DAT, that background pass also builds the reusable overview in the same sequential read, avoiding another whole-file pass.
2. **Large recordings stay file-backed.** EDF, raw DAT, and MATLAB v7.3/HDF5 readers request only the time and channels needed for the view. Exact EDF/DAT windows are read in bounded 8 MiB chunks; their overview builders use bounded 4 MiB chunks. MATLAB v7.3 uses a persistent HDF5 worker. MATLAB v5 is the exception: compressed MAT v5 elements cannot be independently sliced, so that format is decoded into memory.
3. **Zoomed-out views use exact extrema instead of millions of samples.** When an unfiltered referential window has more samples than horizontal pixels, the source is reduced into time buckets containing the finite minimum, maximum, midpoint, gap flag, and variation. A multiresolution pyramid repeatedly combines adjacent buckets conservatively. The viewer selects the coarsest level that still meets the screen resolution, then aggregates it to the exact visible columns. This bounds drawing work while retaining spikes and both polarities.
4. **The expensive work is off the UI thread.** Exact file-window decoding, EDF/DAT envelope generation, display filtering/decimation, MATLAB v7.3 reads, source hashing, and spectrogram calculation run in Web Workers. Typed-array buffers are transferred back instead of copied where possible. The common unfiltered, non-decimated path returns zero-copy views.
5. **Nearby work is reused, and stale work is discarded.** The viewer has bounded raw-window, processed-window, and envelope caches (64 MiB, 64 MiB, and 256 MiB respectively) and reads ahead by up to two additional view widths within a 96 MiB source-read budget. A new navigation request aborts the old request, and only the newest result may update the display.
6. **Interaction and data loading are separated.** Wheel events are combined into one update per animation frame. During a pan, the already-rendered waveform and spectrogram move continuously with the live `viewStart`; after a 180 ms settle period, `signalViewStart` triggers the new exact read and recomputation. The old spectrogram remains positioned at its real recording timestamps until its replacement is ready, so it does not jump to a new time origin or disappear between updates.
7. **Very large windows have explicit budgets.** Under five minutes, overview columns can follow canvas width; at five minutes or more they are capped at 1,024, and at one hour or more at 512. The canvas backing store is capped at one device pixel per CSS pixel and four million pixels. If filters or a derived montage require actual samples and the requested span would exceed bounded memory/file-read budgets, the app narrows the timebase rather than attempting an unbounded allocation.

**Algorithm locations:**

- `app/page.tsx` — `loadSource`, the display refresh effect, cache/read-ahead budgets, request cancellation, `onViewerWheel`, spectrogram retention, and canvas rendering.
- `app/eeg-core.ts` — `SignalSource`, `EDFSource`, `RawDatSource`, `MatSource`, `Mat73Source`, `buildEnvelopePyramid`, `selectEnvelopePyramidLevel`, and envelope aggregation.
- `app/file-window.ts`, `app/file-window-worker.ts`, `app/file-window-worker-client.ts` — bounded exact EDF/DAT window decoding.
- `app/edf-envelope.ts`, `app/edf-envelope-integrity.ts`, `app/edf-envelope-worker.ts`, `app/edf-envelope-worker-client.ts` — EDF extrema overview, shared integrity/annotation scan, and worker control.
- `app/raw-dat-envelope.ts`, `app/raw-dat-envelope-worker.ts`, `app/raw-dat-envelope-worker-client.ts` — raw DAT extrema overview and worker control.
- `app/mat73-worker.ts`, `app/mat73-worker-client.ts` — file-backed HDF5 metadata, exact slices, and envelopes.
- `app/display-processing-worker.ts`, `app/display-processing-worker-client.ts` — off-thread filtering/decimation, cancellation, transfer, and the zero-copy fast path.
- `app/waveform-geometry.ts` — overview column limits and bounded detailed/midpoint/grouped-extrema render policy.
- `app/spectrogram-compute.ts`, `app/spectrogram-worker.ts`, `app/spectrogram-worker-client.ts` — spectrogram algorithm and off-thread execution.

### What is actually loaded at any given time, and where?

Selecting a file does **not** normally copy the complete recording into the application's JavaScript memory. The browser retains a local `File`/`Blob` reference; the browser and operating system manage its backing storage. NeuroTrace materializes only requested byte slices and decoded typed arrays. The major resident layers are:

| Layer | What is resident | Where and for how long |
| --- | --- | --- |
| Source handle and metadata | The local `File` reference plus channel labels, rates, units, duration, and format metadata. | Main browser thread for the open session. This is a reference to the local file, not an application-created copy or upload. |
| Transient source chunks | Record-aligned EDF or frame-aligned DAT bytes: normally up to 8 MiB for exact windows and 4 MiB for overview/integrity work. | Worker memory while that chunk is decoded/hashed; the previous chunk becomes reclaimable as the next is read. The complete file is not retained by these readers. |
| Raw-window cache | Calibrated/decoded `Float32Array` samples for the selected channels, requested padded viewport, and bounded read-ahead. | Main-thread JavaScript heap; global 64 MiB ceiling. Cache entries are keyed by source, channels, and time coverage. Recently reused entries move to the back; oldest entries are evicted when over budget. |
| Processed-window cache | Filtered and/or anti-aliased/decimated `Float32Array` samples, keyed by the owning raw window plus filter settings, sample ranges, and decimation factors. | Main-thread JavaScript heap; separate 64 MiB ceiling. The identity path reuses raw buffers and is not added as a duplicate processed allocation. |
| Envelope cache | For each cached channel and time bucket: midpoint, minimum, maximum, gap flag, variation, and coarser pyramid levels. | Main-thread JavaScript heap; global 256 MiB ceiling and at most 524,288 finest-level buckets per reusable base envelope. Full-session overviews are built for the recommended initial channels; another selected channel set can create a bounded reusable entry. |
| Active waveform display | The exact cropped window, montage output, or visible aggregated envelope currently used by Canvas. | React/main-thread state. Exact crops normally use typed-array views over cached backing buffers; a derived montage allocates new output arrays. Envelope display arrays are screen-column-sized. |
| Spectrogram | One focused channel's exact input when it fits the 32 MiB input ceiling, plus its computed time/frequency/power arrays. | Input and retained result live in the spectrogram component; computation is in a worker. While a replacement computes, the previous result remains available and time-aligned. A large envelope-only overview does not force an unbounded exact-sample allocation. |
| Verification/indexing | SHA-256 state, optional EDF+ annotation parsing state, one transient source chunk, and the envelope output being built. | Short-lived worker memory. The worker terminates after verification; only the hash, annotations, metadata, and budgeted envelope pyramid are retained. |

Format-specific behavior matters:

- **EDF and raw DAT:** only metadata, current/cached decoded windows, and cached envelopes are in application RAM; source bytes remain file-backed.
- **MATLAB v7.3/HDF5:** the persistent MAT worker keeps the local file mounted and the HDF5 dataset open. Each `dataset.slice(...)` materializes only the requested sample/channel region or bounded envelope chunk; NeuroTrace does not create a whole-matrix JavaScript copy.
- **MATLAB v5:** the full file must be read/decompressed during import, and the selected signal matrix remains in main-thread RAM as channel-major `Float32Array` data. Requested display windows are then sliced from that in-memory matrix. This is why MAT v5 has a larger memory cost than the other supported large-file paths.
- **Session changes:** raw, processed, and envelope entries are source-keyed and may remain available across session-tab/source switches for fast return navigation, but the three global ceilings still apply and evict older entries.
- **Persistent browser storage:** annotations/recovery state can be written to local storage, but raw EEG samples and these signal caches are not. Closing/reloading the page releases the in-memory source objects and caches.

**Algorithm locations:**

- `app/page.tsx` — `RawWindowCache`, `ProcessedWindowCache`, `EnvelopeWindowCache`, the three cache refs, byte-budget constants, eviction logic, source installation, active display state, and exact-spectrogram input ceiling.
- `app/file-window.ts`, `app/edf-envelope.ts`, `app/raw-dat-envelope.ts` — `File.slice(...).arrayBuffer()` chunk materialization and chunk-size constants.
- `app/eeg-core.ts` — file-backed source objects, MAT v5 full decode/retained `MatSource.data`, and returned typed-array windows.
- `app/mat73-worker.ts` — WORKERFS mount, persistent HDF5 handle, `dataset.slice(...)` exact-window reads, and bounded envelope reads.
- `app/spectrogram-compute.ts` and `app/page.tsx` — spectrogram input/result arrays and retained-result replacement behavior.

### How do the low-pass, high-pass, and notch filters work?

The filters are **display-only**: they never alter the raw recording. Each selected channel is filtered at its own sample rate before montage arithmetic.

The high-pass and low-pass stages are second-order biquads with `Q = 1/sqrt(2)`, giving a Butterworth-style response. The notch is a second-order biquad centered at 50 or 60 Hz with default `Q = 30`; `0` disables it. A cutoff at or above that channel's Nyquist frequency is rejected/skipped. Enabled stages run in this order:

```text
high-pass -> notch -> low-pass
```

By default, every stage runs once forward and once backward. This removes phase delay for offline display, squares the magnitude response, and makes each enabled second-order section act like a fourth-order zero-phase magnitude response. Missing/non-finite samples remain gaps: a gap is copied to the output and resets filter state, so the filter does not bridge a recording break. The viewer reads 2–12 seconds of extra signal around the requested window (scaled as `3 / highPassHz` for low high-pass cutoffs), filters the padded window, and crops back to the exact viewport to reduce edge transients.

**Algorithm locations:**

- `app/eeg-core.ts` — `DisplayFilterSettings`, `designBiquad`, `biquadPass`, `applyBiquad`, and `applyDisplayFilters` contain the coefficients, state update, gap behavior, forward/backward pass, and stage order.
- `app/display-processing-worker.ts` — applies the display filters before any display decimation.
- `app/display-processing-worker-client.ts` — worker lifecycle, cancellation, and typed-array transfer.
- `app/page.tsx` — filter controls/defaults, padded window calculation, processed-window caching, exact crop, and the call into the worker.

These are visualization filters, not acquisition filters or a claim of clinical-device certification.

### How does each montage work?

Montaging occurs after optional display filtering, anti-alias preparation, and exact viewport cropping. Arithmetic is only performed between channels with compatible units, sample rates, and aligned start times.

- **Recorded / referential:** no subtraction is performed. Each displayed trace remains the signal as stored in the recording, with one-to-one source provenance. “Referential” therefore does not reconstruct an unknown original reference; it displays the recorded reference.
- **Average reference (CAR):** the app finds the largest compatible cohort with equal sample count, sample rate, start time, and unit. At each sample it computes the mean of finite values in that cohort, then returns `channel - mean`. Non-finite input or an unavailable mean produces a gap. Labels receive `(CAR)`, and provenance records all channels contributing to the reference.
- **Bipolar:** labels are normalized and parsed as an electrode group plus contact number. Scalp and auxiliary labels are not treated as depth contacts. Within each group, only true adjacent contacts are paired: `N` with `N+1`; the app never bridges a missing contact. `LA1-LA2` means `LA1 minus LA2`. Duplicate contact numbers are treated as ambiguous and omitted. Differently sampled or time-misaligned pairs are omitted instead of being silently resampled; equal-rate arrays of different lengths are clipped to the shorter window. A gap in either input remains a gap in the derived trace.

Channel ordering is independent of the arithmetic: scalp labels are ordered front-to-back/left-to-right, depth contacts by side/group/contact, and auxiliary channels last, while original source-channel identity is retained for provenance and export.

**Algorithm locations:**

- `app/eeg-core.ts` — `cleanElectrodeLabel`, `scalpChannelPosition`, `parseContactLabel`, `anatomicalChannelGroup`, `orderAnatomicalChannelIndices`, and `buildMontage` implement label parsing, ordering, recorded/reference mapping, CAR, bipolar pairing, polarity, compatibility checks, gaps, warnings, and provenance.
- `app/page.tsx` — the display refresh effect enforces compatible units, calls `buildMontage`, maps derived traces back to source-channel indices, and reports montage warnings.
- `tests/core-release-fixes.test.mjs` and `tests/eeg-integrity.test.mjs` — regression coverage for polarity, gaps, provenance, adjacent contacts, duplicate contacts, excluded/incompatible inputs, and mixed-rate safety.

### How are aliasing and large zoom windows handled?

There are two separate aliasing problems, and the code treats them separately.

**Signal aliasing during sample-rate reduction:** The viewer only decimates by a factor of two, only when the source rate is at least 1,000 Hz and at least two source samples would map to each display pixel. Before retaining every second global sample, it applies a fixed 96th-order/97-tap symmetric Kaiser-window FIR low-pass. The passband edge is 200 Hz; the stopband edge is `min(245 Hz, sourceRate / 4 - 5 Hz)`, and the FIR cutoff is the midpoint of that transition. Coefficients are normalized to unity DC gain. The known 48-input-sample group delay is compensated, and retained samples remain on the recording-global even-sample grid so adjacent windows line up. Any source gap contributing to an output remains a gap. Lower-rate data and close zooms remain at their original rate, so no sample-rate reduction is performed.

**Visual aliasing when many samples share one pixel:** The app does not draw an average-only waveform. Each bucket preserves its exact minimum and maximum, plus a gap-aware representative midpoint. Coarser pyramid levels combine minima with minima and maxima with maxima, so a short spike cannot disappear just because the user zoomed out. If even that path would exceed canvas command/stroke budgets, adjacent buckets are grouped again while preserving the finite extrema of every group. Raw samples are used again when the view reaches approximately 1.5 samples per pixel or less.

This creates a multiscale path:

```text
close view: exact samples
    -> denser view: per-pixel exact min/max envelopes
    -> minutes/hours: cached multiresolution extrema pyramid
    -> extreme path complexity: bounded grouped extrema, still retaining min/max
```

Filtered and derived-montage views cannot reuse a raw referential envelope because filtering and subtraction change the signal. Those views process real padded samples within the fixed budgets; if the requested interval is too large, the UI reduces the window duration and explains why.

**Algorithm locations:**

- `app/eeg-core.ts` — `clinicalDecimationFactor`, `designClinicalDecimationFir`, `decimateClinicalDisplayTrace`, and `prepareClinicalDisplaySignals` implement anti-alias filtering, conditional 2x decimation, delay compensation, global sample alignment, and gap preservation. `EnvelopeWindowData`, `aggregateEnvelopeWindow`, `buildEnvelopePyramid`, and `selectEnvelopePyramidLevel` implement loss-aware zoomed-out data.
- `app/display-processing-worker.ts` — guarantees filtering occurs before decimation.
- `app/page.tsx` — chooses exact-sample versus envelope paths, selects/aggregates cached pyramid levels, enforces memory budgets, and renders absolute-time-aligned traces.
- `app/waveform-geometry.ts` — `waveformOverviewColumnBudget`, `envelopeTraceRenderMode`, `maximumExtremaGroupsForBudget`, and `visitGroupedWaveformExtrema` bound rendering without dropping extrema.
- `tests/core-release-fixes.test.mjs` and `tests/waveform-geometry.test.mjs` — regression coverage for FIR response and delay, global-grid continuity, 24-hour pyramid scaling, exact extrema, gaps, and bounded render geometry.
