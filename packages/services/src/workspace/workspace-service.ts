import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, stat } from "node:fs/promises";
import path from "node:path";
import { ErrorCodes, JesutobitsError } from "@jesutobits/protocol";
import type { Logger } from "@jesutobits/shared";
import { writeFileAtomic } from "./atomic-write.js";
import { display, fsError } from "./errors.js";
import { IgnoreRules } from "./ignore-rules.js";
import { PathGuard, type ResolvedPath } from "./path-guard.js";
import { decodeText, encodeText, type TextFormat } from "./text.js";

export type EntryKind = "file" | "directory" | "other";

export interface DirEntry {
  name: string;
  /** Relative to the project root, `/` separated. */
  path: string;
  kind: EntryKind;
  /** A symlink or junction; `kind` is what it points at. */
  link: boolean;
  /** A link pointing outside the workspace: shown, never followed. */
  outside: boolean;
  /** Matched by .gitignore, .jesutobitsignore or the built-ins: shown dimmed. */
  ignored: boolean;
}

export interface FileStat {
  path: string;
  kind: EntryKind;
  size: number;
  mtimeMs: number;
}

export interface TextFile {
  path: string;
  text: string;
  /** SHA-256 of the bytes on disk; pass it back to `writeText` to detect conflicts. */
  hash: string;
  size: number;
  format: TextFormat;
}

export interface WriteResult {
  path: string;
  hash: string;
  size: number;
  changeCounter: number;
}

export interface WriteOptions {
  /**
   * Optimistic concurrency (FR-052): the hash the writer last read. A different file on
   * disk fails with `fs.conflict`. `null` means the file must not exist yet. Omitted means
   * write unconditionally.
   */
  expectedHash?: string | null;
}

export interface WorkspaceServiceOptions {
  root: string;
  /** User-approved extra roots (SECURITY.md section 5.2). */
  extraRoots?: readonly string[];
  log: Logger;
}

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

/** Larger text files are refused rather than read whole. */
export const DEFAULT_MAX_TEXT_BYTES = 5 * 1024 * 1024;

/**
 * The only way to the project's files (invariant 2): every path is confined by the
 * `PathGuard`, writes are atomic and keep line endings and the BOM, and each write bumps
 * `changeCounter`, which the verification ledger uses for freshness (AGENT_HARNESS.md
 * section 6). The watcher (`noteExternalChange`) bumps it for changes made elsewhere.
 */
export class WorkspaceService {
  private counter = 0;
  readonly ignores: IgnoreRules;

  private constructor(
    private readonly guard: PathGuard,
    private readonly log: Logger,
  ) {
    this.ignores = new IgnoreRules(async (relative) => {
      try {
        const resolved = await this.guard.resolve(relative);
        return await readFile(resolved.real, "utf8");
      } catch {
        return undefined;
      }
    });
  }

  static async open(options: WorkspaceServiceOptions): Promise<WorkspaceService> {
    const guard = await PathGuard.create(options.root, options.extraRoots);
    return new WorkspaceService(guard, options.log.child({ module: "workspace" }));
  }

  get root(): string {
    return this.guard.projectRoot;
  }

  /** Increments on every write through this service and every change the watcher reports. */
  get changeCounter(): number {
    return this.counter;
  }

  noteExternalChange(): number {
    return ++this.counter;
  }

  /** Confines a path without touching the file. */
  async resolve(input: string): Promise<ResolvedPath> {
    try {
      return await this.guard.resolve(input);
    } catch (error) {
      throw fsError(error, input);
    }
  }

  async stat(input: string): Promise<FileStat> {
    const resolved = await this.resolve(input);
    try {
      const info = await stat(resolved.real);
      return {
        path: resolved.relative,
        kind: kindOf(info),
        size: info.size,
        mtimeMs: info.mtimeMs,
      };
    } catch (error) {
      throw fsError(error, resolved.relative);
    }
  }

  /** One folder's entries, folders first, then names in natural order. Never recursive. */
  async listDir(input: string): Promise<DirEntry[]> {
    const resolved = await this.resolve(input);
    let dirents;
    try {
      dirents = await readdir(resolved.real, { withFileTypes: true });
    } catch (error) {
      throw fsError(error, resolved.relative);
    }
    const prefix = resolved.relative === "" ? "" : `${resolved.relative}/`;
    const entries = await Promise.all(
      dirents.map(async (dirent): Promise<DirEntry> => {
        const relative = `${prefix}${dirent.name}`;
        const link = dirent.isSymbolicLink();
        let kind: EntryKind = dirent.isDirectory()
          ? "directory"
          : dirent.isFile()
            ? "file"
            : "other";
        let outside = false;
        if (link) {
          ({ kind, outside } = await this.followLink(path.join(resolved.real, dirent.name)));
        }
        const ignored = await this.ignores.isIgnored(relative, kind === "directory");
        return { name: dirent.name, path: relative, kind, link, outside, ignored };
      }),
    );
    return entries.sort(compareEntries);
  }

  async readText(input: string, maxBytes = DEFAULT_MAX_TEXT_BYTES): Promise<TextFile> {
    const resolved = await this.resolve(input);
    const bytes = await this.readBytes(resolved, maxBytes);
    const decoded = decodeText(bytes);
    if (decoded.binary) {
      throw new JesutobitsError(
        ErrorCodes.fsBinary,
        `${display(resolved.relative)} is not a text file`,
        {
          details: { path: resolved.relative },
        },
      );
    }
    return {
      path: resolved.relative,
      text: decoded.text,
      hash: hashBytes(bytes),
      size: bytes.length,
      format: decoded.format,
    };
  }

