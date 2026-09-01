# Project Structure

## Structure at a Glance

```text
neurotrace-eeg-studio/
├── .github/
│   └── workflows/
│       └── deploy-pages.yml — Verifies `main`, builds the static artifact, and deploys GitHub Pages.
├── .openai/
│   └── hosting.json — Retains the legacy Sites project identifier and optional logical storage bindings.
├── app/
│   ├── bids-companions.ts — Catalogs selected files and resolves matching BIDS JSON/TSV metadata, tables, channels, and events.
│   ├── chatgpt-auth.ts — Provides optional ChatGPT-host authentication helpers; unused by the public GitHub build.
│   ├── eeg-core.ts — Owns recording parsing, windowed signal access, filters, montages, and signal-domain utilities.
│   ├── globals.css — Defines the complete NeuroTrace visual system and responsive workspace layout.
│   ├── layout.tsx — Supplies application metadata, social previews, viewport configuration, and the root HTML shell.
│   ├── pages-client.tsx — Mounts the shared workstation for the browser-only GitHub Pages release.
│   ├── page.tsx — Coordinates the browser workstation, annotation state, session workflow, rendering, and exports.
│   └── source-integrity.ts — Computes incremental SHA-256 fingerprints without buffering complete recordings.
├── build/
│   └── sites-vite-plugin.ts — Copies Sites metadata and migrations into deployment output.
├── db/
│   ├── index.ts — Creates the optional Drizzle client when a D1 binding exists.
│   └── schema.ts — Defines the intentionally empty production database schema.
├── drizzle/
│   └── meta/
│       └── _journal.json — Tracks generated Drizzle migration history.
├── examples/
│   └── d1/
│       ├── app/
│       │   └── api/
│       │       └── notes/
│       │           └── route.ts — Demonstrates optional D1 CRUD route handling.
│       └── db/
│           └── schema.ts — Demonstrates an optional notes table.
├── public/
│   └── og.png — Provides the NeuroTrace social-preview image.
├── tests/
│   ├── bids-companions.test.mjs — Verifies BIDS inheritance, TSV decoding, event/channel discovery, and additive file selection.
│   ├── eeg-integrity.test.mjs — Verifies EDF+ annotation decoding and montage safety.
│   ├── pages-release.test.mjs — Verifies the static Pages artifact and relative runtime assets.
│   ├── rendered-html.test.mjs — Verifies server rendering and key product interaction contracts.
│   └── source-integrity.test.mjs — Verifies incremental SHA-256 correctness across chunk boundaries.
├── worker/
│   └── index.ts — Adapts the vinext application and image endpoint to a Cloudflare Worker.
├── .gitignore — Excludes dependencies, builds, local state, secrets, and generated work products.
├── Launch NeuroTrace.command — Starts a loopback-only local viewer from a macOS Finder double-click.
├── README.md — Introduces NeuroTrace, its architecture, privacy model, limits, and validation workflow.
├── STRUCTURE.md — Maps the repository and defines subsystem ownership.
├── TODO.md — Tracks pressing and eventual engineering outcomes.
├── cloudflare-env.d.ts — Declares the minimal Cloudflare bindings used by development infrastructure.
├── drizzle.config.ts — Configures optional SQLite/D1 migration generation.
├── eslint.config.mjs — Configures Next.js TypeScript and core-web-vitals linting.
├── index.html — Defines metadata and the mount point for the static Pages release.
├── next.config.ts — Holds the intentionally minimal Next-compatible configuration.
├── package-lock.json — Locks the npm dependency graph.
├── package.json — Declares runtime requirements, dependencies, and development commands.
├── postcss.config.mjs — Enables Tailwind’s PostCSS integration for the build.
├── tsconfig.json — Configures strict TypeScript checking and framework path resolution.
├── vite.config.ts — Assembles vinext, Sites packaging, and Cloudflare build adapters.
└── vite.pages.config.ts — Builds the browser-only static artifact in `pages-dist/`.

Generated or local-only directories such as `node_modules/`, `dist/`, `pages-dist/`, `.next/`, `.vinext/`, `.wrangler/`, `outputs/`, and `work/` are not source architecture and must not contain canonical implementation.
```

