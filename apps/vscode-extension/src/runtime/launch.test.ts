import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRipgrep, launchSpec, runtimeEnv } from "./launch.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "jesutobits-ext-")));
  dirs.push(dir);
  return dir;
}

function touch(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runtimeEnv", () => {
  it("keeps only the allowlisted variables", () => {
    const env = runtimeEnv(
      { PATH: "/bin", HOME: "/home/ada", SECRET_TOKEN: "leak", SOME_VAR: "drop" },
      "linux",
    );

    expect(env).toStrictEqual({ PATH: "/bin", HOME: "/home/ada", ELECTRON_RUN_AS_NODE: "1" });
  });

  it("drops NODE_OPTIONS and VS Code's own variables", () => {
    const env = runtimeEnv(
      {
        PATH: "/bin",
        NODE_OPTIONS: "--max-old-space-size=256",
        VSCODE_PID: "4242",
        VSCODE_IPC_HOOK: "pipe",
      },
      "linux",
    );

    expect(env).not.toHaveProperty("NODE_OPTIONS");
    expect(env).not.toHaveProperty("VSCODE_PID");
    expect(env).not.toHaveProperty("VSCODE_IPC_HOOK");
  });

  it("always runs as Node", () => {
    expect(runtimeEnv({}, "linux").ELECTRON_RUN_AS_NODE).toBe("1");
    expect(runtimeEnv({ ELECTRON_RUN_AS_NODE: "0" }, "linux").ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("matches allowlisted names case-insensitively on Windows", () => {
    const env = runtimeEnv({ Path: "C:\\Windows\\System32", Temp: "C:\\Temp" }, "win32");

    expect(env.PATH).toBe("C:\\Windows\\System32");
    expect(env.TEMP).toBe("C:\\Temp");
    expect(env).not.toHaveProperty("Path");
  });

  it("matches allowlisted names exactly elsewhere", () => {
    expect(runtimeEnv({ Path: "/usr/bin" }, "linux")).toStrictEqual({
      ELECTRON_RUN_AS_NODE: "1",
    });
  });

  it("skips unset values", () => {
    expect(runtimeEnv({ PATH: undefined, HOME: "/home/ada" }, "linux")).toStrictEqual({
      HOME: "/home/ada",
      ELECTRON_RUN_AS_NODE: "1",
    });
  });
});

describe("launchSpec", () => {
  it("runs the bundled runtime from the extension's dist folder", () => {
    const extensionPath = tempDir();
    const dataDir = tempDir();

    const spec = launchSpec({
      execPath: process.execPath,
      extensionPath,
      dataDir,
      env: { PATH: "/bin" },
    });

    expect(spec).toStrictEqual({
      command: process.execPath,
      args: [
        join(extensionPath, "dist", "runtime", "runtime.mjs"),
        "--stdio",
        "--data-dir",
        dataDir,
        "--guest",
        join(extensionPath, "dist", "guest"),
      ],
      env: { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" },
    });
  });

  it("adds the ripgrep that VS Code ships", () => {
    const extensionPath = tempDir();
    const dataDir = tempDir();
    const appRoot = tempDir();
    const rg = touch(
      join(
        appRoot,
        "node_modules.asar.unpacked",
        "@vscode",
        "ripgrep-universal",
        "bin",
        `${process.platform}-${process.arch}`,
        process.platform === "win32" ? "rg.exe" : "rg",
      ),
    );

    const spec = launchSpec({
      execPath: process.execPath,
      extensionPath,
      dataDir,
      appRoot,
      env: {},
    });

    expect(spec.args.slice(-4, -2)).toEqual(["--ripgrep", rg]);
  });

  it("leaves ripgrep out when VS Code has none", () => {
    const spec = launchSpec({
      execPath: process.execPath,
      extensionPath: tempDir(),
      dataDir: tempDir(),
      appRoot: tempDir(),
      env: {},
    });

    expect(spec.args).not.toContain("--ripgrep");
  });
});

describe("findRipgrep", () => {
  it("finds the universal build VS Code ships", () => {
    const appRoot = tempDir();
    const rg = touch(
      join(
        appRoot,
        "node_modules.asar.unpacked",
        "@vscode",
        "ripgrep-universal",
        "bin",
        "win32-x64",
        "rg.exe",
      ),
    );

    expect(findRipgrep(appRoot, "win32", "x64")).toBe(rg);
  });

  it("falls back to the older ripgrep layout", () => {
    const appRoot = tempDir();
    const rg = touch(
      join(appRoot, "node_modules.asar.unpacked", "@vscode", "ripgrep", "bin", "rg.exe"),
    );

    expect(findRipgrep(appRoot, "win32", "x64")).toBe(rg);
  });

  it("returns undefined when the install ships no ripgrep", () => {
    expect(findRipgrep(tempDir(), "win32", "x64")).toBeUndefined();
  });
});
