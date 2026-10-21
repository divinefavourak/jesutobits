import { ErrorCodes, JesutobitsError, type DirEntry, type Project } from "@jesutobits/protocol";
import { describe, expect, it, vi } from "vitest";
import { MockHostBridge } from "../../host-bridge";
import { createProjectStore } from "../../state/project-store";
import { createExplorerStore, REFRESH_DELAY_MS } from "./explorer-store";

const project = (id: string): Project => ({
  id,
  path: "c:\\work\\habits",
  name: "habits",
  kind: "project",
  trust: "trusted",
  createdByJesutobits: false,
  lastOpenedAt: null,
  missing: false,
});
const A = "prj_01JAAAAAAAAAAAAAAAAAAAAAAA";
const B = "prj_01JBBBBBBBBBBBBBBBBBBBBBBB";

const entry = (path: string, kind: DirEntry["kind"] = "file"): DirEntry => ({
  name: path.split("/").at(-1)!,
  path,
  kind,
  link: false,
  outside: false,
  ignored: false,
});

/** A mock runtime with a small in-memory folder tree. */
function setup() {
  const bridge = new MockHostBridge();
  const tree: Record<string, DirEntry[]> = {
    "": [entry("src", "directory"), entry("README.md")],
    src: [entry("src/App.tsx")],
  };
  const listed: string[] = [];
  const calls: Array<{ method: string; params: unknown }> = [];
  bridge.handle("projects.open", (params) => ({
    project: project("id" in params ? params.id : A),
    needsTrustDecision: false,
  }));
  bridge.handle("projects.detect", () => {
    throw new Error("not needed");
  });
  bridge.handle("fs.listDir", ({ path }) => {
    listed.push(path);
    const entries = tree[path];
    if (!entries) throw new JesutobitsError(ErrorCodes.fsNotFound, `${path} was not found`);
    return { entries };
  });
  const record = (method: string) => (params: unknown) => {
    calls.push({ method, params });
    return {};
  };
  bridge.handle("fs.createDirectory", record("fs.createDirectory"));
  bridge.handle("fs.trash", record("fs.trash"));
  bridge.handle("fs.rename", (params) => {
    calls.push({ method: "fs.rename", params });
    if (params.to === "src/App.tsx") {
      throw new JesutobitsError(ErrorCodes.fsAlreadyExists, "src/App.tsx already exists");
    }
    return {};
  });
  bridge.handle("fs.createFile", ({ path }) => {
    calls.push({ method: "fs.createFile", params: { path } });
    return { path, hash: "0".repeat(64), size: 0, changeCounter: 1 };
  });
  const opened: string[] = [];
  const projects = createProjectStore(bridge);
  const explorer = createExplorerStore(bridge, projects, { open: (path) => opened.push(path) });
  return { bridge, tree, listed, calls, opened, projects, explorer };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const changed = (changes: Array<{ path: string; kind: "upsert" | "removed"; dir?: boolean }>) => ({
  seq: 1,
  ts: "2026-10-21T10:00:00.000Z",
  type: "fs.changed",
  projectId: A,
  changes: changes.map(({ path, kind, dir = false }) => ({
    path,
    kind,
    isDirectory: dir,
    self: false,
  })),
  overflow: false,
  changeCounter: 1,
});

describe("explorer store", () => {
  it("lists only the project folder on open, and a folder when it is first expanded", async () => {
    const { listed, projects, explorer } = setup();
    await projects.getState().openRecent(A);
    await settle();
    expect(listed).toEqual([""]);

    explorer.getState().expand("src");
    await settle();
    explorer.getState().collapse("src");
    explorer.getState().expand("src");
    await settle();
    expect(listed).toEqual(["", "src"]);
    expect(explorer.getState().dirs.src?.entries?.map((e) => e.name)).toEqual(["App.tsx"]);
  });

  it("lists changed folders again once a burst of fs.changed events settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { bridge, tree, listed, projects, explorer } = setup();
      await projects.getState().openRecent(A);
      explorer.getState().expand("src");
      await vi.advanceTimersByTimeAsync(0);
      listed.length = 0;

      tree.src = [entry("src/App.tsx"), entry("src/habit.ts")];
      bridge.emitEvent(changed([{ path: "src/habit.ts", kind: "upsert" }]) as never);
      bridge.emitEvent(changed([{ path: "src/App.tsx", kind: "upsert" }]) as never);
      // A change in a folder that is not shown lists nothing.
      bridge.emitEvent(changed([{ path: "docs/a.md", kind: "upsert" }]) as never);
      await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS);

      expect(listed).toEqual(["src"]);
      expect(explorer.getState().dirs.src?.entries?.map((e) => e.name)).toEqual([
        "App.tsx",
        "habit.ts",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets a removed folder and what was expanded under it", async () => {
    const { bridge, tree, projects, explorer } = setup();
    await projects.getState().openRecent(A);
    explorer.getState().expand("src");
    await settle();

    delete tree.src;
    tree[""] = [entry("README.md")];
    bridge.emitEvent(changed([{ path: "src", kind: "removed", dir: true }]) as never);
    expect(explorer.getState().dirs.src).toBeUndefined();
    expect(explorer.getState().expanded.src).toBeUndefined();
  });

  it("creates a file, selects it and opens it in the editor", async () => {
    const { calls, opened, projects, explorer } = setup();
    await projects.getState().openRecent(A);
    await settle();
    explorer.getState().startEdit({ kind: "newFile", parent: "src" });
    expect(explorer.getState().expanded.src).toBe(true);
    await explorer.getState().commitEdit("  habit.ts ");

    expect(calls).toEqual([{ method: "fs.createFile", params: { path: "src/habit.ts" } }]);
    expect(explorer.getState()).toMatchObject({ editing: null, selected: "src/habit.ts" });
    expect(opened).toEqual(["src/habit.ts"]);
  });

  it("refuses a new folder whose name is taken, without asking the runtime", async () => {
    const { calls, projects, explorer } = setup();
    await projects.getState().openRecent(A);
    await settle();
    explorer.getState().startEdit({ kind: "newFolder", parent: "" });
    await explorer.getState().commitEdit("src");

    expect(calls).toEqual([]);
    expect(explorer.getState().error).toBe("src already exists here.");
    expect(explorer.getState().editing).toEqual({ kind: "newFolder", parent: "" });
  });

  it("keeps the rename field open when the runtime refuses the name", async () => {
    const { projects, explorer } = setup();
    await projects.getState().openRecent(A);
    explorer.getState().expand("src");
    await settle();
    explorer.getState().startEdit({ kind: "rename", path: "src/habit.ts" });
    await explorer.getState().commitEdit("App.tsx");

    expect(explorer.getState().error).toBe("src/App.tsx already exists");
    expect(explorer.getState().editing).toEqual({ kind: "rename", path: "src/habit.ts" });
  });

  it("closes the rename field without a call when the name is unchanged", async () => {
    const { calls, projects, explorer } = setup();
    await projects.getState().openRecent(A);
    await settle();
    explorer.getState().startEdit({ kind: "rename", path: "README.md" });
    await explorer.getState().commitEdit("README.md");

    expect(calls).toEqual([]);
    expect(explorer.getState().editing).toBeNull();
  });

  it("moves a file to the trash and forgets the selection", async () => {
    const { calls, projects, explorer } = setup();
    await projects.getState().openRecent(A);
    await settle();
    explorer.getState().select("README.md");
    await explorer.getState().trash("README.md");

    expect(calls).toEqual([{ method: "fs.trash", params: { path: "README.md" } }]);
    expect(explorer.getState().selected).toBeNull();
  });

  it("keeps expanded folders and lists them again after a runtime restart", async () => {
    const { bridge, listed, projects, explorer } = setup();
    await projects.getState().openRecent(A);
    explorer.getState().expand("src");
    await settle();
    listed.length = 0;

    bridge.setStatus({ status: "restarting" });
    bridge.setStatus({ status: "ready" });
    await settle();
    await settle();

    expect(explorer.getState().expanded.src).toBe(true);
    expect(listed.toSorted()).toEqual(["", "src"]);
  });

  it("starts empty for another project", async () => {
    const { projects, explorer } = setup();
    await projects.getState().openRecent(A);
    explorer.getState().expand("src");
    explorer.getState().select("README.md");
    await settle();

    await projects.getState().openRecent(B);
    expect(explorer.getState()).toMatchObject({ expanded: {}, selected: null });
  });
});
