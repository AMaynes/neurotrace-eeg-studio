# Pressing

- [ ] Benchmark representative 1-hour, 12-hour, 24-hour, and 2 GB EDF/DAT recordings across scalp EEG and high-channel-count iEEG; record cold-load, integrity-scan, pan, zoom, filter, and peak-memory budgets.
- [ ] Add browser-level regression tests for waveform selection, timeline box selection, group movement, deletion, wheel panning, trackpad zooming, and channel scrolling.
- [ ] Commit a reproducible GitHub Pages build-and-release workflow so the canonical public deployment no longer depends on temporary out-of-tree build configuration.
- [ ] Complete an institutional privacy and network validation that verifies recording bytes never leave the device, reviews browser-local annotation persistence, and defines approved handling of exported bundles.
- [ ] Move full-file hashing and MAT parsing/decompression into cancellable workers so large imports cannot monopolize the browser’s main UI thread.

# Eventual

- [ ] Split `app/page.tsx` into cohesive recording, annotation, timeline, export, and dialog modules after browser interaction tests protect the current behavior.
- [ ] Decide whether to remove the unused ChatGPT authentication, D1, Drizzle, and Sites scaffolding after the GitHub-only release workflow is committed.
- [ ] Evaluate progressive or cached source verification while preserving the full SHA-256 provenance guarantee before annotation commit or export.
- [ ] Add a bounded MATLAB v7.3/HDF5 ingestion path or publish a validated conversion workflow for recordings that cannot be resaved as EDF or MATLAB v5.
- [ ] Profile record-level EDF/DAT reads and determine whether a persistent overview index or channel-selective cache materially improves high-channel-count navigation.
