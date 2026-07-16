# NeuroTrace — Clinical EEG Studio

NeuroTrace is a local-first EEG/iEEG review and annotation workstation for research data curation and seizure-forecasting workflows.

Canonical public app: https://amaynes.github.io/neurotrace-eeg-studio/

## Supported recordings

- EDF and EDF+ signal files, streamed from disk by time window
- Self-contained MATLAB v5 numeric signal matrices, including compressed elements
- Legacy same-basename MAT + DAT sessions with recovered `sessionInfo` sample rate, channel count, contact names, and event queue plus an explicit raw-layout confirmation step

MATLAB v7.3/HDF5 files must currently be converted to MATLAB v5 or EDF before import. Legacy MAT metadata is recovered locally, while the companion DAT’s signed-int16 little-endian layout and physical scale remain visible assumptions that must be confirmed.

## Review workflow

The workspace provides stacked min/max-envelope traces, recorded/average/bipolar montages, display-only filters, channel quality flags, a Nyquist-bounded spectrogram, exact-time drag-and-drop labels, interval handles, seizure onset/offset lifecycle marking, provenance, confidence, local draft recovery, undo/redo, review queues, QC gates, and a layered session map.

Exports are ZIP bundles containing BIDS-style events/channels tables, recording metadata, full annotation provenance, deterministic 30-second forecasting windows, an ontology, QC report, and dataset manifest. Raw EEG is never included in the export.

## Privacy and intended use

Recording bytes are processed in the browser and are not uploaded by the site. NeuroTrace is a research annotation and data-curation workspace. It is not a diagnostic system or autonomous clinical decision tool, and deployment in a hospital environment still requires the institution’s security, privacy, governance, and validation process.

## Development

```bash
npm install
npm run dev
```

Production validation:

```bash
npx tsc --noEmit
npm run build
node --test tests/rendered-html.test.mjs
```
