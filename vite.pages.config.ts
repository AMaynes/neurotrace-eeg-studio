/**
 * Reproducible, browser-only GitHub Pages build.
 *
 * This configuration deliberately excludes vinext, React Server Components,
 * Cloudflare adapters, and application-server bindings. Every runtime asset is
 * emitted beneath pages-dist with a document-relative URL.
 */

import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const projectFile = (relativePath: string) =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [react()],
  publicDir: projectFile("./public"),
  build: {
    assetsDir: "assets",
    cssCodeSplit: true,
    emptyOutDir: true,
    outDir: projectFile("./pages-dist"),
    rollupOptions: {
      input: projectFile("./index.html"),
    },
    sourcemap: false,
  },
});
