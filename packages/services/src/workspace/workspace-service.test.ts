import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nullLogger } from "@jesutobits/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalProjectPath } from "./canonical-path.js";
import { hashBytes, WorkspaceService } from "./workspace-service.js";

let base: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "jesutobits-ws-")));
  root = path.join(base, "project");
  mkdirSync(path.join(root, "src"), { recursive: true });
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const open = () => WorkspaceService.open({ root, log: nullLogger });
const write = (relative: string, content: string | Buffer) => {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), content);
};
const bytes = (relative: string) => readFileSync(path.join(root, relative));

describe("WorkspaceService.readText", () => {
  it("returns text, hash, size and format", async () => {
    write("src/a.ts", "a\r\nb\r\n");
    const ws = await open();
    expect(await ws.readText("src/a.ts")).toEqual({
      path: "src/a.ts",
      text: "a\r\nb\r\n",
      hash: hashBytes(Buffer.from("a\r\nb\r\n")),
      size: 6,
      format: { bom: false, eol: "crlf" },
    });
  });

  it("refuses binary files, folders, missing files and files over the limit", async () => {
    write("logo.png", Buffer.from([0x89, 0x50, 0x00, 0x01]));
    write("big.txt", "x".repeat(100));
    const ws = await open();
    await expect(ws.readText("logo.png")).rejects.toMatchObject({ code: "fs.binary" });
    await expect(ws.readText("src")).rejects.toMatchObject({ code: "fs.not_a_file" });
    await expect(ws.readText("missing.ts")).rejects.toMatchObject({
      code: "fs.not_found",
      message: "missing.ts does not exist",
    });
    await expect(ws.readText("big.txt", 50)).rejects.toMatchObject({ code: "fs.too_large" });
  });

  it("never reveals the absolute path in errors", async () => {
    const ws = await open();
    const error = await ws.readText("nope/missing.ts").catch((e: unknown) => e);
    expect(JSON.stringify(error)).not.toContain(base);
  });
});

describe("WorkspaceService.writeText", () => {
  it("creates files and missing folders, and bumps the change counter", async () => {
    const ws = await open();
    const result = await ws.writeText("src/new/deep.ts", "export {};\n", { expectedHash: null });
    expect(result).toMatchObject({ path: "src/new/deep.ts", changeCounter: 1, size: 11 });
    expect(bytes("src/new/deep.ts").toString()).toBe("export {};\n");
    expect(ws.changeCounter).toBe(1);
  });

  it("keeps a CRLF file's line endings and BOM byte for byte", async () => {
    write("src/a.ts", Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("a\r\nb\r\n")]));
    const ws = await open();
    await ws.writeText("src/a.ts", "a\nb\nc\n");
    expect([...bytes("src/a.ts")]).toEqual([0xef, 0xbb, 0xbf, ...Buffer.from("a\r\nb\r\nc\r\n")]);
  });

  it("refuses a write when the file changed since it was read (FR-052)", async () => {
    write("src/a.ts", "one");
    const ws = await open();
    const read = await ws.readText("src/a.ts");
    write("src/a.ts", "changed elsewhere");

    const error = await ws
      .writeText("src/a.ts", "mine", { expectedHash: read.hash })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "fs.conflict",
      retryable: true,
      details: {
        expectedHash: read.hash,
        currentHash: hashBytes(Buffer.from("changed elsewhere")),
      },
    });
    expect(bytes("src/a.ts").toString()).toBe("changed elsewhere");
  });

  it("writes when the hash still matches", async () => {
    write("src/a.ts", "one");
    const ws = await open();
    const read = await ws.readText("src/a.ts");
    const result = await ws.writeText("src/a.ts", "two", { expectedHash: read.hash });
    expect(result.hash).toBe(hashBytes(Buffer.from("two")));
  });

  it("refuses to create a file that exists, and to overwrite a binary file", async () => {
    write("src/a.ts", "x");
    write("img.bin", Buffer.from([0, 1, 2]));
    const ws = await open();
    await expect(ws.writeText("src/a.ts", "y", { expectedHash: null })).rejects.toMatchObject({
      code: "fs.already_exists",
    });
    await expect(ws.writeText("img.bin", "text")).rejects.toMatchObject({ code: "fs.binary" });
  });

  it("leaves no temporary files behind", async () => {
    const ws = await open();
    for (let n = 0; n < 5; n++) await ws.writeText("src/a.ts", `v${n}`);
    expect(readdirSync(path.join(root, "src"))).toEqual(["a.ts"]);
  });

  it("refuses writes outside the project", async () => {
    const ws = await open();
    await expect(ws.writeText("../escape.txt", "x")).rejects.toMatchObject({
      code: "fs.outside_workspace",
    });
    expect(existsSync(path.join(base, "escape.txt"))).toBe(false);
  });

  it("writes through an inside link to the real file", async () => {
    write("src/a.ts", "old");
    symlinkSync(path.join(root, "src"), path.join(root, "alias"), "junction");
    const ws = await open();
    await ws.writeText("alias/a.ts", "new");
    expect(bytes("src/a.ts").toString()).toBe("new");
  });
});

