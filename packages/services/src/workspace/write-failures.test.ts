import * as fsp from "node:fs/promises";
import type * as fsTypes from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JesutobitsError } from "@jesutobits/protocol";
import { nullLogger } from "@jesutobits/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceService } from "./workspace-service.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsTypes>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});

/** An error shaped like a Node fs error, carrying an errno `code`. */
const asErrno = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

let base: string;
let root: string;

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "jesutobits-wfail-")));
  root = path.join(base, "project");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "notes.txt"), "original\r\n");
});

afterEach(() => {
  vi.mocked(fsp.open).mockRestore();
  vi.mocked(fsp.rename).mockRestore();
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const openService = () => WorkspaceService.open({ root, log: nullLogger });
const notesBytes = (): Buffer => readFileSync(path.join(root, "notes.txt"));

/** Any of `writeFileAtomic`'s temporary files left in the project folder after a failure. */
const tempLeftovers = (): string[] =>
  readdirSync(root).filter((name) => name.startsWith(".notes.txt.") && name.endsWith(".tmp"));

describe("Write failures keep the original file intact", () => {
  it("rejects with fs.io and cleans up when the temp file runs out of space", async () => {
    const real = await vi.importActual<typeof fsTypes>("node:fs/promises");
    const realOpen = real.open;
    vi.mocked(fsp.open).mockImplementationOnce((async (
      ...args: Parameters<typeof fsTypes.open>
    ) => {
      const handle = await (realOpen as typeof fsTypes.open)(...args);
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "writeFile") {
            return async () => {
              throw asErrno("ENOSPC", "no space");
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }) as FileHandle;
    }) as typeof fsTypes.open);
    const service = await openService();
    const changeCounter = service.changeCounter;

    const failure = await service.writeText("notes.txt", "new").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(JesutobitsError);
    const error = failure as JesutobitsError;
    expect(error.code).toBe("fs.io");
    expect(error.details?.errno).toBe("ENOSPC");
    expect(error.message).toContain("notes.txt");
    expect(error.message).not.toContain(root);
    expect(notesBytes().equals(Buffer.from("original\r\n")));
    expect(tempLeftovers()).toEqual([]);
    expect(service.changeCounter).toBe(changeCounter);
  });

  it("rejects with fs.permission_denied and cleans up when the final rename is never allowed", async () => {
    vi.mocked(fsp.rename).mockImplementation((async () => {
      throw asErrno("EPERM", "locked by another process");
    }) as unknown as typeof fsp.rename);
    const service = await openService();
    const changeCounter = service.changeCounter;

    const failure = await service.writeText("notes.txt", "new").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(JesutobitsError);
    const error = failure as JesutobitsError;
    expect(error.code).toBe("fs.permission_denied");
    expect(error.details?.errno).toBe("EPERM");
    expect(error.message).toContain("notes.txt");
    expect(error.message).not.toContain(root);
    expect(notesBytes().equals(Buffer.from("original\r\n")));
    expect(tempLeftovers()).toEqual([]);
    expect(service.changeCounter).toBe(changeCounter);
  });

  it.runIf(process.platform === "win32")(
    "succeeds after two transient EPERM renames on Windows",
    async () => {
      const locked = asErrno("EPERM", "locked by another process");
      vi.mocked(fsp.rename).mockRejectedValueOnce(locked);
      vi.mocked(fsp.rename).mockRejectedValueOnce(locked);
      const service = await openService();

      await service.writeText("notes.txt", "new");

      expect(notesBytes().toString()).toBe("new");
      expect(tempLeftovers()).toEqual([]);
    },
  );

  it("reports the same fs.io failure for writeBytes when the temp file runs out of space", async () => {
    const real = await vi.importActual<typeof fsTypes>("node:fs/promises");
    const realOpen = real.open;
    vi.mocked(fsp.open).mockImplementationOnce((async (
      ...args: Parameters<typeof fsTypes.open>
    ) => {
      const handle = await (realOpen as typeof fsTypes.open)(...args);
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "writeFile") {
            return async () => {
              throw asErrno("ENOSPC", "no space");
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }) as FileHandle;
    }) as typeof fsTypes.open);
    const service = await openService();
    const changeCounter = service.changeCounter;

    const failure = await service
      .writeBytes("notes.txt", Buffer.from("new"))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(JesutobitsError);
    const error = failure as JesutobitsError;
    expect(error.code).toBe("fs.io");
    expect(error.details?.errno).toBe("ENOSPC");
    expect(error.message).toContain("notes.txt");
    expect(notesBytes().equals(Buffer.from("original\r\n")));
    expect(tempLeftovers()).toEqual([]);
    expect(service.changeCounter).toBe(changeCounter);
  });

  it("rejects with fs.permission_denied when the write folder cannot be created", async () => {
    vi.mocked(fsp.open).mockRejectedValueOnce(asErrno("EACCES", "denied"));
    const service = await openService();
    const changeCounter = service.changeCounter;

    const failure = await service.writeText("notes.txt", "new").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(JesutobitsError);
    const error = failure as JesutobitsError;
    expect(error.code).toBe("fs.permission_denied");
    expect(error.details?.errno).toBe("EACCES");
    expect(error.message).toContain("notes.txt");
    expect(notesBytes().equals(Buffer.from("original\r\n")));
    expect(tempLeftovers()).toEqual([]);
    expect(service.changeCounter).toBe(changeCounter);
  });
});
