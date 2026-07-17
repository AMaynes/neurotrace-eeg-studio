/**
 * Overview & Purpose
 * Declares the minimal Cloudflare runtime contracts used during type checking.
 *
 * Architectural Relationships
 * Called by: worker/index.ts and db/index.ts through global/provider types.
 * Calls: None.
 *
 * External Resources
 * Cloudflare Worker ASSETS, IMAGES, and optional D1 bindings.
 *
 * Notes
 * These declarations contain no runtime behavior.
 */


interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<T[]>;
  exec(query: string): Promise<unknown>;
  dump(): Promise<ArrayBuffer>;
}

declare module "cloudflare:workers" {
  export const env: { DB?: D1Database };
}