---

# Detailed Reference

## `.github/`

Contains GitHub automation only. Product behavior and provider-independent build logic must remain in the application and build configuration.

### `.github/workflows/deploy-pages.yml`

Runs the complete verification suite for every push to `main`, uploads `pages-dist/`, and deploys that exact artifact to GitHub Pages. `backup` does not trigger deployment.

## `.openai/`

Contains hosting control metadata for the original Sites deployment path. It must not contain credentials, environment values, or application data.

### `.openai/hosting.json`

Stores the opaque Sites project identifier plus optional logical D1/R2 binding names. The current public application is GitHub Pages; this file remains only for compatibility with the original build path and should be removed if that path is formally retired.

## `app/`

Owns the product-facing React application and browser-only signal domain. Recording data and annotation behavior belong here; provider-specific deployment mechanics do not.

### `app/chatgpt-auth.ts`

Provides validated sign-in/sign-out paths and optional identity extraction from trusted ChatGPT hosting headers. No current NeuroTrace route imports it, and the public GitHub build does not use it.

### `app/bids-companions.ts`

Catalogs every file selected through individual upload, directory selection, or later drag-and-drop. It parses bounded JSON/TSV companions, applies BIDS entity compatibility and inheritance specificity, extracts matching participant/session/scan rows, channels, channel-quality flags, and events, and retains unassociated files in the visible provenance inventory.

### `app/eeg-core.ts`

Defines recording metadata and source contracts, EDF/EDF+ parsing, legacy MAT/DAT mapping, MATLAB v5 decoding, MATLAB v7.3 worker-backed HDF5 access, windowed file reads, display filters, montage construction, formatting, and deterministic demo signals. It is browser-compatible and intentionally avoids Node.js dependencies.

### `app/globals.css`

Defines product colors, typography, panel layout, waveform/timeline controls, dialogs, responsive sizing, and accessibility states. Component-specific behavior remains in `page.tsx`; this file owns presentation only.

### `app/layout.tsx`

Builds host-aware metadata and the root document shell. It references `public/og.png` and declares the canonical GitHub Pages URL.

### `app/pages-client.tsx`

Mounts the shared `Home` component and global stylesheet into the static HTML shell. It contains no server or provider adapter and is used only by `vite.pages.config.ts`.

### `app/page.tsx`

Owns the current workstation orchestration: recording import, session state, local recovery, waveform rendering, timeline labeling, queue navigation, QC, dialogs, and export assembly. Its breadth is an acknowledged refactoring target, but behavioral extraction should follow browser interaction coverage.

### `app/source-integrity.ts`

Implements bounded-memory incremental SHA-256 and chunked `Blob` hashing. It is part of source provenance and must remain deterministic across chunk sizes.

## `build/`

Contains build-time adapters. Product logic and runtime recording behavior must not be added here.

### `build/sites-vite-plugin.ts`

Copies `.openai/hosting.json` and generated Drizzle migrations into the vinext deployment artifact after Vite compilation.

## `db/`

Contains optional D1/Drizzle infrastructure. The current local-first product does not persist recordings or annotations to a database.

### `db/index.ts`

Creates a typed Drizzle client from the injected `DB` binding and fails with an actionable message when the binding is absent.

### `db/schema.ts`

Exports an intentionally empty schema so database capability remains opt-in.

## `drizzle/`

Contains generated migration artifacts when optional D1 storage is activated. Handwritten application code does not belong here.

### `drizzle/meta/`

Contains Drizzle’s generated migration bookkeeping.

### `drizzle/meta/_journal.json`

Records the migration sequence. It should change only through migration tooling.

## `examples/`

Contains isolated examples that are not part of the NeuroTrace runtime. Example code must not be imported by production paths.

### `examples/d1/`

Demonstrates how an optional D1-backed feature could be structured.

### `examples/d1/app/`

Mirrors the application route shape for the example only.

### `examples/d1/app/api/`

