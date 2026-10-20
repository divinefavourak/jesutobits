import { realpath } from "node:fs/promises";
import path from "node:path";

/**
 * A project's identity (FR-009, DATA_AND_PERSISTENCE.md section 3): the real path with links
 * resolved, separators normalised and, on Windows, a lower-case drive letter. Two ways of
 * naming one folder give the same string. Throws if the folder does not exist.
 */
export async function canonicalProjectPath(input: string): Promise<string> {
  const real = path.normalize(await realpath(path.resolve(input)));
  return process.platform === "win32"
    ? real.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
    : real;
}
