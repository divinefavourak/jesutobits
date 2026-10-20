import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MethodResult } from "@jesutobits/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeHarness, type RpcReply } from "./harness/runtime-harness.js";

let base: string;
let dataDir: string;
let projectDir: string;
let harness: RuntimeHarness | undefined;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "jesutobits-projects-")));
  dataDir = path.join(base, "data");
  projectDir = path.join(base, "my-app");
  mkdirSync(path.join(projectDir, "src"), { recursive: true });
  writeFileSync(path.join(projectDir, "src", "App.tsx"), "export const App = () => null;\r\n");
  writeFileSync(path.join(projectDir, "package.json"), '{ "name": "my-app" }\n');
});

afterEach(async () => {
  harness?.kill();
  await harness?.exited;
  harness = undefined;
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function start(): Promise<RuntimeHarness> {
  harness = RuntimeHarness.start({ dataDir });
  await harness.initialize();
  return harness;
}

function result<M extends Parameters<RuntimeHarness["call"]>[0]>(reply: RpcReply): MethodResult<M> {
  if (reply.error) throw new Error(`${reply.error.data?.code ?? ""}: ${reply.error.message}`);
  return reply.result as MethodResult<M>;
}

/** Every file's path, size and content hash: proves a folder was not written to. */
function fingerprint(dir: string): string[] {
  const out: string[] = [];
  const walk = (folder: string) => {
    for (const name of readdirSync(folder).sort()) {
      const full = path.join(folder, name);
      if (statSync(full).isDirectory()) walk(full);
      else
        out.push(
          `${path.relative(dir, full)} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`,
        );
    }
  };
  walk(dir);
  return out;
}

describe("projects.*", () => {
  it("opens a folder without writing anything into it (J-05)", async () => {
    const before = fingerprint(projectDir);
    const h = await start();
    const opened = result<"projects.open">(await h.call("projects.open", { path: projectDir }));
    expect(opened.needsTrustDecision).toBe(true);
    expect(opened.project).toMatchObject({
      name: "my-app",
      kind: "project",
      trust: "unknown",
      createdByJesutobits: false,
      missing: false,
    });
    expect(opened.project.id).toMatch(/^prj_/);
    // Let the watcher and index start, then make sure nothing was written.
    await h.call("fs.quickOpen", { query: "" });
    expect(fingerprint(projectDir)).toEqual(before);
  });

  it("identifies a project by its canonical path (FR-009)", async () => {
    const h = await start();
    const a = result<"projects.open">(await h.call("projects.open", { path: projectDir }));
    const b = result<"projects.open">(
      await h.call("projects.open", { path: path.join(projectDir, "src", "..") }),
    );
    expect(b.project.id).toBe(a.project.id);
    expect(result<"projects.list">(await h.call("projects.list", {})).projects).toHaveLength(1);
  });

  it("remembers projects and trust across restarts", async () => {
    let h = await start();
    const { project } = result<"projects.open">(
      await h.call("projects.open", { path: projectDir }),
    );
    result<"projects.setTrust">(
      await h.call("projects.setTrust", { id: project.id, trust: "trusted" }),
    );
    await h.call("runtime.shutdown", {});
    await h.exited;

    h = await start();
    const { projects } = result<"projects.list">(await h.call("projects.list", {}));
    expect(projects).toMatchObject([{ id: project.id, trust: "trusted" }]);
    const reopened = result<"projects.open">(await h.call("projects.open", { id: project.id }));
    expect(reopened.needsTrustDecision).toBe(false);
    expect(reopened.project.lastOpenedAt).not.toBeNull();
  });

  it("marks a moved folder missing, and Locate points the project at its new place", async () => {
    const h = await start();
    const { project } = result<"projects.open">(
      await h.call("projects.open", { path: projectDir }),
    );
    await h.call("projects.close", {});
    const moved = path.join(base, "moved-app");
    renameSync(projectDir, moved);

    expect(result<"projects.list">(await h.call("projects.list", {})).projects[0]?.missing).toBe(
      true,
    );
    expect((await h.call("projects.open", { id: project.id })).error?.data?.code).toBe(
      "fs.not_found",
    );
    const located = result<"projects.locate">(
      await h.call("projects.locate", { id: project.id, path: moved }),
    );
    expect(located.project).toMatchObject({ id: project.id, name: "moved-app", missing: false });
  });

  it("removes a project from the list without touching the folder", async () => {
    const before = fingerprint(projectDir);
    const h = await start();
    const { project } = result<"projects.open">(
      await h.call("projects.open", { path: projectDir }),
    );
    result<"projects.remove">(await h.call("projects.remove", { id: project.id }));
    expect(result<"projects.list">(await h.call("projects.list", {})).projects).toEqual([]);
    expect((await h.call("fs.listDir", { path: "" })).error?.data?.code).toBe("fs.no_project");
    expect(fingerprint(projectDir)).toEqual(before);
  });

  it("creates trusted Empty and General projects in the parent folder", async () => {
    const h = await start();
    const workspace = path.join(base, "Jesutobits Projects");
    const empty = result<"projects.create">(
      await h.call("projects.create", { parentDir: workspace, name: "habits", template: "empty" }),
    );
    expect(empty.project).toMatchObject({
      name: "habits",
      kind: "project",
      trust: "trusted",
      createdByJesutobits: true,
    });
    expect(readdirSync(path.join(workspace, "habits"))).toEqual([]);

    const general = result<"projects.create">(
      await h.call("projects.create", { parentDir: workspace, name: "notes", template: "general" }),
    );
    expect(general.project.kind).toBe("general");

    writeFileSync(path.join(workspace, "notes", "x.md"), "x");
    expect(
      (await h.call("projects.create", { parentDir: workspace, name: "notes", template: "empty" }))
        .error?.data?.code,
    ).toBe("fs.already_exists");
  });

  it("refuses folder names Windows cannot store", async () => {
    const h = await start();
    const reply = await h.call("projects.create", {
      parentDir: base,
      name: "a:b",
      template: "empty",
    });
    expect(reply.error?.data?.code).toBe("rpc.invalid_params");
  });
});

describe("fs.*", () => {
  async function opened(): Promise<RuntimeHarness> {
    const h = await start();
    result<"projects.open">(await h.call("projects.open", { path: projectDir }));
    return h;
  }

  it("needs an open project", async () => {
    const h = await start();
    expect((await h.call("fs.readFile", { path: "src/App.tsx" })).error?.data?.code).toBe(
      "fs.no_project",
    );
  });

  it("lists, reads and saves with conflict detection (FR-052)", async () => {
    const h = await opened();
    expect(
      result<"fs.listDir">(await h.call("fs.listDir", { path: "" })).entries.map((e) => e.name),
    ).toEqual(["src", "package.json"]);

    const file = result<"fs.readFile">(await h.call("fs.readFile", { path: "src/App.tsx" }));
    expect(file.format).toEqual({ bom: false, eol: "crlf" });

    const saved = result<"fs.writeFile">(
      await h.call("fs.writeFile", {
        path: "src/App.tsx",
        text: "export const App = () => 1;\n",
        expectedHash: file.hash,
      }),
    );
    // Line endings kept (CRLF), written atomically through WorkspaceService.
    expect(readFileSync(path.join(projectDir, "src", "App.tsx"), "utf8")).toBe(
      "export const App = () => 1;\r\n",
    );

    const stale = await h.call("fs.writeFile", {
      path: "src/App.tsx",
      text: "x",
      expectedHash: file.hash,
    });
    expect(stale.error?.data).toMatchObject({
      code: "fs.conflict",
      details: { currentHash: saved.hash },
    });
  });

  it("creates, renames and refuses to leave the project", async () => {
    const h = await opened();
    result<"fs.createDirectory">(await h.call("fs.createDirectory", { path: "src/lib" }));
    result<"fs.createFile">(await h.call("fs.createFile", { path: "src/lib/util.ts" }));
    result<"fs.rename">(await h.call("fs.rename", { from: "src/lib/util.ts", to: "src/util.ts" }));
    expect(readFileSync(path.join(projectDir, "src", "util.ts"), "utf8")).toBe("");
    expect((await h.call("fs.readFile", { path: "../data/jesutobits.db" })).error?.data?.code).toBe(
      "fs.outside_workspace",
    );
  });

  it("refuses files too large for one message", async () => {
    writeFileSync(path.join(projectDir, "big.txt"), "x".repeat(3 * 1024 * 1024));
    const h = await opened();
    expect((await h.call("fs.readFile", { path: "big.txt" })).error?.data?.code).toBe(
      "fs.too_large",
    );
  });

  it("finds files with quick open", async () => {
    const h = await opened();
    await vi.waitFor(async () => {
      const found = result<"fs.quickOpen">(await h.call("fs.quickOpen", { query: "app" }));
      expect(found.indexing).toBe(false);
      expect(found.results[0]?.path).toBe("src/App.tsx");
    });
  });

  it("sends fs.changed when another program changes a file, and marks its own saves", async () => {
    const h = await opened();
    await new Promise((resolve) => setTimeout(resolve, 200)); // let the OS watch start
    writeFileSync(path.join(projectDir, "src", "external.ts"), "export {};\n");
    await vi.waitFor(
      () =>
        expect(h.events).toContainEqual(
          expect.objectContaining({
            type: "fs.changed",
            changes: expect.arrayContaining([
              { path: "src/external.ts", kind: "upsert", isDirectory: false, self: false },
            ]) as unknown,
          }),
        ),
      { timeout: 5000 },
    );
    const project = h.events.find((e) => e.type === "fs.changed")?.projectId;
    expect(project).toMatch(/^prj_/);

    const file = result<"fs.readFile">(await h.call("fs.readFile", { path: "package.json" }));
    await h.call("fs.writeFile", { path: "package.json", text: "{}\n", expectedHash: file.hash });
    await vi.waitFor(
      () =>
        expect(h.events).toContainEqual(
          expect.objectContaining({
            type: "fs.changed",
            changes: expect.arrayContaining([
              expect.objectContaining({ path: "package.json", self: true }),
            ]) as unknown,
          }),
        ),
      { timeout: 5000 },
    );
  });
});
