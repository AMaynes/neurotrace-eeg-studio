# Open work

## Validation

- [ ] Compare raw reads, filtered samples, montage output, sample timing, and spectrogram results against actual MATLAB-runtime output when MATLAB is available. Independent equations are covered; runtime parity is not established.
- [ ] Benchmark representative 1-, 12-, and 24-hour recordings, multi-gigabyte EDF/DAT, and 200-channel ten-hour windows on recorded hardware/browser versions. Separate cold reads, cached pan/zoom, filters, wavelets, first partial display, and peak resource usage.
- [ ] Expand actual-browser regression coverage for drag/selection, group movement, deletion, wheel/trackpad gestures, channel scrolling, directory locks/resume, every tutorial, and failure/recovery flows.
- [ ] Exercise macOS launcher, Linux runtime, narrow viewports, keyboard-only review, and assistive technology. Current Windows checks do not certify these paths.
- [ ] Complete institutional privacy/network and clinical-use validation, including browser-local recovery and exported identifying metadata.

## Architecture and cleanup

- [ ] Move eager MAT v5 parsing/decompression into a cancellable worker without changing import results or errors. HDF5/MAT v7.3 already has a bounded worker path.
- [ ] Split the remaining Home state/effects into cohesive modules after stronger browser interaction coverage protects ordering, cancellation, and per-session state. Resource display and recording-info formatting are now separate.
- [ ] Review remaining inline callback/test-helper documentation against the guide without adding repeated test names or comments that merely restate expressions. Authored application named functions are checked; literal every-function coverage is incomplete.
- [ ] Resolve external compatibility use before removing source-hash, alternate spectrogram, and archive utilities. They retain tests/public entry points; lack of a current UI caller alone is not proof of dead code.
- [ ] Decide whether to retire the retained vinext/Cloudflare and optional D1 example build paths. They are configured and built, so removal would change supported delivery behavior.
- [ ] Profile live recording-aligned cache reads before considering persistent overview indexes or additional channel-selective I/O.

See [cleanup evidence](docs/CLEANUP_AUDIT.md) for completed work and explicit limitations. See [technical contracts](docs/PROJECT_DOC.md) before proposing behavior changes.
