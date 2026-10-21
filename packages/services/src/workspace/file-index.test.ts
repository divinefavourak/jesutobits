import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nullLogger } from "@jesutobits/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileIndex } from "./file-index.js";
import { WorkspaceService } from "./workspace-service.js";

let base: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "jesutobits-index-")));
  root = path.join(base, "project");
  mkdirSync(root);
});

afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

const touch = (relative: string) => {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), "");
};

async function build(options = {}) {
  const ws = await WorkspaceService.open({ root, log: nullLogger });
  const index = FileIndex.build(ws, nullLogger, options);
  await index.ready;
  return { ws, index };
}

describe("FileIndex", () => {
  it("indexes files, skipping ignored folders, ignored files and links", async () => {
    touch("src/App.tsx");
    touch("src/components/Button.tsx");
    touch("node_modules/react/index.js");
    touch("debug.log");
    touch(".gitignore");
    writeFileSync(path.join(root, ".gitignore"), "*.log\n");
    mkdirSync(path.join(base, "outside"));
    writeFileSync(path.join(base, "outside", "secret.txt"), "");
    symlinkSync(path.join(base, "outside"), path.join(root, "link"), "junction");

    const { index } = await build();
    expect([...index.query("", 100)].map((r) => r.path).sort()).toEqual([
      ".gitignore",
      "src/App.tsx",
      "src/components/Button.tsx",
    ]);
    expect(index.complete).toBe(true);
  });

  it("finds files fuzzily", async () => {
    touch("src/components/Button.tsx");
    touch("src/components/ButtonGroup.tsx");
    touch("src/lib/format.ts");
    const { index } = await build();
    expect(index.query("button", 10)[0]?.path).toBe("src/components/Button.tsx");
    expect(index.query("fmt", 10).map((r) => r.path)).toEqual(["src/lib/format.ts"]);
  });

  it("lists recent files first for an empty query and boosts them otherwise", async () => {
    touch("a.ts");
    touch("b.ts");
    touch("c.ts");
    const { index } = await build();
    expect(index.query("", 2, ["c.ts", "missing.ts"]).map((r) => r.path)).toEqual(["c.ts", "a.ts"]);
    expect(index.query("ts", 1, ["b.ts"])[0]?.path).toBe("b.ts");
  });

  it("applies watcher batches", async () => {
    touch("src/a.ts");
    touch("old/x.ts");
    touch("old/deep/y.ts");
    const { index } = await build();

    touch("src/b.ts");
    touch("added/z.ts");
    await index.apply({
      changes: [
        { path: "src/b.ts", kind: "upsert", isDirectory: false, self: false },
        { path: "added", kind: "upsert", isDirectory: true, self: false },
        { path: "old", kind: "removed", isDirectory: false, self: false },
      ],
      overflow: false,
      changeCounter: 1,
    });
    expect(
      index
        .query("", 100)
        .map((r) => r.path)
        .sort(),
    ).toEqual(["added/z.ts", "src/a.ts", "src/b.ts"]);
  });

  it("rebuilds after an overflow", async () => {
    touch("a.ts");
    const { index } = await build();
    touch("b.ts");
    await index.apply({ changes: [], overflow: true, changeCounter: 1 });
    expect(index.size).toBe(2);
  });

  it("stops at the file limit and says so", async () => {
    for (let n = 0; n < 10; n++) touch(`f${n}.ts`);
    const { index } = await build({ maxFiles: 4 });
    expect(index.size).toBe(4);
    expect(index.complete).toBe(false);
  });
});
