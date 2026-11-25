/*
Purpose: Configures static analysis for the NeuroTrace TypeScript and React source.
File Dependencies: None.
*/


import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Include authored build tools while excluding generated output and local probes.
  globalIgnores([
    "!build/",
    "!build/**",
    ".next/**",
    "out/**",
    "dist/**",
    "pages-dist/**",
    "work/**",
    "outputs/**",
    ".wrangler/**",
    ".npm-cache/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
