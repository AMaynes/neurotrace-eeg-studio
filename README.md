# NeuroTrace — Clinical EEG Studio

NeuroTrace is a local-first EEG/iEEG review and annotation workstation for research data curation and seizure-forecasting workflows. It is designed for reviewers who need precise context, window, and instance labeling without uploading the source recording to an application server.

Canonical public app: https://amaynes.github.io/neurotrace-eeg-studio/

NeuroTrace is a research annotation and data-curation workspace. It is not a diagnostic system or autonomous clinical decision tool.

## Running the Project

NeuroTrace supports current macOS, Linux, and Windows development environments with Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

The development server prints the local URL after startup.

## System Overview

The browser owns the active recording and annotation state. `app/page.tsx` coordinates the interface and session workflow, `app/eeg-core.ts` parses recordings and supplies time-bounded signal windows, and `app/source-integrity.ts` computes a stable source fingerprint. Annotation recovery uses browser-local storage; exports are assembled and downloaded locally.

EDF and raw DAT recordings remain file-backed after import. The viewer requests only the records or frames needed for the current time window. MATLAB v5 recordings are decoded into memory because compressed MATLAB elements are not independently seekable.

See [STRUCTURE.md](STRUCTURE.md) for the authoritative repository map and [TODO.md](TODO.md) for prioritized engineering work.

## Recording Ingestion

- **EDF and EDF+:** Header metadata is parsed first. Signal data is read from the local `File` in bounded time windows. EDF+ annotation records are scanned and imported into the instance queue.
- **MATLAB v5:** The largest viable numeric signal matrix is decoded in memory. Compressed elements are supported.
- **Legacy MAT + DAT:** The MAT companion supplies recoverable session metadata while the signed-int16 little-endian DAT remains file-backed after the reviewer confirms its layout and physical scale.

MATLAB v7.3/HDF5 files must currently be converted to MATLAB v5 or EDF before import.

## Review and Export

The workspace provides stacked min/max-envelope traces, recorded/average/bipolar montages, display-only filters, channel quality flags, a Nyquist-bounded spectrogram, exact-time labels, group selection and movement, interval handles, provenance, confidence, local draft recovery, undo/redo, an instance queue, QC checks, and a layered session map.

Exports are ZIP bundles containing BIDS-style events/channels tables, recording metadata, full annotation provenance, deterministic forecasting windows, an ontology, QC report, and dataset manifest. Raw EEG bytes are never included in the export.

## Privacy and Local State

Recording bytes are processed in the browser and are not uploaded by the application. The active `File` reference and decoded signal windows remain on the user’s device.

Annotation drafts, event candidates, reviewer initials, channel-quality state, and recording type are persisted in browser-local storage under a source-derived identifier. These records may contain sensitive notes even though they do not contain raw EEG. Clearing the site’s browser storage removes that recovery state; exported bundles are ordinary local files managed by the user.

GitHub Pages receives normal requests for the application’s static HTML, JavaScript, CSS, and image assets. Hospital use still requires the institution’s security, privacy, governance, deployment, and validation process.

## Performance Characteristics

Every imported source receives a complete SHA-256 integrity pass in 4 MiB chunks. Initial verification therefore scales linearly with file size. EDF+ import also scans data records for embedded annotations.

For uniform 16-bit EDF/DAT recordings, approximate source size is:

```text
bytes ≈ 2 × channel_count × sample_rate_hz × duration_seconds
```

After import, EDF/DAT navigation is windowed: total recording length has little effect on an individual seek, while channel count, sampling rate, visible-window duration, filters, and montage determine the work per refresh. MAT v5 import time and memory scale with the complete decoded matrix.

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

- MATLAB v7.3/HDF5 is not decoded in the browser.
- Large MAT v5 files can exhaust browser memory because they are decoded eagerly.
- EDF/DAT window reads currently consume complete records or frames even when only some channels are visible; hiding channels reduces conversion and display work more than file I/O.
- The canonical GitHub Pages release path is not yet fully reproducible from the committed repository alone.
- This application has not completed institutional clinical deployment validation.

## Dependencies

- Node.js 22.13 or newer
- npm
- Next.js-compatible React components compiled through vinext and Vite
- Cloudflare development adapters retained for the original Sites build path
- Drizzle/D1 scaffolding retained but not used by the current local-first product
