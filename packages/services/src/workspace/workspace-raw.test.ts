import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import { hashBytes, WorkspaceService } from "./workspace-service.js";

let base: string;
let root: string;

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "jesutobits-ws-")));
  root = path.join(base, "project");
  mkdirSync(path.join(root, "src"), { recursive: true });
});

afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

const open = () => WorkspaceService.open({ root, log: nullLogger });
const write = (relative: string, content: string | Buffer) => {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), content);
};
const bytes = (relative: string) => readFileSync(path.join(root, relative));

describe("WorkspaceService.snapshot", () => {
  it("returns exact bytes and their hash", async () => {
    const crlf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("alpha\r\nbeta\r\n", "utf8"),
    ]);
    const binary = Buffer.from([0x00, 0x01, 0x00, 0xff, 0x00]);
    write("bom-crlf.mkdn", crlf);
    write("raw.bin", binary);
    const ws = await open();

    const text = await ws.snapshot("bom-crlf.mkdn");
    expect(text?.path).toBe("bom-crlf.mkdn");
    expect(text?.bytes).toEqual(crlf);
    expect(text?.hash).toBe(hashBytes(crlf));

    const raw = await ws.snapshot("raw.bin");
    expect(raw?.bytes.equals(binary)).toBe(true);
    expect(raw?.hash).toBe(hashBytes(binary));
  });

  it("returns null for a missing path", async () => {
    const ws = await open();
    expect(await ws.snapshot("absent.txt")).toBeNull();
  });

  it("refuses a folder", async () => {
    const ws = await open();
    await expect(ws.snapshot("src")).rejects.toMatchObject({ code: "fs.not_a_file" });
  });

  it("refuses a path outside the project", async () => {
    writeFileSync(path.join(base, "outside.txt"), "not in the project");
    const ws = await open();
    await expect(ws.snapshot("../outside.txt")).rejects.toMatchObject({
      code: "fs.outside_workspace",
    });
  });
});

describe("WorkspaceService.writeBytes", () => {
  it("writes exactly the given bytes, without line-ending conversion", async () => {
    write("eol.txt", "a\nb\n");
    const ws = await open();
    const payload = Buffer.from("a\r\nb\r\n", "utf8");
    const before = ws.changeCounter;

    const result = await ws.writeBytes("eol.txt", payload);
    expect(bytes("eol.txt").equals(payload)).toBe(true);
    expect(result).toMatchObject({
      path: "eol.txt",
      hash: hashBytes(payload),
      size: payload.length,
    });
    expect(result.changeCounter).toBeGreaterThan(before);
    expect(ws.changeCounter).toBe(result.changeCounter);
  });

  it("creates missing parent folders", async () => {
    const ws = await open();
    await ws.writeBytes("made/up/file.bin", Buffer.from([0x00, 0x01, 0xff]));
    expect(bytes("made/up/file.bin").equals(Buffer.from([0x00, 0x01, 0xff]))).toBe(true);
  });

  it("honours expectedHash", async () => {
    write("doc.txt", "old\n");
    const ws = await open();
    const currentHash = hashBytes(bytes("doc.txt"));
    const existingHash = currentHash.slice(0, 30) + "0".repeat(34);

    await expect(
      ws.writeBytes("doc.txt", Buffer.from("new\n"), { expectedHash: existingHash }),
    ).rejects.toMatchObject({ code: "fs.conflict" });
    await expect(
      ws.writeBytes("doc.txt", Buffer.from("new\n"), { expectedHash: null }),
    ).rejects.toMatchObject({ code: "fs.already_exists" });
    expect(bytes("doc.txt").toString()).toBe("old\n");

    const result = await ws.writeBytes("absent.bin", Buffer.from("first\n"), {
      expectedHash: null,
    });
    expect(result.hash).toBe(hashBytes(Buffer.from("first\n", "utf8")));
  });
});

describe("WorkspaceService.remove", () => {
  it("deletes a file", async () => {
    write("gone.txt", "not long for this world");
    const ws = await open();
    await ws.remove("gone.txt");
    expect(existsSync(path.join(root, "gone.txt"))).toBe(false);
  });

  it("removes an empty folder without recursive", async () => {
    mkdirSync(path.join(root, "empty"));
    const ws = await open();
    await ws.remove("empty");
    expect(existsSync(path.join(root, "empty"))).toBe(false);
  });

  it("refuses a non-empty folder without recursive and keeps everything", async () => {
    write("full/still-here.txt", "survivor");
    const ws = await open();
    await expect(ws.remove("full")).rejects.toMatchObject({ code: "fs.not_empty" });
    expect(existsSync(path.join(root, "full/still-here.txt"))).toBe(true);
  });

  it("removes a folder and its contents with recursive", async () => {
    write("tree/branch/leaf.txt", "leaf");
    const ws = await open();
    await ws.remove("tree", { recursive: true });
    expect(existsSync(path.join(root, "tree"))).toBe(false);
  });

  it("refuses to remove the project folder", async () => {
    const ws = await open();
    await expect(ws.remove("")).rejects.toMatchObject({ code: "fs.invalid_path" });
  });

  it("refuses a missing path", async () => {
    const ws = await open();
    await expect(ws.remove("vanished.bin")).rejects.toMatchObject({ code: "fs.not_found" });
  });

  it("removes a link, not its target", async () => {
    write("target.txt", "kept bytes");
    try {
      symlinkSync("target.txt", path.join(root, "link"));
    } catch {
      // Windows without developer mode refuses to create symlinks; skip quietly.
      return;
    }
    const ws = await open();
    await ws.remove("link");
    expect(existsSync(path.join(root, "link"))).toBe(false);
    expect(bytes("target.txt").toString()).toBe("kept bytes");
  });
});

describe("WorkspaceService.listFiles", () => {
  it("returns the file itself for a file", async () => {
    write("src/only.ts", "0");
    const ws = await open();
    expect(await ws.listFiles("src/only.ts")).toEqual(["src/only.ts"]);
  });

  it("lists every file below a folder, sorted and project-relative", async () => {
    write("README.md", "");
    write("src/deep/c.ts", "");
    write("src/a.ts", "");
    write("src/b.ts", "");
    write("data/c.csv", "");
    write("z.ts", "");
    const ws = await open();
    expect(await ws.listFiles(".")).toEqual([
      "README.md",
      "data/c.csv",
      "src/a.ts",
      "src/b.ts",
      "src/deep/c.ts",
      "z.ts",
    ]);
  });

  it("refuses to list past maxFiles", async () => {
    write("many/1.txt", "");
    write("many/2.txt", "");
    write("many/3.txt", "");
    const ws = await open();
    await expect(ws.listFiles("many", 2)).rejects.toMatchObject({ code: "fs.too_large" });
  });
});
