// A machine under load: `stat` of one file takes 150 ms, so the watcher's batch can close
// before the service has recorded that it wrote the file itself. Kept in its own file
// because the module mock applies to the whole file.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nullLogger } from "@jesutobits/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeBatch, WatchHandle } from "./file-watcher.js";
import { WorkspaceService } from "./workspace-service.js";

const SLOW = "racy.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>();
  return {
    ...original,
    stat: async (target: Parameters<typeof original.stat>[0]) => {
      if (String(target).endsWith(SLOW)) await new Promise((resolve) => setTimeout(resolve, 150));
      return original.stat(target);
    },
  };
});

let root: string;
let handle: WatchHandle | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "jesutobits-race-")));
  mkdirSync(path.join(root, "src"));
});

afterEach(() => {
  handle?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("WorkspaceService.watch under load", () => {
  it("waits for its own write to be marked before judging the path", async () => {
    const ws = await WorkspaceService.open({ root, log: nullLogger });
    const batches: ChangeBatch[] = [];
    let send: (name: string) => void = () => undefined;
    handle = ws.watch((batch) => batches.push(batch), {
      intervalMs: 10,
      rawWatch: (_root, onPath) => {
        send = onPath;
        return { close: () => undefined };
      },
    });

    // The new file has no previous content, so the write starts at once; the OS event
    // arrives right after the rename, while the mark's slow stat is still running.
    const writing = ws.writeText(`src/${SLOW}`, "export {};", { expectedHash: null });
    // Generous waits: the slowed stat runs alongside the whole parallel suite.
    await vi.waitFor(() => expect(existsSync(path.join(root, "src", SLOW))).toBe(true), {
      timeout: 10_000,
      interval: 5,
    });
    send(`src/${SLOW}`);
    await writing;

    await vi.waitFor(() => expect(batches.length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(batches[0]?.changes).toEqual([
      { path: `src/${SLOW}`, kind: "upsert", isDirectory: false, self: true },
    ]);
  });
});
