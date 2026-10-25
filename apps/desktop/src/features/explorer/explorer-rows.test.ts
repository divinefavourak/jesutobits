import type { DirEntry } from "@jesutobits/protocol";
import { describe, expect, it } from "vitest";
import { visibleRows } from "./explorer-rows";
import type { DirListing } from "./explorer-store";

const entry = (path: string, kind: DirEntry["kind"] = "file"): DirEntry => ({
  name: path.split("/").at(-1)!,
  path,
  kind,
  link: false,
  outside: false,
  ignored: false,
});
const listed = (...entries: DirEntry[]): DirListing => ({ entries, loading: false, error: null });

const dirs = {
  "": listed(entry("src", "directory"), entry("README.md")),
  src: listed(entry("src/lib", "directory"), entry("src/App.tsx")),
  "src/lib": listed(entry("src/lib/date.ts")),
};

const names = (rows: ReturnType<typeof visibleRows>) =>
  rows.map((row) =>
    row.type === "entry" ? `${row.level}:${row.entry.name}` : `${row.level}:${row.type}`,
  );

describe("visibleRows", () => {
  it("shows only expanded folders' entries, depth first, with tree positions", () => {
    expect(names(visibleRows({ dirs, expanded: {}, editing: null }))).toEqual([
      "1:src",
      "1:README.md",
    ]);
    const rows = visibleRows({ dirs, expanded: { src: true }, editing: null });
    expect(names(rows)).toEqual(["1:src", "2:lib", "2:App.tsx", "1:README.md"]);
    expect(rows[1]).toMatchObject({ setSize: 2, posInSet: 1, expanded: false });
    expect(rows[0]).toMatchObject({ expanded: true });
  });

  it("keeps a collapsed folder's listing out even when its parent is open", () => {
    const rows = visibleRows({ dirs, expanded: { "src/lib": true }, editing: null });
    expect(names(rows)).toEqual(["1:src", "1:README.md"]);
  });

  it("shows loading and failed folders as status rows", () => {
    const rows = visibleRows({
      dirs: {
        "": listed(entry("a", "directory"), entry("b", "directory")),
        a: { entries: null, loading: true, error: null },
        b: { entries: null, loading: false, error: "Access is denied" },
      },
      expanded: { a: true, b: true },
      editing: null,
    });
    expect(rows.map((row) => (row.type === "status" ? row.status : row.type))).toEqual([
      "entry",
      "loading",
      "entry",
      "error",
    ]);
  });

  it("puts the new-file field first in its folder and marks the row being renamed", () => {
    const creating = visibleRows({
      dirs,
      expanded: { src: true },
      editing: { kind: "newFile", parent: "src" },
    });
    expect(names(creating)).toEqual(["1:src", "2:create", "2:lib", "2:App.tsx", "1:README.md"]);
    const renaming = visibleRows({
      dirs,
      expanded: {},
      editing: { kind: "rename", path: "README.md" },
    });
    expect(renaming[1]).toMatchObject({ type: "entry", renaming: true });
  });
});
