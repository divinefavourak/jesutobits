import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nullLogger } from "@jesutobits/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeBatch, RawWatch, WatchHandle } from "./file-watcher.js";
import { WorkspaceService } from "./workspace-service.js";

let root: string;
let handle: WatchHandle | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "jesutobits-watch-")));
  mkdirSync(path.join(root, "src"));
});

afterEach(() => {
  handle?.close();
  handle = undefined;
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A watcher whose OS events the test sends itself. */
function fakeWatch() {
  let send: (name: string | null) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const raw: RawWatch = (_root, onPath, onError) => {
    send = onPath;
    fail = onError;
    return { close: () => undefined };
  };
  return { raw, emit: (name: string | null) => send(name), fail: (e: unknown) => fail(e) };
}

async function setup(options: { maxChanges?: number } = {}) {
  const ws = await WorkspaceService.open({ root, log: nullLogger });
  const batches: ChangeBatch[] = [];
  const fake = fakeWatch();
  const errors: unknown[] = [];
  handle = ws.watch((batch) => batches.push(batch), {
    rawWatch: fake.raw,
    intervalMs: 20,
    onError: (error) => errors.push(error),
    ...options,
  });
  const next = async (count = 1) => {
    await vi.waitFor(() => expect(batches.length).toBeGreaterThanOrEqual(count));
    return batches[count - 1] as ChangeBatch;
  };
  return { ws, batches, next, errors, ...fake };
}

const touch = (relative: string, content = "x") => {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), content);
};

describe("WorkspaceService.watch", () => {
  it("batches events in one window and reports each path once", async () => {
    const { emit, next, batches } = await setup();
    touch("src/a.ts");
    emit("src\\a.ts");
    emit("src/a.ts");
    emit("src");
    const batch = await next();
    expect(batch.changes).toEqual([
      { path: "src/a.ts", kind: "upsert", isDirectory: false, self: false },
      { path: "src", kind: "upsert", isDirectory: true, self: false },
    ]);
    expect(batch.overflow).toBe(false);
    expect(batches).toHaveLength(1);
  });

  it("reports removed paths and advances the change counter once per batch", async () => {
    const { ws, emit, next } = await setup();
    emit("gone.ts");
    emit("also-gone.ts");
    const batch = await next();
    expect(batch.changes.map((c) => [c.path, c.kind])).toEqual([
      ["gone.ts", "removed"],
      ["also-gone.ts", "removed"],
    ]);
    expect(batch.changeCounter).toBe(1);
    expect(ws.changeCounter).toBe(1);
  });

  it("marks its own writes and does not count them twice", async () => {
    const { ws, emit, next } = await setup();
    await ws.writeText("src/mine.ts", "export {};");
    expect(ws.changeCounter).toBe(1);
    emit("src/mine.ts");
    const batch = await next();
    expect(batch.changes).toEqual([
      { path: "src/mine.ts", kind: "upsert", isDirectory: false, self: true },
    ]);
    expect(batch.changeCounter).toBe(1);
  });

  it("notices a change made elsewhere after its own write", async () => {
    const { ws, emit, next } = await setup();
    await ws.writeText("src/a.ts", "mine");
    touch("src/a.ts", "theirs, longer");
    emit("src/a.ts");
    expect((await next()).changes[0]?.self).toBe(false);
  });

  it("marks its own renames on both ends", async () => {
    const { ws, emit, next } = await setup();
    touch("a.ts");
    await ws.rename("a.ts", "b.ts");
    emit("a.ts");
    emit("b.ts");
    expect((await next()).changes.map((c) => [c.path, c.kind, c.self])).toEqual([
      ["a.ts", "removed", true],
      ["b.ts", "upsert", true],
    ]);
  });

  it("never reports its own temporary files", async () => {
    const { emit, next } = await setup();
    emit("src/.a.ts.0123456789ab.tmp");
    emit("src/real.ts");
    expect((await next()).changes.map((c) => c.path)).toEqual(["src/real.ts"]);
  });

  it("hides .git and node_modules churn but still counts it", async () => {
    const { ws, emit, batches } = await setup();
    emit(".git/index");
    emit("node_modules/react/index.js");
    emit("packages/web/node_modules/x/y.js");
    await vi.waitFor(() => expect(ws.changeCounter).toBe(1));
    expect(batches).toEqual([]);
  });

  it("turns too many changes into one overflow batch", async () => {
    const { emit, next } = await setup({ maxChanges: 3 });
    for (let n = 0; n < 10; n++) emit(`f${n}.ts`);
    expect(await next()).toEqual({ changes: [], overflow: true, changeCounter: 1 });
  });

  it("reports an unknown change (no file name) as overflow", async () => {
    const { emit, next } = await setup();
    emit(null);
    expect((await next()).overflow).toBe(true);
  });

  it("reloads ignore rules when a .gitignore changes", async () => {
    const { ws, emit, next } = await setup();
    touch("debug.log");
    expect((await ws.listDir("")).find((e) => e.name === "debug.log")?.ignored).toBe(false);
    touch(".gitignore", "*.log\n");
    emit(".gitignore");
    await next();
    expect((await ws.listDir("")).find((e) => e.name === "debug.log")?.ignored).toBe(true);
  });

  it("passes watcher errors on", async () => {
    const { fail, errors } = await setup();
    fail(new Error("root deleted"));
    expect(errors).toHaveLength(1);
  });

  it("delivers nothing after close", async () => {
    const { emit, batches } = await setup();
    emit("src/a.ts");
    handle?.close();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(batches).toEqual([]);
  });
});

describe("WorkspaceService.watch with the OS watcher", () => {
  it("reports a file created by another program", async () => {
    const ws = await WorkspaceService.open({ root, log: nullLogger });
    const batches: ChangeBatch[] = [];
    handle = ws.watch((batch) => batches.push(batch));
    // Give the OS watch a moment to start.
    await new Promise((resolve) => setTimeout(resolve, 100));
    touch("src/external.ts", "export const x = 1;");
    await vi.waitFor(
      () =>
        expect(batches.flatMap((b) => b.changes)).toContainEqual(
          expect.objectContaining({ path: "src/external.ts", kind: "upsert", self: false }),
        ),
      { timeout: 5000 },
    );
  });
});
