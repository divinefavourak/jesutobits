import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@jesutobits/shared";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, type Migration } from "./migrations/index.js";
import { NodeSqliteDatabase } from "./node-sqlite.js";
import { DATABASE_FILE, openStorage, type Storage } from "./storage.js";

const dirs: string[] = [];
const open: Storage[] = [];

afterEach(() => {
  for (const storage of open.splice(0)) storage.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jesutobits-storage-"));
  dirs.push(dir);
  return dir;
}

let clock = Date.parse("2026-10-20T14:00:00.000Z");
function start(dir: string | undefined, migrations?: readonly Migration[]): Storage {
  const storage = openStorage({
    dir,
    log: nullLogger,
    // Distinct times keep backup and corrupt-file names unique.
    now: () => new Date((clock += 1000)),
    ...(migrations && { migrations }),
  });
  open.push(storage);
  return storage;
}

function stop(storage: Storage): void {
  storage.close();
  open.splice(open.indexOf(storage), 1);
}

const tableNames = (storage: Storage) =>
  storage.db
    .all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .map((row) => row.name);

const m1: Migration = { version: 1, name: "one", sql: "CREATE TABLE one (id INTEGER);" };
const m2: Migration = { version: 2, name: "two", sql: "CREATE TABLE two (id INTEGER);" };
const broken: Migration = {
  version: 2,
  name: "broken",
  sql: "CREATE TABLE half (id INTEGER); INSERT INTO missing_table VALUES (1);",
};

describe("openStorage", () => {
  it("creates a new database at the latest version", () => {
    const dir = tempDir();
    const storage = start(dir);
    expect(storage.mode).toBe("read_write");
    expect(storage.notices).toEqual([]);
    expect(tableNames(storage)).toEqual(["projects", "schema_migrations"]);
    expect(storage.db.get("PRAGMA user_version")).toEqual({ user_version: MIGRATIONS.length });
    expect(storage.db.get("PRAGMA journal_mode")).toEqual({ journal_mode: "wal" });
    expect(storage.db.get("PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 });
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });

  it("does nothing on a second open at the same version", () => {
    const dir = tempDir();
    stop(start(dir));
    const storage = start(dir);
    expect(storage.notices).toEqual([]);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });

  it("backs up, then applies only the pending migrations", () => {
    const dir = tempDir();
    const first = start(dir, [m1]);
    first.db.run("INSERT INTO one VALUES (7)");
    stop(first);

    const storage = start(dir, [m1, m2]);
    expect(tableNames(storage)).toEqual(["one", "schema_migrations", "two"]);
    expect(storage.db.all("SELECT version FROM schema_migrations")).toEqual([
      { version: 1 },
      { version: 2 },
    ]);
    const backups = readdirSync(join(dir, "backups"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^jesutobits-v1-2026-10-20T\d\d-\d\d-\d\d-\d{3}Z\.db$/);

    // The backup is a complete copy at version 1.
    const copy = new NodeSqliteDatabase(join(dir, "backups", backups[0] ?? ""), {
      readOnly: true,
    });
    expect(copy.all("SELECT id FROM one")).toEqual([{ id: 7 }]);
    expect(copy.get("PRAGMA user_version")).toEqual({ user_version: 1 });
    copy.close();
  });

  it("keeps the three newest backups", () => {
    const dir = tempDir();
    const chain: Migration[] = [];
    for (let version = 1; version <= 6; version++) {
      chain.push({ version, name: `v${version}`, sql: `CREATE TABLE t${version} (id INTEGER);` });
      stop(start(dir, chain));
    }
    expect(readdirSync(join(dir, "backups")).sort()).toEqual([
      expect.stringMatching(/^jesutobits-v3-/),
      expect.stringMatching(/^jesutobits-v4-/),
      expect.stringMatching(/^jesutobits-v5-/),
    ]);
  });

  it("rolls back a failed migration and opens read-only", () => {
    const dir = tempDir();
    stop(start(dir, [m1]));

    const storage = start(dir, [m1, broken]);
    expect(storage.mode).toBe("read_only");
    expect(storage.notices).toMatchObject([{ code: "storage.migration_failed" }]);
    // Nothing from the failed migration survived, including its first statement.
    expect(tableNames(storage)).toEqual(["one", "schema_migrations"]);
    expect(storage.db.get("PRAGMA user_version")).toEqual({ user_version: 1 });
    expect(() => storage.db.run("INSERT INTO one VALUES (1)")).toThrow(/readonly/i);
  });

  it("opens a database from a newer Jesutobits read-only", () => {
    const dir = tempDir();
    stop(start(dir, [m1, m2]));

    const storage = start(dir, [m1]);
    expect(storage.mode).toBe("read_only");
    expect(storage.notices).toMatchObject([
      { code: "storage.newer_database", details: { version: 2, latest: 1 } },
    ]);
  });

  it("moves an unreadable database aside after an unclean shutdown", () => {
    const dir = tempDir();
    stop(start(dir));
    // A crash: the marker is left behind and the file is truncated.
    writeFileSync(join(dir, "jesutobits.db.open"), "1234");
    writeFileSync(join(dir, DATABASE_FILE), readFileSync(join(dir, DATABASE_FILE)).subarray(0, 50));

    const storage = start(dir);
    expect(storage.mode).toBe("read_write");
    expect(storage.notices).toMatchObject([{ code: "storage.corrupt_recovered" }]);
    expect(tableNames(storage)).toContain("projects");
    expect(readdirSync(dir).filter((name) => name.startsWith("jesutobits.corrupt-"))).toHaveLength(
      1,
    );
  });

  it("recovers a file that is not a database even after a clean shutdown", () => {
    const dir = tempDir();
    writeFileSync(join(dir, DATABASE_FILE), "this is not a database, it is plain text....");
    const storage = start(dir);
    expect(storage.notices).toMatchObject([{ code: "storage.corrupt_recovered" }]);
    expect(tableNames(storage)).toContain("projects");
  });

  it("keeps a healthy database after an unclean shutdown", () => {
    const dir = tempDir();
    const first = start(dir, [m1]);
    first.db.run("INSERT INTO one VALUES (1)");
    stop(first);
    writeFileSync(join(dir, "jesutobits.db.open"), "1234");

    const storage = start(dir, [m1]);
    expect(storage.notices).toEqual([]);
    expect(storage.db.all("SELECT id FROM one")).toEqual([{ id: 1 }]);
  });

  it("marks the database open until it is closed", () => {
    const dir = tempDir();
    const storage = start(dir);
    expect(existsSync(join(dir, "jesutobits.db.open"))).toBe(true);
    stop(storage);
    expect(existsSync(join(dir, "jesutobits.db.open"))).toBe(false);
  });

  it("uses an in-memory database without a data dir", () => {
    const storage = start(undefined);
    expect(tableNames(storage)).toContain("projects");
  });

  it("refuses migrations that are not numbered 1, 2, 3...", () => {
    expect(() => start(tempDir(), [m2])).toThrow(/expected 1/);
  });
});

describe("migrations", () => {
  // A merged migration is never edited (PROJECT_STRUCTURE.md section 4). Add a line here when
  // adding a migration; never change an existing one.
  const PINNED: Record<string, string> = {
    "0001_projects.sql": "a3b07c3d9ffa44a534c02ed3810ba7c72bfff254d17ea09ea6d3233127ccc37a",
  };

  it("are numbered consecutively and pinned", () => {
    const dir = new URL("./migrations/", import.meta.url);
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(files).toEqual(Object.keys(PINNED));
    files.forEach((file, index) => {
      expect(file.startsWith(String(index + 1).padStart(4, "0"))).toBe(true);
      // Each migration's text import is typed by a .d.sql.ts next to it.
      expect(existsSync(new URL(file.replace(/\.sql$/, ".d.sql.ts"), dir)), file).toBe(true);
      const text = readFileSync(new URL(file, dir), "utf8").replace(/\r\n/g, "\n");
      expect(createHash("sha256").update(text).digest("hex"), file).toBe(PINNED[file]);
    });
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(files.map((_, i) => i + 1));
  });
});