describe("WorkspaceService.listDir", () => {
  it("lists folders first in natural order and marks ignored entries", async () => {
    write(".gitignore", "*.log\n");
    write("file10.ts", "");
    write("file2.ts", "");
    write("debug.log", "");
    mkdirSync(path.join(root, "node_modules"));
    const ws = await open();
    const entries = await ws.listDir("");
    expect(entries.map((e) => [e.name, e.kind, e.ignored])).toEqual([
      ["node_modules", "directory", true],
      ["src", "directory", false],
      [".gitignore", "file", false],
      ["debug.log", "file", true],
      ["file2.ts", "file", false],
      ["file10.ts", "file", false],
    ]);
    expect(entries.find((e) => e.name === "src")).toMatchObject({ path: "src", link: false });
  });

  it("shows a link that leads outside but marks it so it is never followed", async () => {
    const secrets = path.join(base, "secrets");
    mkdirSync(secrets);
    symlinkSync(secrets, path.join(root, "escape"), "junction");
    const ws = await open();
    const entry = (await ws.listDir("")).find((e) => e.name === "escape");
    expect(entry).toMatchObject({ kind: "directory", link: true, outside: true });
    await expect(ws.listDir("escape")).rejects.toMatchObject({ code: "fs.outside_workspace" });
  });

  it("lists nested folders with project-relative paths", async () => {
    write("src/components/Button.tsx", "");
    const ws = await open();
    expect(await ws.listDir("src/components")).toMatchObject([
      { name: "Button.tsx", path: "src/components/Button.tsx", kind: "file" },
    ]);
  });
});

describe("WorkspaceService.rename and createDirectory", () => {
  it("moves a file, creating the target folder", async () => {
    write("src/a.ts", "a");
    const ws = await open();
    await ws.rename("src/a.ts", "lib/b.ts");
    expect(existsSync(path.join(root, "src", "a.ts"))).toBe(false);
    expect(bytes("lib/b.ts").toString()).toBe("a");
    expect(ws.changeCounter).toBe(1);
  });

  it("never replaces an existing target", async () => {
    write("a.ts", "a");
    write("b.ts", "b");
    const ws = await open();
    await expect(ws.rename("a.ts", "b.ts")).rejects.toMatchObject({ code: "fs.already_exists" });
    expect(bytes("b.ts").toString()).toBe("b");
  });

  it.runIf(process.platform === "win32" || process.platform === "darwin")(
    "allows a case-only rename",
    async () => {
      write("readme.md", "x");
      const ws = await open();
      await ws.rename("readme.md", "README.md");
      expect(readdirSync(root)).toContain("README.md");
    },
  );

  it("refuses to move files out of the project or rename the project", async () => {
    write("a.ts", "a");
    const ws = await open();
    await expect(ws.rename("a.ts", "../a.ts")).rejects.toMatchObject({
      code: "fs.outside_workspace",
    });
    await expect(ws.rename("", "x")).rejects.toMatchObject({ code: "fs.invalid_path" });
  });

  it("creates folders", async () => {
    const ws = await open();
    await ws.createDirectory("a/b/c");
    expect(existsSync(path.join(root, "a", "b", "c"))).toBe(true);
  });
});

describe("canonicalProjectPath", () => {
  it("resolves links and gives one identity per folder", async () => {
    const via = path.join(base, "via");
    symlinkSync(root, via, "junction");
    expect(await canonicalProjectPath(via)).toBe(await canonicalProjectPath(root));
    expect(await canonicalProjectPath(path.join(root, "src", ".."))).toBe(
      await canonicalProjectPath(root),
    );
  });

  it.runIf(process.platform === "win32")("lower-cases the drive letter", async () => {
    expect(await canonicalProjectPath(root)).toMatch(/^[a-z]:\\/);
  });
});
