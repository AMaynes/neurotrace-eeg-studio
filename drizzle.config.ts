/**
 * Overview & Purpose
 * Configures optional SQLite-compatible Drizzle migration generation.
 *
 * Architectural Relationships
 * Called by: The npm db:generate command.
 * Calls: db/schema.ts and writes generated migration artifacts under drizzle/.
 *
 * External Resources
 * None.
 *
 * Notes
 * Database generation is inactive while the production schema remains empty.
 */


import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./db/schema.ts",
  dialect: "sqlite",
});
