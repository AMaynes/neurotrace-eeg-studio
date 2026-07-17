/**
 * Overview & Purpose
 * Provides the minimal Next-compatible configuration surface required by vinext.
 *
 * Architectural Relationships
 * Called by: The framework build.
 * Calls: None.
 *
 * External Resources
 * None.
 *
 * Notes
 * Runtime hosting behavior is configured in vite.config.ts and worker/index.ts.
 */


import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
