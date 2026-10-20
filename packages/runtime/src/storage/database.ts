/**
 * The runtime's only view of SQLite (ADR-0008). Callers use this interface, never
 * `node:sqlite`, so the backend can be swapped for `better-sqlite3` without touching them.
 * All calls are synchronous, matching both backends.
 */

export type SqlValue = string | number | bigint | null | Uint8Array;
/** Positional (`?`) or named (`:name`) parameters. */
export type SqlParams = readonly SqlValue[] | Readonly<Record<string, SqlValue>>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Database {
  /** Runs one statement that returns no rows. */
  run(sql: string, params?: SqlParams): RunResult;
  /** The first row, or undefined. */
  get<Row>(sql: string, params?: SqlParams): Row | undefined;
  all<Row>(sql: string, params?: SqlParams): Row[];
  /** Runs a script of several statements without parameters (migrations). */
  exec(sql: string): void;
  /**
   * Runs `work` in one transaction: committed if it returns, rolled back if it throws.
   * Nested calls join the outer transaction.
   */
  transaction<T>(work: () => T): T;
  readonly readOnly: boolean;
  close(): void;
}
