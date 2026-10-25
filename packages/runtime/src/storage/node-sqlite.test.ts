import { afterEach, describe, expect, it } from "vitest";
import { NodeSqliteDatabase } from "./node-sqlite.js";

let db: NodeSqliteDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function memory(): NodeSqliteDatabase {
  db = new NodeSqliteDatabase(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  return db;
}

describe("NodeSqliteDatabase", () => {
  it("runs, gets and lists with positional and named parameters", () => {
    const db = memory();
    expect(db.run("INSERT INTO t (name) VALUES (?)", ["a"])).toEqual({
      changes: 1,
      lastInsertRowid: 1,
    });
    db.run("INSERT INTO t (name) VALUES (:name)", { name: "b" });
    expect(db.get("SELECT name FROM t WHERE id = ?", [2])).toEqual({ name: "b" });
    expect(db.get("SELECT name FROM t WHERE id = ?", [99])).toBeUndefined();
    expect(db.all("SELECT id, name FROM t ORDER BY id")).toEqual([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
  });

  it("commits a transaction that returns", () => {
    const db = memory();
    const result = db.transaction(() => {
      db.run("INSERT INTO t (name) VALUES ('a')");
      return "done";
    });
    expect(result).toBe("done");
    expect(db.all("SELECT name FROM t")).toEqual([{ name: "a" }]);
  });

  it("rolls back a transaction that throws, including nested work", () => {
    const db = memory();
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO t (name) VALUES ('a')");
        db.transaction(() => db.run("INSERT INTO t (name) VALUES ('b')"));
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(db.all("SELECT name FROM t")).toEqual([]);
    // Usable afterwards.
    db.transaction(() => db.run("INSERT INTO t (name) VALUES ('c')"));
    expect(db.all("SELECT name FROM t")).toEqual([{ name: "c" }]);
  });

  it("enforces foreign keys", () => {
    const db = memory();
    db.exec("CREATE TABLE child (t_id INTEGER NOT NULL REFERENCES t(id))");
    expect(() => db.run("INSERT INTO child VALUES (42)")).toThrow(/FOREIGN KEY/);
  });
});
