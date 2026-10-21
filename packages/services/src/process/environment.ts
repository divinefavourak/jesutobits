import { access, constants } from "node:fs/promises";
import path from "node:path";

/**
 * The environment child processes start with (ADR-0011): an allowlist, so variables that
 * change how runtimes load code (NODE_OPTIONS, LD_PRELOAD, DYLD_*) and provider credentials
 * never reach a child. Windows variable names are case-insensitive ("Path").
 */
export const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "LANG",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

export type Env = Record<string, string>;

export function childEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  extra: Env = {},
  platform: NodeJS.Platform = process.platform,
): Env {
  const env: Env = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const allowed = ENV_ALLOWLIST.find((key) =>
      platform === "win32" ? key.toLowerCase() === name.toLowerCase() : key === name,
    );
    if (allowed) env[allowed] = value;
  }
  return { ...env, ...extra };
}

/** How the program must be started. */
export type ExecutableKind = "binary" | "cmd-shim";

export interface ResolvedExecutable {
  path: string;
  kind: ExecutableKind;
}

/**
 * Finds a program the way a shell would: an explicit path is used as is; a bare name is
 * looked up in PATH, with PATHEXT extensions on Windows (`npm` -> `npm.cmd`). `.cmd` and
 * `.bat` files need cmd.exe (RN-16), which the spawner handles.
 */
export async function resolveExecutable(
  command: string,
  env: Env,
  platform: NodeJS.Platform = process.platform,
): Promise<ResolvedExecutable | undefined> {
  const api = platform === "win32" ? path.win32 : path.posix;
  const isWindows = platform === "win32";
  const extensions = isWindows
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const kindOf = (file: string): ExecutableKind =>
    isWindows && /\.(cmd|bat)$/i.test(file) ? "cmd-shim" : "binary";

  const candidates = (base: string) =>
    isWindows && !extensions.some((ext) => base.toLowerCase().endsWith(ext.toLowerCase()))
      ? extensions.map((ext) => base + ext)
      : [base];

  const hasDirectory = command.includes("/") || (isWindows && command.includes("\\"));
  const directories = hasDirectory ? [""] : (env.PATH ?? "").split(api.delimiter).filter(Boolean);
  for (const directory of directories) {
    const base = directory ? api.join(directory, command) : command;
    for (const candidate of candidates(base)) {
      if (await isExecutable(candidate, isWindows))
        return { path: candidate, kind: kindOf(candidate) };
    }
  }
  return undefined;
}

async function isExecutable(file: string, isWindows: boolean): Promise<boolean> {
  try {
    await access(file, isWindows ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