  /**
   * Writes a text file atomically. An existing file keeps its BOM and, if it used one
   * style consistently, its line endings. Missing parent folders are created.
   */
  async writeText(input: string, text: string, options: WriteOptions = {}): Promise<WriteResult> {
    const resolved = await this.resolve(input);
    const { relative } = resolved;
    const existing = await this.readExisting(resolved);

    if (options.expectedHash === null && existing) {
      throw new JesutobitsError(ErrorCodes.fsAlreadyExists, `${display(relative)} already exists`, {
        details: { path: relative },
      });
    }
    if (typeof options.expectedHash === "string") {
      const current = existing ? hashBytes(existing.bytes) : null;
      if (current !== options.expectedHash) {
        throw new JesutobitsError(ErrorCodes.fsConflict, `${display(relative)} changed on disk`, {
          retryable: true,
          details: { path: relative, expectedHash: options.expectedHash, currentHash: current },
        });
      }
    }

    let format: TextFormat | undefined;
    if (existing) {
      const decoded = decodeText(existing.bytes);
      if (decoded.binary) {
        throw new JesutobitsError(ErrorCodes.fsBinary, `${display(relative)} is not a text file`, {
          details: { path: relative },
        });
      }
      format = decoded.format;
    }
    const bytes = encodeText(text, format);
    try {
      await mkdir(path.dirname(resolved.real), { recursive: true });
      await writeFileAtomic(resolved.real, bytes);
    } catch (error) {
      throw fsError(error, relative);
    }
    const changeCounter = ++this.counter;
    this.log.debug("file written", { path: relative, bytes: bytes.length, changeCounter });
    return { path: relative, hash: hashBytes(bytes), size: bytes.length, changeCounter };
  }

  /** Creates a folder and any missing parents; fails if a file is in the way. */
  async createDirectory(input: string): Promise<void> {
    const resolved = await this.resolve(input);
    try {
      await mkdir(resolved.real, { recursive: true });
    } catch (error) {
      throw fsError(error, resolved.relative);
    }
    this.counter++;
  }

  /** Renames or moves within the workspace; never replaces an existing target. */
  async rename(from: string, to: string): Promise<void> {
    const source = await this.resolve(from);
    const target = await this.resolve(to);
    if (source.relative === "") {
      throw new JesutobitsError(
        ErrorCodes.fsInvalidPath,
        "The project folder cannot be renamed here",
        {
          details: { path: "" },
        },
      );
    }
    // Case-only renames (a.ts -> A.ts) name the same file on Windows and macOS only; on
    // Linux they are two files and the target must not be replaced.
    const sameFile = CASE_INSENSITIVE && source.real.toLowerCase() === target.real.toLowerCase();
    if (!sameFile && (await exists(target.real))) {
      throw new JesutobitsError(
        ErrorCodes.fsAlreadyExists,
        `${display(target.relative)} already exists`,
        {
          details: { path: target.relative },
        },
      );
    }
    // The requested name, not target.real's: for a case-only rename, realpath finds the
    // existing file under its old case.
    const destination = path.join(path.dirname(target.real), path.basename(target.absolute));
    try {
      await lstat(source.absolute);
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(source.absolute, destination);
    } catch (error) {
      throw fsError(error, source.relative);
    }
    this.counter++;
    // A move can change what a path points at (SECURITY.md section 5.2, rule 5).
    await this.resolve(to);
  }

  private async readBytes(resolved: ResolvedPath, maxBytes: number): Promise<Buffer> {
    let info;
    try {
      info = await stat(resolved.real);
    } catch (error) {
      throw fsError(error, resolved.relative);
    }
    if (!info.isFile()) {
      throw new JesutobitsError(
        ErrorCodes.fsNotAFile,
        `${display(resolved.relative)} is not a file`,
        {
          details: { path: resolved.relative },
        },
      );
    }
    if (info.size > maxBytes) {
      throw new JesutobitsError(
        ErrorCodes.fsTooLarge,
        `${display(resolved.relative)} is too large to open (${info.size} bytes)`,
        { details: { path: resolved.relative, size: info.size, maxBytes } },
      );
    }
    try {
      return await readFile(resolved.real);
    } catch (error) {
      throw fsError(error, resolved.relative);
    }
  }

  private async readExisting(resolved: ResolvedPath): Promise<{ bytes: Buffer } | undefined> {
    try {
      const info = await stat(resolved.real);
      if (!info.isFile()) {
        throw new JesutobitsError(
          ErrorCodes.fsNotAFile,
          `${display(resolved.relative)} is not a file`,
          {
            details: { path: resolved.relative },
          },
        );
      }
      return { bytes: await readFile(resolved.real) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw fsError(error, resolved.relative);
    }
  }

  private async followLink(linkPath: string): Promise<{ kind: EntryKind; outside: boolean }> {
    try {
      const target = await realpath(linkPath);
      const info = await stat(target);
      // Resolving through the guard keeps one definition of "inside".
      const outside = await this.guard.resolve(target).then(
        () => false,
        () => true,
      );
      return { kind: kindOf(info), outside };
    } catch {
      // Dangling link: nothing to open.
      return { kind: "other", outside: false };
    }
  }
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function kindOf(info: { isFile(): boolean; isDirectory(): boolean }): EntryKind {
  return info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareEntries(a: DirEntry, b: DirEntry): number {
  const rank = (entry: DirEntry) => (entry.kind === "directory" ? 0 : 1);
  return rank(a) - rank(b) || collator.compare(a.name, b.name) || a.name.localeCompare(b.name);
}

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    () => false,
  );
}
