import { ErrorCodes, JesutobitsError, type Project } from "@jesutobits/protocol";
import { describe, expect, it, vi } from "vitest";
import { MockHostBridge } from "../../host-bridge";
import { createProjectStore } from "../../state/project-store";
import { createEditorStore, EDITORS_KEY, SAVE_DELAY_MS } from "./editor-store";
import { MemoryBuffers } from "./text-buffers";

const A = "prj_01JAAAAAAAAAAAAAAAAAAAAAAA";
const B = "prj_01JBBBBBBBBBBBBBBBBBBBBBBB";
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
/** A stand-in for the runtime's SHA-256: any digest that differs when the text differs. */
const hash = (text: string) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return `${(h >>> 0).toString(16).padStart(8, "0")}${text.length.toString(16)}`.padEnd(64, "0");
};
const format = { bom: false, eol: "lf" as const };

/** A mock runtime with files in memory, enforcing expectedHash like WorkspaceService. */
function setup() {
  const bridge = new MockHostBridge();
  const disk = new Map<string, string>([
    ["a.ts", "export const a = 1;\n"],
    ["b.ts", "export const b = 2;\n"],
    ["c.ts", "export const c = 3;\n"],
  ]);
  const writes: Array<{ path: string; expectedHash: string | null }> = [];
  bridge.handle("projects.open", (params) => ({
    project: project("id" in params ? params.id : A),
    needsTrustDecision: false,
  }));
  bridge.handle("projects.detect", () => {
    throw new Error("not needed");
  });
  bridge.handle("fs.readFile", ({ path }) => {
    if (path === "big.bin")
      throw new JesutobitsError(ErrorCodes.fsTooLarge, "big.bin is too large");
    const text = disk.get(path);
    if (text === undefined)
      throw new JesutobitsError(ErrorCodes.fsNotFound, `${path} was not found`);
    return { path, text, hash: hash(text), size: text.length, format };
  });
  bridge.handle("fs.writeFile", ({ path, text, expectedHash }) => {
    writes.push({ path, expectedHash });
    const current = disk.get(path);
    const currentHash = current === undefined ? null : hash(current);
    if (expectedHash === null ? current !== undefined : currentHash !== expectedHash) {
      throw new JesutobitsError(ErrorCodes.fsConflict, `${path} changed on disk`);
    }
    disk.set(path, text);
    return { path, hash: hash(text), size: text.length, changeCounter: 1 };
  });
  const buffers = new MemoryBuffers();
  const projects = createProjectStore(bridge);
  const editor = createEditorStore(bridge, projects, buffers);
  return { bridge, disk, writes, buffers, projects, editor };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const changed = (path: string, kind: "upsert" | "removed" = "upsert") =>
  ({
    seq: 1,
    ts: "2026-10-21T10:00:00.000Z",
    type: "fs.changed",
    projectId: A,
    changes: [{ path, kind, isDirectory: false, self: false }],
    overflow: false,
    changeCounter: 1,
  }) as never;

async function opened() {
  const context = setup();
  await context.projects.getState().openRecent(A);
  await settle();
  return context;
}

describe("editor tabs", () => {
  it("opens a file through fs.readFile and makes it active", async () => {
    const { editor, buffers } = await opened();
    await editor.getState().open("a.ts");

    expect(editor.getState().active).toBe("a.ts");
    expect(editor.getState().files["a.ts"]).toMatchObject({ status: "ready", dirty: false });
    expect(buffers.snapshot("a.ts")?.text).toBe("export const a = 1;\n");
  });

  it("replaces the preview tab with the next preview, keeps pinned and dirty ones", async () => {
    const { editor, buffers } = await opened();
    await editor.getState().open("a.ts", { preview: true });
    await editor.getState().open("b.ts", { preview: true });
    expect(editor.getState().tabs).toEqual([{ path: "b.ts", preview: true }]);
    expect(buffers.snapshot("a.ts")).toBeUndefined();

    buffers.edit("b.ts", "changed");
    await editor.getState().open("c.ts", { preview: true });
    expect(editor.getState().tabs.map((tab) => tab.path)).toEqual(["b.ts", "c.ts"]);

    // Opening it for real pins it.
    await editor.getState().open("c.ts");
    expect(editor.getState().tabs.at(-1)).toEqual({ path: "c.ts", preview: false });
  });

  it("activates the neighbour when the active tab closes", async () => {
    const { editor } = await opened();
    await editor.getState().open("a.ts");
    await editor.getState().open("b.ts");
    await editor.getState().open("c.ts");
    editor.getState().activate("b.ts");
    editor.getState().close("b.ts");
    expect(editor.getState().active).toBe("c.ts");
    editor.getState().close("c.ts");
    expect(editor.getState().active).toBe("a.ts");
  });

  it("explains files it cannot show (fs.too_large)", async () => {
    const { editor } = await opened();
    await editor.getState().open("big.bin");
    expect(editor.getState().files["big.bin"]).toMatchObject({
      status: "failed",
      failure: { code: "fs.too_large", message: "big.bin is too large" },
    });
  });
});

describe("saving (FR-052)", () => {
  it("saves with the hash last read and is clean afterwards", async () => {
    const { editor, buffers, disk, writes } = await opened();
    await editor.getState().open("a.ts");
    buffers.edit("a.ts", "export const a = 10;\n");
    expect(editor.getState().files["a.ts"]?.dirty).toBe(true);

    expect(await editor.getState().save("a.ts")).toBe(true);
    expect(writes).toEqual([{ path: "a.ts", expectedHash: hash("export const a = 1;\n") }]);
    expect(disk.get("a.ts")).toBe("export const a = 10;\n");
    expect(editor.getState().files["a.ts"]).toMatchObject({
      dirty: false,
      hash: hash("export const a = 10;\n"),
    });
  });

  it("refuses to overwrite a file changed on disk and shows the conflict", async () => {
    const { editor, buffers, disk } = await opened();
    await editor.getState().open("a.ts");
    buffers.edit("a.ts", "mine\n");
    disk.set("a.ts", "theirs\n");

    expect(await editor.getState().save("a.ts")).toBe(false);
    expect(disk.get("a.ts")).toBe("theirs\n");
    expect(editor.getState().files["a.ts"]?.conflict).toEqual({
      kind: "changed",
      diskText: "theirs\n",
      diskHash: hash("theirs\n"),
    });
  });

  it("Keep mine saves over the version the user has seen", async () => {
    const { editor, buffers, disk } = await opened();
    await editor.getState().open("a.ts");
    buffers.edit("a.ts", "mine\n");
    disk.set("a.ts", "theirs\n");
    await editor.getState().save("a.ts");

    editor.getState().keepMine("a.ts");
    expect(await editor.getState().save("a.ts")).toBe(true);
    expect(disk.get("a.ts")).toBe("mine\n");
  });

  it("Take theirs replaces the text and leaves the tab clean", async () => {
    const { editor, buffers, disk } = await opened();
    await editor.getState().open("a.ts");
    buffers.edit("a.ts", "mine\n");
    disk.set("a.ts", "theirs\n");
    await editor.getState().save("a.ts");

    await editor.getState().takeTheirs("a.ts");
    expect(buffers.snapshot("a.ts")?.text).toBe("theirs\n");
    expect(editor.getState().files["a.ts"]).toMatchObject({ dirty: false, conflict: null });
  });

  it("saves every dirty tab", async () => {
    const { editor, buffers, disk } = await opened();
    await editor.getState().open("a.ts");
    await editor.getState().open("b.ts");
    buffers.edit("a.ts", "A\n");
    buffers.edit("b.ts", "B\n");
    expect(await editor.getState().saveAll()).toBe(true);
    expect([disk.get("a.ts"), disk.get("b.ts")]).toEqual(["A\n", "B\n"]);
  });
});

describe("changes on disk (UX_AND_INTERFACE.md section 5.2)", () => {
  it("updates a clean tab in place", async () => {
    const { bridge, editor, buffers, disk } = await opened();
    await editor.getState().open("a.ts");
    disk.set("a.ts", "export const a = 2;\n");
    bridge.emitEvent(changed("a.ts"));
    await vi.waitFor(() => expect(buffers.fromDisk).toEqual(["a.ts"]));
    expect(buffers.snapshot("a.ts")?.text).toBe("export const a = 2;\n");
    expect(editor.getState().files["a.ts"]?.conflict).toBeNull();
  });

  it("shows the bar on a tab with unsaved changes", async () => {
    const { bridge, editor, buffers, disk } = await opened();
    await editor.getState().open("a.ts");
    buffers.edit("a.ts", "mine\n");
    disk.set("a.ts", "theirs\n");
    bridge.emitEvent(changed("a.ts"));
    await vi.waitFor(() =>
      expect(editor.getState().files["a.ts"]?.conflict).toMatchObject({ kind: "changed" }),
    );
    expect(buffers.snapshot("a.ts")?.text).toBe("mine\n");
  });

  it("ignores its own save coming back as an event", async () => {
    const { bridge, editor, buffers } = await opened();
    await editor.getState().open("a.ts");
    buffers.edit("a.ts", "saved\n");
    await editor.getState().save("a.ts");
    bridge.emitEvent(changed("a.ts"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(buffers.fromDisk).toEqual([]);
    expect(editor.getState().files["a.ts"]?.conflict).toBeNull();
  });

  it("closes a clean tab whose file was deleted elsewhere", async () => {
    const { bridge, editor, disk } = await opened();
    await editor.getState().open("a.ts");
    await editor.getState().open("b.ts");
    disk.delete("a.ts");
    bridge.emitEvent(changed("a.ts", "removed"));
    await vi.waitFor(() => expect(editor.getState().tabs.map((tab) => tab.path)).toEqual(["b.ts"]));
  });

  it("keeps a tab whose file was deleted but saved again, as with atomic saves", async () => {
    const { bridge, editor } = await opened();
    await editor.getState().open("a.ts");
    // Reported removed, but the file is there when checked: nothing to do.
    bridge.emitEvent(changed("a.ts", "removed"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(editor.getState().files["a.ts"]).toMatchObject({ status: "ready", conflict: null });
  });

  it("flags a deleted file with unsaved changes; saving creates it again", async () => {
    const { bridge, editor, buffers, disk, writes } = await opened();
    await editor.getState().open("a.ts");
    buffers.edit("a.ts", "typed\n");
    disk.delete("a.ts");
    bridge.emitEvent(changed("a.ts", "removed"));
    await vi.waitFor(() =>
      expect(editor.getState().files["a.ts"]?.conflict).toEqual({ kind: "deleted" }),
    );

    buffers.edit("a.ts", "back\n");
    expect(await editor.getState().save("a.ts")).toBe(true);
    expect(writes.at(-1)).toEqual({ path: "a.ts", expectedHash: null });
    expect(disk.get("a.ts")).toBe("back\n");
  });

  it("handles a trashed folder at once: clean tabs under it close, changed ones stay", async () => {
    const { editor, buffers } = await opened();
    await editor.getState().open("a.ts");
    // Paths under a folder, as the explorer reports them.
    editor.setState((state) => ({
      tabs: [
        ...state.tabs,
        { path: "src/x.ts", preview: false },
        { path: "src/y.ts", preview: false },
      ],
    }));
    buffers.load("src/x.ts", "x");
    buffers.load("src/y.ts", "y");
    editor.setState((state) => ({
      files: {
        ...state.files,
        "src/x.ts": { ...state.files["a.ts"]!, dirty: false },
        "src/y.ts": { ...state.files["a.ts"]!, dirty: true },
      },
    }));

    editor.getState().removed("src");
    expect(editor.getState().tabs.map((tab) => tab.path)).toEqual(["a.ts", "src/y.ts"]);
    expect(editor.getState().files["src/y.ts"]?.conflict).toEqual({ kind: "deleted" });
  });

  it("checks every open tab against disk after a runtime restart", async () => {
    const { bridge, editor, buffers, disk } = await opened();
    await editor.getState().open("a.ts");
    await editor.getState().open("b.ts");
    disk.set("b.ts", "changed while the runtime was down\n");

    bridge.setStatus({ status: "restarting" });
    bridge.setStatus({ status: "ready" });
    await vi.waitFor(() => expect(buffers.fromDisk).toEqual(["b.ts"]));
  });
});

describe("recently shown files (quick open)", () => {
  it("lists them most recent first, without duplicates", async () => {
    const { editor } = await opened();
    await editor.getState().open("a.ts");
    await editor.getState().open("b.ts");
    await editor.getState().open("c.ts");
    editor.getState().activate("a.ts");
    await editor.getState().open("b.ts");
    expect(editor.getState().recent).toEqual(["b.ts", "a.ts", "c.ts"]);
  });
});

describe("open tabs per project (FR-008)", () => {
  it("are kept for each project and restored, without files deleted since", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { bridge, editor, projects, disk } = setup();
      await projects.getState().openRecent(A);
      await vi.advanceTimersByTimeAsync(0);
      await editor.getState().open("a.ts");
      await editor.getState().open("b.ts");
      editor.getState().setCursor("b.ts", { line: 3, column: 7 });
      editor.getState().activate("a.ts");
      await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
      const saved = (await bridge.uiState.get())[EDITORS_KEY] as Record<string, unknown>;
      expect(saved[A]).toEqual({
        tabs: [
          { path: "a.ts", preview: false },
          { path: "b.ts", preview: false },
        ],
        active: "a.ts",
        cursors: { "b.ts": { line: 3, column: 7 } },
        recent: ["a.ts", "b.ts"],
      });

      await projects.getState().openRecent(B);
      await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
      expect(editor.getState().tabs).toEqual([]);

      disk.delete("b.ts");
      await projects.getState().openRecent(A);
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() =>
        expect(editor.getState().tabs.map((tab) => tab.path)).toEqual(["a.ts"]),
      );
      expect(editor.getState().active).toBe("a.ts");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops restoring a project's tabs once another project opens", async () => {
    const { bridge, editor, projects, disk } = await opened();
    await editor.getState().open("a.ts");
    await editor.getState().open("b.ts");
    await projects.getState().openRecent(B);
    expect(editor.getState().tabs).toEqual([]);

    // A's first tab loads slowly, and the user opens B meanwhile.
    let release: () => void = () => undefined;
    bridge.handle("fs.readFile", async ({ path }) => {
      if (path === "a.ts") await new Promise<void>((resolve) => (release = resolve));
      const text = disk.get(path) ?? "";
      return { path, text, hash: hash(text), size: text.length, format };
    });
    await projects.getState().openRecent(A);
    await vi.waitFor(() => expect(editor.getState().tabs).toHaveLength(1));
    await projects.getState().openRecent(B);
    release();
    await settle();
    await settle();

    expect(editor.getState().tabs).toEqual([]);
  });
});
