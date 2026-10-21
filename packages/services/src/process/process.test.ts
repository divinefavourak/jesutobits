import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { childEnvironment, resolveExecutable } from "./environment.js";
import { runCommand } from "./run-command.js";
import { detectToolchain } from "./toolchain.js";

const FAKE = fileURLToPath(new URL("../../../../fixtures/bin/fake-cmd.mjs", import.meta.url));
const NODE = process.execPath;
const isWindows = process.platform === "win32";
let dir: string;

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "jesutobits-process-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

const run = (args: string[], options: Partial<Parameters<typeof runCommand>[1]> = {}) =>
  runCommand([NODE, FAKE, ...args], { cwd: dir, ...options });

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("childEnvironment (ADR-0011)", () => {
  it("keeps only the allowlist, ignoring case on Windows", () => {
    const env = childEnvironment(
      { Path: "C:\\bin", NODE_OPTIONS: "--require evil.js", OPENROUTER_API_KEY: "sk-x", TEMP: "t" },
      {},
      "win32",
    );
    expect(env).toEqual({ PATH: "C:\\bin", TEMP: "t" });
  });

  it("is case-sensitive elsewhere and adds extra variables", () => {
    expect(
      childEnvironment({ Path: "/bin", PATH: "/usr/bin", LD_PRELOAD: "x" }, { CI: "1" }, "linux"),
    ).toEqual({
      PATH: "/usr/bin",
      CI: "1",
    });
  });
});

describe("resolveExecutable", () => {
  it("finds a program on PATH, with PATHEXT on Windows", async () => {
    const name = isWindows ? "mytool.cmd" : "mytool";
    writeFileSync(path.join(dir, name), isWindows ? "@echo off\r\n" : "#!/bin/sh\n");
    if (!isWindows) chmodSync(path.join(dir, name), 0o755);
    const found = await resolveExecutable("mytool", { PATH: dir, PATHEXT: ".EXE;.CMD" });
    // PATHEXT is upper case, so on Windows the path reads mytool.CMD: the same file.
    expect(found?.path.toLowerCase()).toBe(path.join(dir, name).toLowerCase());
    expect(found?.kind).toBe(isWindows ? "cmd-shim" : "binary");
    expect(await resolveExecutable("missing-tool", { PATH: dir })).toBeUndefined();
  });

  it("uses an explicit path as is", async () => {
    expect(await resolveExecutable(NODE, {})).toMatchObject({ path: NODE, kind: "binary" });
  });
});

describe("runCommand", () => {
  it("passes arguments verbatim without a shell", async () => {
    const tricky = [
      "hello world",
      'quote"inside',
      "a&b",
      "100%",
      "caret^",
      "pipe|x",
      "$HOME",
      "*.ts",
      "",
    ];
    const result = await run(["--print-args", "--", ...tricky]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ args: tricky });
  });

  it("returns failing exits as results, with output", async () => {
    const result = await run(["--stdout", "out", "--stderr", "err", "--exit", "3"]);
    expect(result).toMatchObject({ exitCode: 3, stdout: "out", stderr: "err", truncated: false });
  });

  it("runs in the given folder with the allowlisted environment only", async () => {
    vi.stubEnv("NODE_OPTIONS", "--max-old-space-size=1");
    vi.stubEnv("JESUTOBITS_CANARY_SECRET", "sk-canary-should-not-leak");
    try {
      const result = await run(["--print-cwd", "--print-env"]);
      // fake-cmd prints the environment first, then the working folder.
      const [env, cwd] = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(cwd).toEqual({ cwd: dir });
      // On Windows libuv adds a few system variables a child cannot run without (SystemRoot,
      // USERNAME, WINDIR...); none of them carry secrets. What we drop must stay dropped.
      const names = Object.keys((env as { env: Record<string, string> }).env);
      expect(names).not.toContain("NODE_OPTIONS");
      expect(JSON.stringify(env)).not.toContain("sk-canary-should-not-leak");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("caps captured output", async () => {
    const result = await run(["--bytes", "5000"], { maxOutputBytes: 1000 });
    expect(result.stdout).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });

  it("stops a command and its children on timeout", async () => {
    const pidFile = path.join(dir, "grandchild.pid");
    const error = await run(["--grandchild", pidFile, "--ignore-term", "--sleep", "60000"], {
      timeoutMs: 500,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "process.timeout" });
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    await vi.waitFor(() => expect(isAlive(grandchild)).toBe(false), { timeout: 10_000 });
  });

  it("cancels within 2 s (AGENTS.md)", async () => {
    const abort = new AbortController();
    const running = run(["--ignore-term", "--sleep", "60000"], { signal: abort.signal });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = performance.now();
    abort.abort();
    await expect(running).rejects.toMatchObject({ code: "process.cancelled" });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("refuses an empty or missing command", async () => {
    await expect(runCommand([], { cwd: dir })).rejects.toMatchObject({
      code: "process.invalid_command",
    });
    await expect(runCommand(["jesutobits-no-such-tool"], { cwd: dir })).rejects.toMatchObject({
      code: "process.not_found",
    });
  });

  it.runIf(isWindows)(
    "runs a .cmd shim through cmd.exe with every argument intact (RN-16)",
    async () => {
      const shim = path.join(dir, "echoargs.cmd");
      writeFileSync(shim, `@"${NODE}" "${FAKE}" --print-args -- %*\r\n`);
      const tricky = [
        "hello world",
        'quote"inside',
        "a&b",
        "100%",
        "caret^",
        "pipe|x",
        "(paren)",
        "semi;colon",
        "lt<gt>",
        "trailing\\",
        "",
      ];
      const result = await runCommand([shim, ...tricky], { cwd: dir });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ args: tricky });
    },
  );

  it.runIf(isWindows)(
    "never lets an argument inject a command through the shim's second parse",
    async () => {
      const shim = path.join(dir, "echoargs.cmd");
      writeFileSync(shim, `@"${NODE}" "${FAKE}" --print-args -- %*\r\n`);
      const marker = path.join(dir, "injected.txt");
      // Escaped only once, the quote flips cmd's quote state inside the batch file and the
      // `&` would run `echo` (found while writing this spawner).
      const hostile = ['quote"inside', `a&echo injected>${marker}&rem `];
      const result = await runCommand([shim, ...hostile], { cwd: dir });
      expect(JSON.parse(result.stdout)).toEqual({ args: hostile });
      expect(existsSync(marker)).toBe(false);
    },
  );

  it.runIf(isWindows)("finds and runs a shim by bare name, like `npm`", async () => {
    writeFileSync(
      path.join(dir, "mytool.cmd"),
      `@"${NODE}" "${FAKE}" --version-output "mytool 1.2.3"\r\n`,
    );
    const result = await runCommand(["mytool"], {
      cwd: dir,
      env: { PATH: `${dir};${process.env.PATH ?? ""}` },
    });
    expect(result.stdout.trim()).toBe("mytool 1.2.3");
  });
});

describe("detectToolchain (FR-010)", () => {
  it("reports every tool, with versions for those found, and never throws", async () => {
    const tools = await detectToolchain({ cwd: dir });
    expect(tools.map((tool) => tool.name)).toEqual(["git", "node", "npm", "pnpm", "yarn", "bun"]);
    // The tests run on Node, so it is on PATH.
    const node = tools.find((tool) => tool.name === "node");
    expect(node).toMatchObject({ found: true, version: expect.stringMatching(/^\d+\.\d+/) });
    expect(existsSync(String(node?.path))).toBe(true);
  });
});
