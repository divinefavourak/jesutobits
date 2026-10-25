import { childEnvironment, resolveExecutable } from "./environment.js";
import { runCommand } from "./run-command.js";

/** The tools onboarding checks for (FR-010, UX_AND_INTERFACE.md section 3, step 3). */
export const TOOLS = ["git", "node", "npm", "pnpm", "yarn", "bun"] as const;
export type ToolName = (typeof TOOLS)[number];

export interface ToolStatus {
  name: ToolName;
  found: boolean;
  /** `2.47.0`, from `<tool> --version`; absent when not found or not parseable. */
  version?: string;
  path?: string;
}

const VERSION = /(\d+\.\d+(?:\.\d+)?)/;

/**
 * Looks for the system toolchain user projects run with (ADR-0011: the user's own Node and
 * package manager, not Jesutobits'). Each tool is found on PATH, then asked for its version
 * with a short timeout, all in parallel. Never throws: a missing or broken tool is
 * `found: false` (or found without a version), so onboarding can explain it without blocking.
 */
export async function detectToolchain(options: {
  cwd: string;
  timeoutMs?: number;
}): Promise<ToolStatus[]> {
  const env = childEnvironment();
  return Promise.all(
    TOOLS.map(async (name): Promise<ToolStatus> => {
      const executable = await resolveExecutable(name, env);
      if (!executable) return { name, found: false };
      try {
        const result = await runCommand([executable.path, "--version"], {
          cwd: options.cwd,
          timeoutMs: options.timeoutMs ?? 10_000,
          maxOutputBytes: 4096,
        });
        const version = VERSION.exec(`${result.stdout}\n${result.stderr}`)?.[1];
        return {
          name,
          found: true,
          path: executable.path,
          ...(version !== undefined && { version }),
        };
      } catch {
        return { name, found: true, path: executable.path };
      }
    }),
  );
}