Groups example API handlers.

### `examples/d1/app/api/notes/`

Owns the example notes endpoint.

### `examples/d1/app/api/notes/route.ts`

Demonstrates bounded list and validated create operations with actionable database errors.

### `examples/d1/db/`

Owns the example’s schema rather than the production schema.

### `examples/d1/db/schema.ts`

Defines a simple notes table for D1 demonstrations.

## `public/`

Contains immutable assets served directly by the application.

### `public/og.png`

Provides the branded social card referenced by application metadata.

## `tests/`

Contains deterministic Node tests. Tests may import TypeScript source directly under the supported Node runtime and may inspect rendered/source contracts where browser automation is not yet available.

### `tests/eeg-integrity.test.mjs`

Exercises EDF+ text-annotation extraction and rejects unsafe mixed-rate bipolar derivations.

### `tests/bids-companions.test.mjs`

Exercises directory-style BIDS discovery, metadata specificity, participant matching, channel and event parsing, quoted TSV fields, malformed companions, and additive file replacement.

### `tests/pages-release.test.mjs`

Checks the built `pages-dist/` snapshot for document-relative hashed assets, the social image, and the absence of server/RSC runtime references.

### `tests/rendered-html.test.mjs`

Builds the server worker, verifies the rendered NeuroTrace shell, and protects key interface and interaction wiring from regression.

### `tests/source-integrity.test.mjs`

Compares the incremental browser-compatible SHA-256 implementation with Node’s trusted implementation across boundary conditions.

## `worker/`

Contains Cloudflare-specific request adaptation. Browser signal processing must remain independent of this layer.

### `worker/index.ts`

Routes image-optimization requests through Cloudflare Images and delegates all other requests to the vinext application handler.

## `.gitignore`

Excludes dependencies, framework output, local Cloudflare state, secrets, TypeScript build info, generated deployment output, and temporary work products.

## `Launch NeuroTrace.command`

Provides the macOS one-click local entry point. It asks for and validates an unprivileged port, rejects occupied ports, prepares the static Pages build, binds Vite preview to `127.0.0.1`, and opens the default browser only after the local viewer responds.

## `README.md`

Serves as the developer entry point and concise operational description. It documents the local-first privacy boundary and distinguishes theoretical scaling from measured performance.

## `STRUCTURE.md`

Is the authoritative repository map. Update it whenever a tracked human-maintained file, folder, or ownership boundary changes.

## `TODO.md`

Uses only `Pressing` and `Eventual` sections. Remove completed items rather than retaining a completed-work archive.

## `cloudflare-env.d.ts`

Declares the subset of Worker and D1 interfaces needed for strict TypeScript checking without importing provider runtime types into the browser domain.

## `drizzle.config.ts`

Points migration generation at `db/schema.ts` and emits SQLite-compatible artifacts under `drizzle/`.

## `eslint.config.mjs`

Combines Next.js core-web-vitals and TypeScript rules while excluding generated build and static-release output.

## `index.html`

Provides canonical metadata and the application mount for the static GitHub Pages build. Runtime assets are injected and rewritten by Vite.

## `next.config.ts`

Provides the minimal Next-compatible configuration surface required by vinext.

## `package-lock.json`

Pins exact transitive npm dependencies. Update it only through the package manager.

## `package.json`

Defines Node compatibility, project commands, and dependencies. Database and Cloudflare packages are retained for optional infrastructure rather than current product persistence.

## `postcss.config.mjs`

Registers the Tailwind PostCSS plugin used by the existing build pipeline.

## `tsconfig.json`

Enables strict, no-emit TypeScript checking, DOM libraries, isolated modules, framework plugins, and the `@/` project alias.

## `vite.config.ts`

Builds the application through vinext, packages Sites metadata, configures optional local D1/R2 bindings, and adapts file watching for sandboxed macOS previews.

## `vite.pages.config.ts`

Builds a browser-only static release with React and document-relative asset URLs. It emits the deployable `pages-dist/` snapshot without vinext, Worker, Cloudflare, D1, or R2 runtime dependencies.
