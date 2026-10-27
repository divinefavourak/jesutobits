// How the extension starts the runtime (ADR-0015): VS Code's own Electron as Node, the runtime
// bundle from dist/runtime, and an allowlisted environment.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LaunchSpec } from "./supervisor.js";

/**
 * Environment the runtime inherits (ADR-0011 allowlist plus Jesutobits' own dev settings).
 * Everything else, including NODE_OPTIONS and VS Code's own variables, is dropped.
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
  "JESUTOBITS_RUNTIME_LOG",
  "JESUTOBITS_PROVIDER",
  "JESUTOBITS_CASSETTE",
  // A local mock provider for tests; the runtime accepts loopback URLs only.
  "JESUTOBITS_OPENROUTER_URL",
] as const;

/** The allowlisted variables from `source`. Names match case-insensitively on Windows. */
export function runtimeEnv(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const allowed = ENV_ALLOWLIST.find((entry) =>
      platform === "win32" ? entry.toUpperCase() === name.toUpperCase() : entry === name,
    );
    if (allowed) env[allowed] = value;
  }
  // Electron runs as plain Node; harmless when `execPath` is Node itself (tests).
  env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

export interface LaunchOptions {
  /** VS Code's executable (`process.execPath` in the extension host). */
  execPath: string;
  /** The extension's install folder; the runtime bundle is in dist/runtime. */
  extensionPath: string;
  /** Global storage: sessions, settings cache, checkpoints. */
  dataDir: string;
  /** VS Code's install (`vscode.env.appRoot`), to reuse the ripgrep it ships. */
  appRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export function launchSpec(options: LaunchOptions): LaunchSpec {
  const ripgrep = options.appRoot ? findRipgrep(options.appRoot) : undefined;
  return {
    command: options.execPath,
    args: [
      join(options.extensionPath, "dist", "runtime", "runtime.mjs"),
      "--stdio",
      "--data-dir",
      options.dataDir,
      ...(ripgrep ? ["--ripgrep", ripgrep] : []),
      "--guest",
      join(options.extensionPath, "dist", "guest"),
    ],
    env: runtimeEnv(options.env ?? process.env),
  };
}

/**
 * The ripgrep VS Code ships, which moved between releases. Without one the runtime uses its
 * JavaScript search.
 */
export function findRipgrep(
  appRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  const exe = platform === "win32" ? "rg.exe" : "rg";
  const candidates = [
    join(
      appRoot,
      "node_modules.asar.unpacked",
      "@vscode",
      "ripgrep-universal",
      "bin",
      `${platform}-${arch}`,
      exe,
    ),
    join(appRoot, "node_modules.asar.unpacked", "@vscode", "ripgrep", "bin", exe),
    join(appRoot, "node_modules", "@vscode", "ripgrep", "bin", exe),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
