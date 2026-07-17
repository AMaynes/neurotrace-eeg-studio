/**
 * Overview & Purpose
 * Defines the example notes table for optional D1 demonstrations.
 *
 * Architectural Relationships
 * Called by: examples/d1/app/api/notes/route.ts.
 * Calls: Drizzle SQLite schema builders.
 *
 * External Resources
 * An example D1 database when explicitly enabled.
 *
 * Notes
 * This schema is separate from the intentionally empty production db/schema.ts.
 */


import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  content: text("content").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
