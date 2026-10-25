import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { ErrorCodes, type JesutobitsErrorCode } from "@jesutobits/protocol";
import type { Logger } from "@jesutobits/shared";
import type { Database } from "./database.js";
import { MIGRATIONS, type Migration } from "./migrations/index.js";
import { NodeSqliteDatabase } from "./node-sqlite.js";

export const DATABASE_FILE = "jesutobits.db";
/** Present while the database is open; found at startup, it means the last run crashed. */
const OPEN_MARKER = "jesutobits.db.open";
const BACKUPS_KEPT = 3;

/** Something the user should be told about the database (shown as a banner later). */
export interface StorageNotice {
  code: JesutobitsErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface Storage {
  db: Database;
  /** `read_only` after a failed upgrade or with a newer database (DATA_AND_PERSISTENCE.md 6.1). */
  mode: "read_write" | "read_only";
  notices: StorageNotice[];
  /** Closes the database and clears the unclean-shutdown marker. */
  close(): void;
}

export interface OpenStorageOptions {
  /** The app data dir. Without one, the database lives in memory (tests, no `--data-dir`). */
  dir: string | undefined;
  log: Logger;
  now?: () => Date;
  migrations?: readonly Migration[];
}

/**
 * Opens `jesutobits.db`, recovers from corruption and applies pending migrations, following
 * DATA_AND_PERSISTENCE.md section 6.1:
 *
 * - After an unclean shutdown, `PRAGMA quick_check` runs; a database that fails it, or that
 *   cannot be opened at all, is moved aside as `jesutobits.corrupt-<time>.db` and a new one
 *   is created.
 * - Before migrating an existing database, a `VACUUM INTO` backup goes to `backups/`
 *   (the last three are kept). All pending migrations run in one transaction.
 * - A failed migration rolls back and the database opens read-only. So does a database
 *   from a newer Jesutobits.
 */
export function openStorage(options: OpenStorageOptions): Storage {
  const { log } = options;
  const now = options.now ?? (() => new Date());
  const migrations = options.migrations ?? MIGRATIONS;
  checkMigrations(migrations);
  const latest = migrations.at(-1)?.version ?? 0;
  const notices: StorageNotice[] = [];

  if (options.dir === undefined) {
    log.warn("no data dir; using an in-memory database");
    const db = new NodeSqliteDatabase(":memory:");
    migrate(db, migrations, 0);
    return { db, mode: "read_write", notices, close: () => db.close() };
  }

  const dir = options.dir;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, DATABASE_FILE);
  const marker = join(dir, OPEN_MARKER);
  const unclean = existsSync(marker);

  let db: Database =
    openChecked(path, unclean, log) ?? startFresh(dir, unclean, now(), log, notices);
  writeFileSync(marker, String(process.pid));

  const close = (): void => {
    db.close();
    rmSync(marker, { force: true });
  };

  const version = userVersion(db);
  if (version > latest) {
    db.close();
    db = new NodeSqliteDatabase(path, { readOnly: true });
    log.warn("the database is newer than this runtime", { version, latest });
    notices.push({
      code: ErrorCodes.storageNewerDatabase,
      message:
        "This database was written by a newer version of Jesutobits. It is open read-only; update Jesutobits or restore a backup.",
      details: { version, latest },
    });
    return { db, mode: "read_only", notices, close };
  }

  if (version < latest) {
    if (version > 0) backup(db, dir, version, now(), log);
    try {
      migrate(db, migrations, version);
      log.info("database migrated", { from: version, to: latest });
    } catch (error) {
      db.close();
      db = new NodeSqliteDatabase(path, { readOnly: true });
      log.error("a database migration failed and was rolled back", {
        from: version,
        to: latest,
        err: error,
      });
      notices.push({
        code: ErrorCodes.storageMigrationFailed,
        message:
          "Jesutobits could not upgrade its database. It is open read-only; you can restore a backup or start fresh.",
        details: { from: version, to: latest, cause: String(error) },
      });
      return { db, mode: "read_only", notices, close };
    }
  }
  return { db, mode: "read_write", notices, close };
}

/** Opens the file, running `quick_check` after an unclean shutdown. Undefined if unusable. */
function openChecked(path: string, unclean: boolean, log: Logger): Database | undefined {
  let db: NodeSqliteDatabase;
  try {
    db = new NodeSqliteDatabase(path);
  } catch (error) {
    log.warn("the database could not be opened", { err: error });
    return undefined;
  }
  if (!unclean) return db;
  log.info("the last run did not shut down cleanly; checking the database");
  try {
    const rows = db.all<{ quick_check: string }>("PRAGMA quick_check");
    if (rows.length === 1 && rows[0]?.quick_check === "ok") return db;
    log.warn("quick_check found problems", { problems: rows.slice(0, 10) });
  } catch (error) {
    log.warn("quick_check failed", { err: error });
  }
  db.close();
  return undefined;
}

/**
 * Moves an unusable database aside and creates a new one, with a notice for the user. The
 * notice names an unexpected shutdown only when the marker shows there was one.
 */
function startFresh(
  dir: string,
  unclean: boolean,
  at: Date,
  log: Logger,
  notices: StorageNotice[],
): Database {
  const aside = moveAside(dir, at);
  log.error("the database was unreadable and was moved aside", { movedTo: aside });
  const when = unclean ? " after an unexpected shutdown" : "";
  notices.push({
    code: ErrorCodes.storageCorruptRecovered,
    message: `Jesutobits could not read its database${when} and started a new one. The old file was kept as ${basename(aside)}.`,
    details: { movedTo: aside },
  });
  return new NodeSqliteDatabase(join(dir, DATABASE_FILE));
}

function moveAside(dir: string, at: Date): string {
  const target = join(dir, `jesutobits.corrupt-${fileStamp(at)}.db`);
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = join(dir, `${DATABASE_FILE}${suffix}`);
    if (existsSync(from)) renameSync(from, `${target}${suffix}`);
  }
  return target;
}

function backup(db: Database, dir: string, version: number, at: Date, log: Logger): void {
  const backups = join(dir, "backups");
  mkdirSync(backups, { recursive: true });
  const target = join(backups, `jesutobits-v${version}-${fileStamp(at)}.db`);
  db.run("VACUUM INTO ?", [target]);
  log.info("database backed up before migrating", { path: target });
  const old = readdirSync(backups)
    .filter((name) => /^jesutobits-v\d+-.+\.db$/.test(name))
    .map((name) => ({ name, mtime: statSync(join(backups, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))
    .slice(BACKUPS_KEPT);
  for (const { name } of old) rmSync(join(backups, name), { force: true });
}

function migrate(db: Database, migrations: readonly Migration[], from: number): void {
  const pending = migrations.filter((migration) => migration.version > from);
  if (pending.length === 0) return;
  db.transaction(() => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    for (const migration of pending) {
      db.exec(migration.sql);
      db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
        migration.version,
        new Date().toISOString(),
      ]);
    }
    // user_version lives in the header and is part of the transaction.
    db.exec(`PRAGMA user_version = ${pending.at(-1)?.version ?? from}`);
  });
}

function userVersion(db: Database): number {
  return db.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0;
}

function checkMigrations(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Migration ${migration.name} has version ${migration.version}, expected ${index + 1}`,
      );
    }
  });
}

/** A timestamp safe in Windows file names: 2026-10-20T14-28-57-005Z. */
function fileStamp(at: Date): string {
  return at.toISOString().replace(/[:.]/g, "-");
}
