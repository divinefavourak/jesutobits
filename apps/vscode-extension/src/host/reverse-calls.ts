// Reverse calls the extension answers for the runtime (ADR-0003, ADR-0014, ADR-0015). Only
// methods declared in packages/protocol (`REVERSE_METHODS`) are answered, with their params
// validated. The OS work is passed in, so the checks are tested without VS Code.
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  ErrorCodes,
  REVERSE_METHODS,
  RpcErrorCode,
  type JesutobitsErrorCode,
  type ReverseMethod,
  type SecretRef,
} from "@jesutobits/protocol";
import { RpcCallError, rpcError } from "../runtime/connection.js";

export interface HostServices {
  /** From VS Code `SecretStorage`; undefined when nothing is stored. */
  getSecret(ref: SecretRef): Promise<string | undefined>;
  /** Moves an existing absolute path to the OS trash. */
  trash(path: string): Promise<void>;
  /** Shows an existing absolute path in the OS file manager. */
  reveal(path: string): Promise<void>;
  log(level: "info" | "warn", message: string): void;
  /** The user's home folder, which is never trashed. */
  homeDir: string | undefined;
}

export function createReverseHandler(
  services: HostServices,
  platform: NodeJS.Platform = process.platform,
): (method: string, params: unknown) => Promise<unknown> {
  return async (method, params) => {
    if (!Object.hasOwn(REVERSE_METHODS, method)) {
      throw new RpcCallError(
        rpcError(
          RpcErrorCode.MethodNotFound,
          ErrorCodes.rpcMethodNotFound,
          `The Host does not implement ${method}`,
        ),
      );
    }
    const parsed = REVERSE_METHODS[method as ReverseMethod].params.safeParse(params);
    if (!parsed.success) {
      throw new RpcCallError(
        rpcError(
          RpcErrorCode.InvalidParams,
          ErrorCodes.rpcInvalidParams,
          `Invalid params for ${method}`,
        ),
      );
    }
    switch (method as ReverseMethod) {
      case "host.secrets.get": {
        const { ref } = parsed.data as { ref: SecretRef };
        const value = await services.getSecret(ref);
        // An empty string is "nothing stored": the schema requires a non-empty key.
        return { value: value === undefined || value === "" ? null : value };
      }
      case "host.fs.trash": {
        const { path } = parsed.data as { path: string };
        await checkTrashable(path, services.homeDir, platform);
        try {
          await services.trash(path);
        } catch (error) {
          services.log("warn", `could not trash ${path}: ${errorMessage(error)}`);
          throw appError(
            ErrorCodes.fsTrashFailed,
            `The OS could not move it to the trash: ${errorMessage(error)}`,
          );
        }
        services.log("info", `moved to the trash: ${path}`);
        return {};
      }
      case "host.os.reveal": {
        const { path } = parsed.data as { path: string };
        await checkExists(path);
        try {
          await services.reveal(path);
        } catch (error) {
          services.log("warn", `could not reveal ${path}: ${errorMessage(error)}`);
          throw appError(
            ErrorCodes.fsRevealFailed,
            `The file manager could not be opened: ${errorMessage(error)}`,
          );
        }
        return {};
      }
    }
  };
}

/** Refuses relative paths, missing paths, filesystem roots and the home folder. */
async function checkTrashable(
  path: string,
  homeDir: string | undefined,
  platform: NodeJS.Platform,
): Promise<void> {
  if (!isAbsolute(path)) throw appError(ErrorCodes.fsInvalidPath, "The path must be absolute");
  if (dirname(resolve(path)) === resolve(path)) {
    throw appError(ErrorCodes.fsInvalidPath, "A drive or filesystem root cannot be trashed");
  }
  await checkExists(path);
  if (homeDir !== undefined) {
    const normalise = (p: string) => {
      const trimmed = resolve(p).replace(/[\\/]+$/, "");
      return platform === "win32" ? trimmed.toLowerCase() : trimmed;
    };
    if (normalise(path) === normalise(homeDir)) {
      throw appError(ErrorCodes.fsInvalidPath, "The home folder cannot be trashed");
    }
  }
}

async function checkExists(path: string): Promise<void> {
  if (!isAbsolute(path)) throw appError(ErrorCodes.fsInvalidPath, "The path must be absolute");
  try {
    await lstat(path);
  } catch {
    throw appError(ErrorCodes.fsNotFound, "Nothing exists at that path");
  }
}

function appError(code: JesutobitsErrorCode, message: string): RpcCallError {
  return new RpcCallError(rpcError(RpcErrorCode.ApplicationError, code, message));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
