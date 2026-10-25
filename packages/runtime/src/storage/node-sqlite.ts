import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Database, RunResult, SqlParams } from "./database.js";

export interface OpenOptions {
  readOnly?: boolean;
}

/**
 * `Database` on Node's built-in `node:sqlite` (ADR-0008). Opened with DATA_AND_PERSISTENCE.md
 * section 4's settings: WAL, foreign keys, a 5 s busy timeout and `synchronous=NORMAL`
 * (Spike S1 measured the write cost). Prepared statements are cached by SQL text.
 */
export class NodeSqliteDatabase implements Database {
  readonly readOnly: boolean;
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;

  /** `path` may be `:memory:`. Throws if the file is not a SQLite database. */
  constructor(path: string, options: OpenOptions = {}) {
    this.readOnly = options.readOnly ?? false;
    this.db = new DatabaseSync(path, {
      readOnly: this.readOnly,
      enableForeignKeyConstraints: true,
    });
    try {
      // The first statement reads the header, so a corrupt file fails here.
      this.db.exec("PRAGMA busy_timeout = 5000");
      if (!this.readOnly) this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.prepare("SELECT count(*) FROM sqlite_schema").get();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  run(sql: string, params?: SqlParams): RunResult {
    const result = bind(this.statement(sql), params, "run");
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  get<Row>(sql: string, params?: SqlParams): Row | undefined {
    return bind(this.statement(sql), params, "get") as Row | undefined;
  }

  all<Row>(sql: string, params?: SqlParams): Row[] {
    return bind(this.statement(sql), params, "all") as Row[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  transaction<T>(work: () => T): T {
    if (this.depth > 0) {
      this.depth += 1;
      try {
        return work();
      } finally {
        this.depth -= 1;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  close(): void {
    this.statements.clear();
    if (this.db.isOpen) this.db.close();
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
}

function bind(statement: StatementSync, params: SqlParams | undefined, method: "run"): RunLike;
function bind(
  statement: StatementSync,
  params: SqlParams | undefined,
  method: "get" | "all",
): unknown;
function bind(
  statement: StatementSync,
  params: SqlParams | undefined,
  method: "run" | "get" | "all",
): unknown {
  // node:sqlite takes positional values as arguments, or one object of named values.
  const args = params === undefined ? [] : Array.isArray(params) ? params : [params];
  return (statement[method] as (...values: unknown[]) => unknown).apply(statement, args);
}

interface RunLike {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}
