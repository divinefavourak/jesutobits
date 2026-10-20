import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkName, isInside, PathGuard } from "./path-guard.js";

describe("checkName", () => {
  const ok = (input: string, api = path.win32, allowUnc = false) =>
    expect(() => checkName(input, api, allowUnc)).not.toThrow();
  const bad = (input: string, reason: RegExp, api = path.win32, allowUnc = false) =>
    expect(() => checkName(input, api, allowUnc)).toThrow(reason);

  it("accepts ordinary relative and absolute paths", () => {
    ok("src/App.tsx");
    ok("src\\components\\Button.tsx");
    ok("C:\\Users\\ada\\project\\file.txt");
    ok("./a/../b/.hidden");
    ok("src/app.tsx", path.posix);
    ok("");
  });

  it.each([
    ["con", /reserved device name/],
    ["src/NUL.txt", /reserved device name/],
    ["lpt1", /reserved device name/],
    ["COM9.log", /reserved device name/],
    ["file.txt:stream", /alternate data stream/],
    ["notes.txt:$DATA", /alternate data stream/],
    ["a\0b", /NUL/],
    ["name.", /ends with a dot/],
    ["src/name ", /ends with a dot or space/],
    ["what?.txt", /does not allow/],
    ["a<b", /does not allow/],
    ["\\\\?\\C:\\x", /device paths/],
    ["\\\\.\\PhysicalDrive0", /device paths/],
    ["\\\\server\\share\\x", /network paths/],
  ])("rejects %j", (input, reason) => bad(input, reason));

  it("allows a share path when the project is on a share", () => {
    ok("\\\\server\\share\\x", path.win32, true);
  });

  it("applies the Windows name rules on every platform, for portable projects", () => {
    bad("aux.ts", /reserved/, path.posix);
    bad("a:b", /contains ":"/, path.posix);
  });

  it("only allows a colon as a drive on Windows", () => {
    bad("C:/x", /contains ":"/, path.posix);
  });
});

describe("isInside", () => {
  it("compares whole path segments", () => {
    expect(isInside(path.posix, "/p/a", "/p", false)).toBe(true);
    expect(isInside(path.posix, "/p", "/p", false)).toBe(true);
    expect(isInside(path.posix, "/project-other/a", "/project", false)).toBe(false);
    expect(isInside(path.posix, "/p/..x/a", "/p", false)).toBe(true);
    expect(isInside(path.posix, "/a", "/p", false)).toBe(false);
  });

  it("ignores case where the file system does", () => {
    expect(isInside(path.win32, "C:\\Users\\ADA\\p\\x", "c:\\users\\ada\\p", true)).toBe(true);
    expect(isInside(path.posix, "/P/x", "/p", true)).toBe(true);
    expect(isInside(path.posix, "/P/x", "/p", false)).toBe(false);
  });
});

describe("PathGuard on a real file system", () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), "jesutobits-guard-")));
    root = path.join(base, "project");
    outside = path.join(base, "secrets");
    mkdirSync(path.join(root, "src"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(root, "src", "a.txt"), "a");
    writeFileSync(path.join(outside, "id_rsa"), "secret");
  });

  afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  // Junctions on Windows need no privileges; elsewhere this is a directory symlink.
  const linkDir = (target: string, link: string) => symlinkSync(target, link, "junction");

  it("resolves paths inside the project", async () => {
    const guard = await PathGuard.create(root);
    await expect(guard.resolve("src/a.txt")).resolves.toMatchObject({
      relative: "src/a.txt",
      real: path.join(root, "src", "a.txt"),
    });
    await expect(guard.resolve("")).resolves.toMatchObject({ relative: "" });
    await expect(guard.resolve(path.join(root, "src"))).resolves.toMatchObject({
      relative: "src",
    });
  });

  it("resolves new paths through their nearest existing folder", async () => {
    const guard = await PathGuard.create(root);
    await expect(guard.resolve("new/deep/file.ts")).resolves.toMatchObject({
      relative: "new/deep/file.ts",
      real: path.join(root, "new", "deep", "file.ts"),
    });
  });

  it.each(["../secrets/id_rsa", "src/../../secrets/id_rsa"])(
    "refuses %j, which climbs out",
    async (input) => {
      const guard = await PathGuard.create(root);
      await expect(guard.resolve(input)).rejects.toMatchObject({ code: "fs.outside_workspace" });
    },
  );

  it("refuses absolute paths elsewhere", async () => {
    const guard = await PathGuard.create(root);
    await expect(guard.resolve(path.join(outside, "id_rsa"))).rejects.toMatchObject({
      code: "fs.outside_workspace",
    });
  });

  it("refuses a junction or symlink that leads outside, and new files through it", async () => {
    linkDir(outside, path.join(root, "escape"));
    const guard = await PathGuard.create(root);
    await expect(guard.resolve("escape/id_rsa")).rejects.toMatchObject({
      code: "fs.outside_workspace",
    });
    await expect(guard.resolve("escape/new-file.txt")).rejects.toMatchObject({
      code: "fs.outside_workspace",
    });
    await expect(guard.resolve("escape")).rejects.toMatchObject({ code: "fs.outside_workspace" });
  });

  it("allows a link that stays inside the project", async () => {
    linkDir(path.join(root, "src"), path.join(root, "alias"));
    const guard = await PathGuard.create(root);
    await expect(guard.resolve("alias/a.txt")).resolves.toMatchObject({
      relative: "alias/a.txt",
      real: path.join(root, "src", "a.txt"),
    });
  });

  it("follows a dangling link to where it points", async () => {
    const target = path.join(outside, "not-yet");
    linkDir(target, path.join(root, "later"));
    const guard = await PathGuard.create(root);
    await expect(guard.resolve("later/file.txt")).rejects.toMatchObject({
      code: "fs.outside_workspace",
    });
  });

  it("accepts a project opened through a link", async () => {
    const via = path.join(base, "via");
    linkDir(root, via);
    const guard = await PathGuard.create(via);
    await expect(guard.resolve("src/a.txt")).resolves.toMatchObject({
      relative: "src/a.txt",
      real: path.join(root, "src", "a.txt"),
    });
  });

  it("allows extra roots", async () => {
    const guard = await PathGuard.create(root, [outside]);
    await expect(guard.resolve(path.join(outside, "id_rsa"))).resolves.toMatchObject({
      real: path.join(outside, "id_rsa"),
    });
  });

  it("rejects unsafe names before touching the disk", async () => {
    const guard = await PathGuard.create(root);
    await expect(guard.resolve("src/con.ts")).rejects.toMatchObject({ code: "fs.invalid_path" });
  });
});
