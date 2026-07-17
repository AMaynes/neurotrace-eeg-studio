/**
 * Overview & Purpose
 * Configures static analysis for the NeuroTrace TypeScript and React source.
 *
 * Architectural Relationships
 * Called by: npm run lint.
 * Calls: Next.js core-web-vitals and TypeScript ESLint presets.
 *
 * External Resources
 * Generated build directories are excluded from analysis.
 *
 * Notes
 * Source and tests remain linted; only machine-produced output is ignored.
 */


import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "work/static-host/dist/**",
    "work/static-host/publish/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
