import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { ErrorCodes, JesutobitsError } from "@jesutobits/protocol";
import { fsError } from "./errors.js";
import { checkName } from "./path-guard.js";

export type ProjectTemplate = "empty" | "general";

/**
 * Creates a new project folder `<parentDir>/<name>` for a built-in template (FR-005, J-04).
 * The only file-system write outside an open project, and only on the user's request
 * (FR-007). Phase 1's templates (Empty, General workspace) start as an empty folder; the
 * React templates arrive in Phase 4. Refuses a folder that already has files in it.
 */
export async function createProjectFolder(
  parentDir: string,
  name: string,
  template: ProjectTemplate,
): Promise<string> {
  checkName(name, path, false);
  if (/[\\/]/.test(name) || name === "." || name === "..") {
    throw new JesutobitsError(ErrorCodes.fsInvalidPath, `${name} is not a valid folder name`, {
      details: { path: name },
    });
  }
  const target = path.join(path.resolve(parentDir), name);
  try {
    const existing = await readdir(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing && existing.length > 0) {
      throw new JesutobitsError(
        ErrorCodes.fsAlreadyExists,
        `A folder named ${name} already exists there and is not empty`,
        {
          details: { path: name },
        },
      );
    }
    await mkdir(target, { recursive: true });
  } catch (error) {
    throw fsError(error, name);
  }
  void template; // Both Phase 1 templates are an empty folder.
  return target;
}

/** True when `target` exists and is a folder (recent projects' Missing marker). */
export async function folderExists(target: string): Promise<boolean> {
  return stat(target).then(
    (info) => info.isDirectory(),
    () => false,
  );
}
