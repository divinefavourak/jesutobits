import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nullLogger } from "@jesutobits/shared";
import { WorkspaceService } from "@jesutobits/services";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Checkpoints } from "./checkpoints.js";
import { MemoryBlobStore, sha256 } from "../storage/blob-store.js";
import { openStorage, type Storage } from "../storage/storage.js";

let base: string;
let root: string;
let storage: Storage;
let ws: WorkspaceService;
let checkpoints: Checkpoints;
let blobs: MemoryBlobStore;

beforeEach(async () => {
  // Canonical, so CI runners' 8.3 temp paths (RUNNER~1) match what WorkspaceService resolves.
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "jesutobits-checkpoints-")));
  root = path.join(base, "project");
  mkdirSync(root);
  ws = await WorkspaceService.open({ root, log: nullLogger });
  storage = openStorage({ dir: undefined, log: nullLogger });
  // The checkpoints table demands a project row (and cannot check turn id formats).
  storage.db.run(
    "INSERT INTO projects (id, canonical_path, display_name, kind, trust) VALUES ('prj_1', ?, 'p', 'project', 'trusted')",
    [root],
  );
  blobs = new MemoryBlobStore();
  checkpoints = new Checkpoints(storage.db, blobs, () => new Date("2026-10-22T09:00:00.000Z"));
});

afterEach(() => {
  storage.close();
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const write = (relative: string, content: string | Buffer) => {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), content);
};
const bytes = (relative: string) => readFileSync(path.join(root, relative));

/** The turn's first change to a file: keep the pre-image, write, record how it was left. */
async function change(relative: string, text: string): Promise<void> {
  await checkpoints.before(ws, "prj_1", "trn_1", relative);
  await ws.writeText(relative, text);
  const snapshot = await ws.snapshot(relative);
  checkpoints.after("trn_1", relative, snapshot && { bytes: snapshot.bytes });
}

/** Registers a file the turn then deletes. */
async function deleteInTurn(relative: string): Promise<void> {
  await checkpoints.before(ws, "prj_1", "trn_1", relative);
  await ws.remove(relative);
  checkpoints.after("trn_1", relative, null);
}

describe("Checkpoints", () => {
  it("keeps the first pre-image of the turn and restores it byte for byte", async () => {
    const original = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("original\r\nwords\r\n", "utf8"),
    ]);
    write("notes.mkdn", original);

    await change("notes.mkdn", "first\r\nattempt\r\n");
    await change("notes.mkdn", "second\r\nattempt\r\n");

    const outcome = await checkpoints.revert(ws, "trn_1");
    expect(outcome).toEqual({ restored: ["notes.mkdn"], conflicts: [] });
    expect(bytes("notes.mkdn").equals(original)).toBe(true);
  });

  it("removes a file the turn created, and restores one the turn deleted", async () => {
    await change("new.md", "fresh\ncontent\n");
    write("old.txt", "precious\r\n");
    await deleteInTurn("old.txt");

    const outcome = await checkpoints.revert(ws, "trn_1");
    expect(outcome).toEqual({ restored: ["new.md", "old.txt"], conflicts: [] });
    expect(existsSync(path.join(root, "new.md"))).toBe(false);
    expect(bytes("old.txt").equals(Buffer.from("precious\r\n", "utf8"))).toBe(true);
  });

  it("reports created, modified and deleted files with line counts and freshness", async () => {
    await change("created.md", "one\ntwo\n");
    write("modified.md", "one\ntwo\n");
    await change("modified.md", "one\nTWO\n");
    write("deleted.txt", "a\nb\n");
    await deleteInTurn("deleted.txt");

    const listing = await checkpoints.list(ws, "trn_1");
    expect(listing).toEqual([
      { path: "created.md", change: "created", added: 2, removed: 0, unchangedSince: true },
      { path: "modified.md", change: "modified", added: 1, removed: 1, unchangedSince: true },
      { path: "deleted.txt", change: "deleted", added: 0, removed: 2, unchangedSince: true },
    ]);

    // A later edit from outside the checkpoints is no longer as the turn left it.
    await ws.writeText("modified.md", "edited\n");
    const after = await checkpoints.list(ws, "trn_1");
    expect(after.find((file) => file.path === "modified.md")?.unchangedSince).toBe(false);
    expect(after.find((file) => file.path === "created.md")?.unchangedSince).toBe(true);
    expect(after.find((file) => file.path === "deleted.txt")?.unchangedSince).toBe(true);
  });

  it("leaves a file that changed since the turn alone, then restores it with force", async () => {
    const original = Buffer.from("intact\n", "utf8");
    write("later.md", original);
    await change("later.md", "middle\n");
    await ws.writeText("later.md", "someone else edited\n");

    const refused = await checkpoints.revert(ws, "trn_1");
    expect(refused).toEqual({ restored: [], conflicts: ["later.md"] });
    expect(bytes("later.md").equals(Buffer.from("someone else edited\n", "utf8"))).toBe(true);

    const forced = await checkpoints.revert(ws, "trn_1", { force: ["later.md"] });
    expect(forced).toEqual({ restored: ["later.md"], conflicts: [] });
    expect(bytes("later.md").equals(original)).toBe(true);
  });

  it("restores only the requested paths", async () => {
    write("one.md", "one original\n");
    write("two.md", "two original\n");
    await change("one.md", "one changed\n");
    await change("two.md", "two changed\n");

    await expect(checkpoints.revert(ws, "trn_1", { paths: ["two.md"] })).resolves.toEqual({
      restored: ["two.md"],
      conflicts: [],
    });
    expect(bytes("two.md").toString()).toBe("two original\n");
    expect(bytes("one.md").toString()).toBe("one changed\n");
  });

  it("changes nothing when reverting twice", async () => {
    write("started.md", "before the turn\n");
    await change("started.md", "during the turn\n");
    await change("instant.md", "created in the turn\n");

    await expect(checkpoints.revert(ws, "trn_1")).resolves.toEqual({
      restored: ["started.md", "instant.md"],
      conflicts: [],
    });
    expect(bytes("started.md").toString()).toBe("before the turn\n");
    expect(existsSync(path.join(root, "instant.md"))).toBe(false);

    await expect(checkpoints.revert(ws, "trn_1")).resolves.toEqual({ restored: [], conflicts: [] });
    expect(bytes("started.md").toString()).toBe("before the turn\n");
    expect(existsSync(path.join(root, "instant.md"))).toBe(false);
  });

  it("lists the turn's changed files and skips files the turn only looked at", async () => {
    await checkpoints.before(ws, "prj_1", "trn_1", "touched.md");
    await change("created.md", "one\ntwo\n");
    write("edited.md", "old\n");
    await change("edited.md", "old\nnew\n");

    expect(checkpoints.changes("trn_1")).toEqual([
      { path: "created.md", change: "created", added: 2, removed: 0 },
      { path: "edited.md", change: "modified", added: 1, removed: 0 },
    ]);
  });

  it("sweeps blobs that no checkpoint refers to", async () => {
    await change("kept.md", "content\n");
    const row = storage.db.get<{ after_hash: string }>(
      "SELECT after_hash FROM checkpoints WHERE path = 'kept.md'",
    );
    const orphan = blobs.put(Buffer.from("orphaned bytes"));
    expect(blobs.get(orphan)).toEqual(Buffer.from("orphaned bytes"));

    expect(checkpoints.sweep()).toEqual(1);
    expect(blobs.get(orphan)).toBeUndefined();
    expect(blobs.get(row?.after_hash ?? sha256(Buffer.from("")))).toBeDefined();
  });
});
