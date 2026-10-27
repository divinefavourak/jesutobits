import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, sep } from "node:path";
import { ErrorCodes } from "@jesutobits/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { RpcCallError } from "../runtime/connection.js";
import { createReverseHandler, type HostServices } from "./reverse-calls.js";

const REF = "provider:openrouter:default";

const dirs: string[] = [];

function tempDir(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "jesutobits-ext-")));
  dirs.push(dir);
  return dir;
}

function setup(
  overrides: Partial<HostServices> = {},
  platform: NodeJS.Platform = process.platform,
) {
  const trashed: string[] = [];
  const revealed: string[] = [];
  const logs: Array<{ level: "info" | "warn"; message: string }> = [];
  const services: HostServices = {
    getSecret: async () => undefined,
    trash: async (path) => {
      trashed.push(path);
    },
    reveal: async (path) => {
      revealed.push(path);
    },
    log: (level, message) => logs.push({ level, message }),
    homeDir: undefined,
    ...overrides,
  };
  return { handler: createReverseHandler(services, platform), trashed, revealed, logs };
}

async function failure(
  handler: (method: string, params: unknown) => Promise<unknown>,
  method: string,
  params: unknown,
): Promise<RpcCallError> {
  try {
    await handler(method, params);
  } catch (error) {
    if (error instanceof RpcCallError) return error;
    throw error;
  }
  throw new Error(`${method} should have failed`);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createReverseHandler", () => {
  it("refuses a method the Host does not implement", async () => {
    const { handler } = setup();

    const error = await failure(handler, "host.dialog.open", {});

    expect(error).toBeInstanceOf(RpcCallError);
    expect(error.error.code).toBe(-32601);
    expect(error.error.data?.code).toBe(ErrorCodes.rpcMethodNotFound);
  });

  it("refuses params that do not match the method's schema", async () => {
    const { handler } = setup();

    const error = await failure(handler, "host.secrets.get", { ref: "nope" });

    expect(error.error.code).toBe(-32602);
    expect(error.error.data?.code).toBe(ErrorCodes.rpcInvalidParams);
  });
});

describe("host.secrets.get", () => {
  it("reads the stored secret", async () => {
    const { handler } = setup({ getSecret: async (ref) => `key-for-${ref}` });

    await expect(handler("host.secrets.get", { ref: REF })).resolves.toStrictEqual({
      value: `key-for-${REF}`,
    });
  });

  it("answers null when nothing is stored", async () => {
    const { handler } = setup({ getSecret: async () => undefined });

    await expect(handler("host.secrets.get", { ref: REF })).resolves.toStrictEqual({
      value: null,
    });
  });

  it("treats an empty string as nothing stored", async () => {
    const { handler } = setup({ getSecret: async () => "" });

    await expect(handler("host.secrets.get", { ref: REF })).resolves.toStrictEqual({
      value: null,
    });
  });
});

describe("host.fs.trash", () => {
  it("refuses a relative path", async () => {
    const { handler } = setup();

    const error = await failure(handler, "host.fs.trash", { path: join("some", "file.txt") });

    expect(error.error.data?.code).toBe(ErrorCodes.fsInvalidPath);
  });

  it("refuses a filesystem root", async () => {
    const { handler } = setup();
    const root = parse(tempDir()).root;

    const error = await failure(handler, "host.fs.trash", { path: root });

    expect(error.error.data?.code).toBe(ErrorCodes.fsInvalidPath);
  });

  it("reports a path that does not exist", async () => {
    const { handler } = setup();

    const error = await failure(handler, "host.fs.trash", {
      path: join(tempDir(), "missing.txt"),
    });

    expect(error.error.data?.code).toBe(ErrorCodes.fsNotFound);
  });

  it("refuses the home folder", async () => {
    const homeDir = tempDir();
    const { handler } = setup({ homeDir });

    const error = await failure(handler, "host.fs.trash", { path: homeDir });

    expect(error.error.data?.code).toBe(ErrorCodes.fsInvalidPath);
  });

  it("refuses the home folder even with a trailing separator", async () => {
    const homeDir = tempDir();
    const { handler } = setup({ homeDir });

    const error = await failure(handler, "host.fs.trash", { path: `${homeDir}${sep}` });

    expect(error.error.data?.code).toBe(ErrorCodes.fsInvalidPath);
  });

  it("refuses the home folder whatever its letter case on Windows", async () => {
    const homeDir = tempDir();
    const path = join(homeDir, "HomeCase");
    mkdirSync(path);
    const { handler } = setup({ homeDir: path.toUpperCase() }, "win32");

    const error = await failure(handler, "host.fs.trash", { path });

    expect(error.error.data?.code).toBe(ErrorCodes.fsInvalidPath);
  });

  it("moves an existing file to the trash", async () => {
    const dir = tempDir();
    const path = join(dir, "old.txt");
    writeFileSync(path, "bye");
    const { handler, trashed } = setup({ homeDir: tempDir() });

    await expect(handler("host.fs.trash", { path })).resolves.toStrictEqual({});

    expect(trashed).toEqual([path]);
  });

  it("reports a trash the OS refused", async () => {
    const dir = tempDir();
    const path = join(dir, "busy.txt");
    writeFileSync(path, "still here");
    const { handler, logs } = setup({
      trash: async () => {
        throw new Error("the file is in use");
      },
    });

    const error = await failure(handler, "host.fs.trash", { path });

    expect(error.error.data?.code).toBe(ErrorCodes.fsTrashFailed);
    expect(logs).toContainEqual({
      level: "warn",
      message: expect.stringContaining("the file is in use"),
    });
  });
});

describe("host.os.reveal", () => {
  it("reports a path that does not exist", async () => {
    const { handler } = setup();

    const error = await failure(handler, "host.os.reveal", {
      path: join(tempDir(), "missing.txt"),
    });

    expect(error.error.data?.code).toBe(ErrorCodes.fsNotFound);
  });

  it("reveals an existing path", async () => {
    const path = join(tempDir(), "shown.txt");
    writeFileSync(path, "hello");
    const { handler, revealed } = setup();

    await expect(handler("host.os.reveal", { path })).resolves.toStrictEqual({});

    expect(revealed).toEqual([path]);
  });

  it("reports a file manager that could not be opened", async () => {
    const path = join(tempDir(), "shown.txt");
    writeFileSync(path, "hello");
    const { handler, logs } = setup({
      reveal: async () => {
        throw new Error("no file manager");
      },
    });

    const error = await failure(handler, "host.os.reveal", { path });

    expect(error.error.data?.code).toBe(ErrorCodes.fsRevealFailed);
    expect(logs).toContainEqual({
      level: "warn",
      message: expect.stringContaining("no file manager"),
    });
  });
});
