import { lstat, readlink, realpath } from "node:fs/promises";
import nodePath from "node:path";
import { ErrorCodes, JesutobitsError } from "@jesutobits/protocol";
import { display } from "./errors.js";

type PathApi = typeof nodePath.win32;

/** Windows device names, with or without an extension (`nul.txt` is still NUL). */
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;
/** Characters Windows forbids in names, plus control characters. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[<>:"|?*\u0000-\u001f]/;

export interface ResolvedPath {
  /** Lexically normalised absolute path, as the user would see it. */
  absolute: string;
  /**
   * Where the path really is, after symlinks and junctions. For a path that does not exist
   * yet, the real path of its nearest existing parent plus the remaining names.
   */
  real: string;
  /** Relative to the project root with `/` separators; "" for the root itself. */
  relative: string;
}

interface Root {
  /** As opened, normalised. */
  lexical: string;
  /** After resolving links. */
  real: string;
}

/**
 * Confines every path to the workspace roots (SECURITY.md section 5.2):
 *
 * 1. Reject NUL and control characters, Windows reserved device names, alternate data
 *    streams and other `:` uses, trailing dots and spaces, and UNC or device paths unless
 *    the project itself is on a share.
 * 2. Resolve against the project root and normalise.
 * 3. Follow symlinks and junctions with `realpath`; for a new path, use its nearest existing
 *    parent. A dangling link is followed to where it points.
 * 4. Require the real path to be inside a root (case-insensitive on Windows and macOS).
 *
 * Callers re-resolve after every move, since a rename can change what a path points at.
 */
export class PathGuard {
  private constructor(
    private readonly roots: readonly Root[],
    private readonly path: PathApi,
    private readonly caseInsensitive: boolean,
  ) {}

  /** The project root (first) and any user-approved extra roots. */
  static async create(projectRoot: string, extraRoots: readonly string[] = []): Promise<PathGuard> {
    const path = nodePath as PathApi;
    const roots: Root[] = [];
    for (const root of [projectRoot, ...extraRoots]) {
      const lexical = path.resolve(root);
      roots.push({ lexical, real: await realpath(lexical) });
    }
    return new PathGuard(
      roots,
      path,
      process.platform === "win32" || process.platform === "darwin",
    );
  }

  get projectRoot(): string {
    return (this.roots[0] as Root).lexical;
  }

  /** The project root with links resolved: where the OS watcher reports changes. */
  get projectRootReal(): string {
    return (this.roots[0] as Root).real;
  }

  async resolve(input: string): Promise<ResolvedPath> {
    const { path } = this;
    const project = this.roots[0] as Root;
    checkName(input, path, isUncLike(project.lexical, path));

    const absolute = path.resolve(project.lexical, input);
    const lexicalRoot = this.roots.find((root) => this.isInside(absolute, root.lexical));
    if (!lexicalRoot) throw outside(input);
    const relative = toRelative(path, project.lexical, absolute);

    const real = await this.realPath(absolute);
    if (!this.roots.some((root) => this.isInside(real, root.real))) throw outside(relative);
    return { absolute, real, relative };
  }

  /** True when `child` is `parent` or inside it. */
  isInside(child: string, parent: string): boolean {
    return isInside(this.path, child, parent, this.caseInsensitive);
  }

  private async realPath(absolute: string): Promise<string> {
    const { path } = this;
    const missing: string[] = [];
    let current = absolute;
    for (;;) {
      try {
        const real = await realpath(current);
        return missing.length === 0 ? real : path.join(real, ...missing.reverse());
      } catch (error) {
        const errno = (error as NodeJS.ErrnoException).code;
        if (errno !== "ENOENT") throw error;
      }
      // A dangling link: confine where it points, not where it sits.
      const link = await lstat(current).catch(() => undefined);
      if (link?.isSymbolicLink()) {
        const target = path.resolve(path.dirname(current), await readlink(current));
        const resolved = await this.realPath(target);
        return missing.length === 0 ? resolved : path.join(resolved, ...missing.reverse());
      }
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** Pure name checks, exported for tests of both platforms' rules. */
export function checkName(input: string, path: PathApi, allowUnc: boolean): void {
  const invalid = (reason: string) =>
    new JesutobitsError(
      ErrorCodes.fsInvalidPath,
      `${input || "The path"} is not allowed: ${reason}`,
      {
        details: { path: input, reason },
      },
    );
  if (input.includes("\0")) throw invalid("it contains a NUL character");
  if (/^[\\/]{2}[?.][\\/]/.test(input)) throw invalid("device paths are not supported");
  if (/^[\\/]{2}[^\\/]/.test(input) && !allowUnc) throw invalid("network paths are not supported");

  // A leading drive (C:) is the only place a colon may appear.
  const withoutDrive =
    path === nodePath.win32 || path.sep === "\\" ? input.replace(/^[A-Za-z]:/, "") : input;
  for (const name of withoutDrive.split(/[\\/]/)) {
    if (name === "" || name === "." || name === "..") continue;
    if (FORBIDDEN_CHARS.test(name)) {
      throw invalid(
        name.includes(":")
          ? `"${name}" names an alternate data stream or contains ":"`
          : `"${name}" contains a character Windows does not allow`,
      );
    }
    if (RESERVED_NAME.test(name)) throw invalid(`"${name}" is a reserved device name on Windows`);
    if (/[. ]$/.test(name)) throw invalid(`"${name}" ends with a dot or space`);
  }
}

export function isInside(
  path: PathApi,
  child: string,
  parent: string,
  caseInsensitive: boolean,
): boolean {
  const a = caseInsensitive ? child.toLowerCase() : child;
  const b = caseInsensitive ? parent.toLowerCase() : parent;
  const relative = path.relative(b, a);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function toRelative(path: PathApi, root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function isUncLike(root: string, path: PathApi): boolean {
  return path.sep === "\\" && root.startsWith("\\\\");
}

function outside(relative: string): JesutobitsError {
  return new JesutobitsError(
    ErrorCodes.fsOutsideWorkspace,
    `${display(relative)} is outside the project folder`,
    { details: { path: relative } },
  );
}
