# NeuroTrace

NeuroTrace opens local EEG recordings for waveform review and annotation. Recording samples stay in the browser. It is a research tool, not a validated diagnostic system.

[Open the viewer](https://amaynes.github.io/neurotrace-eeg-studio/) · [Technical reference](docs/PROJECT_DOC.md) · [Repository map](STRUCTURE.md) · [Open work](TODO.md)

## Run and check

Requires Node.js 22.13 or newer and npm. Install locked dependencies:

```sh
npm ci
npm run dev
```

For the static browser build:

```sh
npm run build:pages
npm run preview:local -- --port 4173
```

Run `npm run check` before publishing. It checks source conventions, TypeScript, lint, both build targets, and the test suite. `npm test` also builds both targets. `npm run test:pages` checks the static release. `npm run docs:check` checks documentation inventories and local links; `npm run docs:generate` refreshes source/type inventories after structural edits.

On macOS, **Launch NeuroTrace.command** prepares the static build, asks for a port, and opens the viewer. Keep its Terminal window open; Control-C stops it. Initial dependency installation needs internet access. This launcher was not executed during the Windows cleanup audit.

## Use

Choose **Load a recording**, then **Files** or **Folder**. Select EDF/EDF+, MAT, or matching MAT + DAT files. Confirm the preview to open a recording. Use **Info** for file/performance details, **Viewing Tools** for display controls, and **Labels** for review. **Save** writes portable review files; browser recovery is separate.

The [feature index](docs/PROJECT_DOC.md#feature-index) covers ingestion, directories, navigation, labels, montages, filtering, spectrograms, timing, controls, tutorials, recovery, exports, and diagnostics. Numerical assumptions and deliberate differences from MATLAB are documented there.

## Development standards

Follow [Unvibe Coding a Codebase](https://github.com/AMaynes/A-Guide-on-Anti-Slop-Vibe-Coding/blob/main/Unvibe-Coding-a-Codebase.md). Cleanup preserves outputs, interactions, stored data, errors, and ordering. Behavior changes need their own scope and verification.

- Use descriptive names and cohesive modules. Preserve external names, persisted keys, and format contracts.
- Begin authored code with **Purpose:** and **File Dependencies:**, then exactly two blank lines. Use project-relative paths or **None**. A required shell shebang precedes the header. JSON, binary assets, generated output, and vendored code retain their required formats.
- Document function contracts with complete sentences. Explain units, ownership, cancellation, and non-obvious boundaries. Avoid repeating names, test descriptions, or obvious inline expressions merely to increase comment coverage. The [cleanup audit](docs/CLEANUP_AUDIT.md) records remaining literal-guide exceptions.
- Consolidate only equivalent behavior. Keep distinct error contracts separate. Check callers, dynamic imports, build configuration, and compatibility use before deleting code.
- Keep facts in one authoritative location: commands/standards here, contracts in the technical reference, paths in STRUCTURE, outstanding work in TODO.
- Match verification to risk. Do not change expected results to conceal behavior differences. Use synthetic data in committed fixtures and screenshots.
- Do not commit recordings, credentials, browser caches, generated builds, or local investigation files.

`app/` remains the framework entry directory. The source/type inventory is generated documentation, not a second implementation. Build outputs and local investigation files are ignored.

## Publishing

`main` is the routine push and GitHub Pages deployment branch. The workflow runs `npm run check`, then publishes `pages-dist/`. Never edit deployed bundles directly.

`pre-unvibecode-backup` preserves cleanup's starting commit, `83d566e468b7a9fbab6198ae1fcd738bc5845a0a`. It is not a development branch. The older `backup` branch is a separate point-in-time copy. Ordinary publishing does not change either backup.
