/*
Purpose: Configures optional SQLite-compatible Drizzle migration generation.
File Dependencies: None.
*/


import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./db/schema.ts",
  dialect: "sqlite",
});
