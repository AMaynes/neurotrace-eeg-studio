/**
 * Browser-only entry point for the static GitHub Pages release.
 *
 * The product component intentionally remains shared with the vinext build. This
 * adapter supplies only the DOM mount that a server-rendered route would
 * otherwise provide.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./globals.css";
import Home from "./page";

const container = document.getElementById("neurotrace-root");

if (!container) {
  throw new Error("NeuroTrace could not find its application mount point.");
}

createRoot(container).render(
  <StrictMode>
    <Home />
  </StrictMode>,
);
