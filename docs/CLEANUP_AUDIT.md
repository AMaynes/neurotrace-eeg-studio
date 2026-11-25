# Cleanup audit

Guide: [Unvibe Coding a Codebase](https://github.com/AMaynes/A-Guide-on-Anti-Slop-Vibe-Coding/blob/main/Unvibe-Coding-a-Codebase.md), read at blob `c4093ff69a1fb21ba6eb47c3fc0034f655610d3e`. Cleanup started from `83d566e468b7a9fbab6198ae1fcd738bc5845a0a` on a separate working branch.

## Backups

The user-approved remote `pre-unvibecode-backup` branch was pushed and its commit verified against the starting main commit. It remains unchanged. A separate private local archive outside the checkout includes tracked/ignored files, dependencies, caches, investigation outputs, and the supplied external references. Its CRC verification covered 31,312 files; archive size was 2,279,690,506 bytes. A local verification record contains its SHA-256. Recordings, secrets, and ignored files were not uploaded to GitHub.

## Changes and evidence

- Authored source headers now state purpose and project dependencies. Long obsolete header inventories were replaced by concise ownership statements and a generated repository map.
- Recording-info formatting and resource display moved out of the workspace component. Seven duplicated clock/positive-integer helper implementations now use one shared module; operation-specific abort errors remain distinct.
- The unused authentication module was removed after checking imports, entry points, configuration, and tests. The configured optional hosting build and compatibility utilities were retained.
- Scratch/build output directories no longer enter TypeScript/lint source discovery. Authored build scripts are linted.
- README owns commands/standards; PROJECT_DOC owns feature contracts; STRUCTURE/type models are generated from source; TODO records unresolved work. Source and documentation checks run in the normal check command.
- An AST comparison, ignoring comments and line-ending trivia, found unchanged code structure in 202 pre-existing TypeScript/TSX/MJS files. Differences are confined to the extracted modules/call sites, removed authentication module, lint configuration, and two test-location/assertion updates.
- Exact function-body comparisons verified all six extracted recording-info functions and shared clock/integer guards against each original implementation. The resource-panel comparison permits only the injected cache-budget name and two effect dependency arrays that now name the same stable diagnostics collector passed from the workspace.

The baseline had 971 tests: 970 passed and one failed. The failed accessibility assertion required `role` immediately after `className` and rejected an existing intervening tutorial attribute. Its replacement permits other attributes while retaining the same required dialog role, modal state, and accessible name. The resource test now reads the extracted panel file. No expected numerical output was changed.

## Verification

- `npm run check`: source conventions, documentation freshness/links, TypeScript, ESLint, both production builds, and all 976 tests passed.
- Pre-build source/documentation checks passed with both `dist/` and `pages-dist/` temporarily absent. The checker recognizes those explicitly named generated dependencies without requiring their outputs before compilation.
- Authored build tools passed ESLint after explicitly undoing the framework preset's `build/` exclusion.
- Structural comparisons found 202 unchanged pre-existing code files and verified the extracted implementations as described above; `git diff --check` passed.
- Actual-browser checks covered synthetic EDF import, waveform display, montage switching, filters, full-window spectrogram, Settings, Save, and the extracted performance panel. No browser console errors were observed in those app runs.
- All 41 Mermaid/LaTeX blocks rendered without errors; representative diagrams and equations were visually inspected. All 15 Markdown files passed local link/image checks.

The retained framework build reports existing large-chunk and route-analysis notices. These are not new cleanup failures. No dependency versions or numerical expected outputs changed.

## Visual comparison

Local browser, 1280×720. Baseline: November 24, 2026. After: November 25, 2026. All recordings are synthetic. These are actual captures, not mockups or redactions. Seven matched states have identical decoded pixels: import, recording, tools, filters, spectrogram, settings, and save. The empty view matches 99.76% of pixels, with a pointer/hover difference. This comparison covers the captured states, not every workflow or timing condition.

| State | Before | After |
| --- | --- | --- |
| Empty Info view | [Before](screenshots/browser/before-empty.jpg) | [After](screenshots/browser/after-empty.jpg) |
| Import selection | [Before](screenshots/browser/before-import.jpg) | [After](screenshots/browser/after-import.jpg) |
| Synthetic recording | [Before](screenshots/browser/before-recording.jpg) | [After](screenshots/browser/after-recording.jpg) |
| Viewing Tools | [Before](screenshots/browser/before-tools.jpg) | [After](screenshots/browser/after-tools.jpg) |
| Filter dialog | [Before](screenshots/browser/before-filters.jpg) | [After](screenshots/browser/after-filters.jpg) |
| Spectrogram | [Before](screenshots/browser/before-spectrogram.jpg) | [After](screenshots/browser/after-spectrogram.jpg) |
| Settings | [Before](screenshots/browser/before-settings.jpg) | [After](screenshots/browser/after-settings.jpg) |
| Save prompt | [Before](screenshots/browser/before-save.jpg) | [After](screenshots/browser/after-save.jpg) |

## Explicit limits and guide exceptions

This is a verified cleanup pass, not a claim that every line now satisfies every literal rule. JSON/binary/generated/vendor formats do not receive source comments. Test descriptions and small inline callbacks retain their surrounding context rather than mechanically duplicated sentences; the source checker enforces headers/dependencies and named-function comments outside tests. The remaining callback/helper review is open in TODO.

The large Home coordinator remains; extracting its state/effects without broader interaction checks would put ordering and cancellation at risk. Type models include complete declared signatures and member visibility; diagram panels summarize type references, while exact declarations carry complex unions and optional members. Implicitly inferred types are not invented. Cross-panel runtime ownership/cardinality is documented only where established, not guessed from a type name.

Actual MATLAB-runtime output, protected-data end-to-end parity, all tutorials/error states, mobile/accessibility workflows, the macOS launcher, and live Cloudflare deployment were not exhaustively verified. No cleanup speed benchmark has been run. Existing behavioral limitations are recorded separately rather than silently fixed during a behavior-preserving cleanup.
