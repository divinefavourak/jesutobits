// Each .sql file has a .d.sql.ts next to it that types the import (allowArbitraryExtensions).
import projects from "./0001_projects.sql";

export interface Migration {
  /** Consecutive from 1; stored in `PRAGMA user_version` and `schema_migrations`. */
  version: number;
  name: string;
  sql: string;
}

/**
 * Every migration, in order (PROJECT_STRUCTURE.md section 4). A merged migration is never
 * edited; a test pins each file's hash. The SQL files are inlined as text by esbuild
 * (scripts/build-runtime.mjs) and by Vitest (vitest.config.ts).
 */
export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: "projects", sql: projects }];
