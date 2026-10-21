import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, stat } from "node:fs/promises";
import path from "node:path";
import { ErrorCodes, JesutobitsError } from "@jesutobits/protocol";
import type { Logger } from "@jesutobits/shared";
import { isAtomicTemp, writeFileAtomic } from "./atomic-write.js";
import { display, fsError } from "./errors.js";
import {
  isNoisy,
  nodeRawWatch,
  type ChangeBatch,
  type FileChange,
  type WatchHandle,
  type WatchOptions,
} from "./file-watcher.js";
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
  /**
   * Moves an absolute, already confined path to the OS trash. The runtime passes the Host's
   * `host.fs.trash` (ADR-0014); without it, `trash` fails with `fs.trash_failed`.
   */
  trash?: (absolutePath: string) => Promise<void>;
}

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

/** Larger text files are refused rather than read whole. */
export const DEFAULT_MAX_TEXT_BYTES = 5 * 1024 * 1024;
/** How long a change this service made is recognised in watcher events as its own. */
const SELF_MARK_MS = 2000;
const IGNORE_FILES = new Set([".gitignore", ".jesutobitsignore"]);

/** What this service last did to a path, so the watcher can tell its own changes apart. */
type SelfMark = { size: number; mtimeMs: number } | "removed" | "directory";

/**
 * The only way to the project's files (invariant 2): every path is confined by the
 * `PathGuard`, writes are atomic and keep line endings and the BOM, and each write bumps
 * `changeCounter`, which the verification ledger uses for freshness (AGENT_HARNESS.md
 * section 6). The watcher (`noteExternalChange`) bumps it for changes made elsewhere.
 */
export class WorkspaceService {
  private counter = 0;
  private readonly selfMarks = new Map<string, { mark: SelfMark; expires: number }>();
  /** Changes this service has started but not yet marked: the watcher waits for them. */
  private readonly pendingSelf = new Map<string, Promise<void>>();
  readonly ignores: IgnoreRules;

  private constructor(
    private readonly guard: PathGuard,
    private readonly log: Logger,
    private readonly trashPath: ((absolutePath: string) => Promise<void>) | undefined,
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
    return new WorkspaceService(guard, options.log.child({ module: "workspace" }), options.trash);
  }

  get root(): string {
    return this.guard.projectRoot;
  }

  /** The project root with links resolved. */
  get realRoot(): string {
    return this.guard.projectRootReal;
  }

  /**
   * Watches the project and reports changes in batches every 100 ms (AGENT_HARNESS.md
   * section 6). Each batch advances `changeCounter` once if anything changed that this
   * service did not do itself. Batches are delivered in order.
   */
  watch(onBatch: (batch: ChangeBatch) => void, options: WatchOptions = {}): WatchHandle {
    const intervalMs = options.intervalMs ?? 100;
    const maxChanges = options.maxChanges ?? 1000;
    const pending = new Set<string>();
    let overflow = false;
    let noisy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let delivery = Promise.resolve();

    const flush = async (): Promise<void> => {
      const paths = [...pending];
      const wasOverflow = overflow;
      const wasNoisy = noisy;
      pending.clear();
      overflow = false;
      noisy = false;

      const changes: FileChange[] = [];
      if (wasOverflow) this.ignores.clear();
      else for (const relative of paths) changes.push(await this.classify(relative));
      for (const change of changes) {
        const name = path.posix.basename(change.path);
        if (IGNORE_FILES.has(name))
          this.ignores.invalidate(path.posix.dirname(change.path).replace(/^\.$/, ""));
      }
      if (wasOverflow || wasNoisy || changes.some((change) => !change.self)) this.counter++;
      if (closed || (changes.length === 0 && !wasOverflow)) return;
      onBatch({ changes, overflow: wasOverflow, changeCounter: this.counter });
    };
    const schedule = (): void => {
      timer ??= setTimeout(() => {
        timer = undefined;
        delivery = delivery.then(flush).catch((error: unknown) => {
          this.log.error("could not report file changes", { err: error });
        });
      }, intervalMs);
    };

    const raw = (options.rawWatch ?? nodeRawWatch)(
      this.guard.projectRootReal,
      (name) => {
        if (closed) return;
        if (name === null) {
          overflow = true;
        } else {
          const relative = name.replaceAll("\\", "/");
          if (isAtomicTemp(relative)) return;
          if (isNoisy(relative)) {
            noisy = true;
          } else {
            pending.add(relative);
            if (pending.size > maxChanges) {
              overflow = true;
              pending.clear();
            }
          }
        }
        schedule();
      },
      (error) => {
        this.log.warn("the file watcher stopped", { err: error });
        options.onError?.(error);
      },
    );
    return {
      close: () => {
        closed = true;
        if (timer) clearTimeout(timer);
        raw.close();
      },
    };
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
    await this.ownChange([relative], async () => {
      try {
        await mkdir(path.dirname(resolved.real), { recursive: true });
        await writeFileAtomic(resolved.real, bytes);
      } catch (error) {
        throw fsError(error, relative);
      }
      await this.markSelf(relative, resolved.real);
    });
    const changeCounter = ++this.counter;
    this.log.debug("file written", { path: relative, bytes: bytes.length, changeCounter });
    return { path: relative, hash: hashBytes(bytes), size: bytes.length, changeCounter };
  }

  /** Creates a folder and any missing parents; fails if a file is in the way. */
  async createDirectory(input: string): Promise<void> {
    const resolved = await this.resolve(input);
    await this.ownChange([resolved.relative], async () => {
      try {
        await mkdir(resolved.real, { recursive: true });
      } catch (error) {
        throw fsError(error, resolved.relative);
      }
      await this.markSelf(resolved.relative, resolved.real);
    });
    this.counter++;
  }

  /**
   * Moves a file or folder to the OS trash (FR-072, ADR-0014). The path is confined first;
   * the project folder itself cannot be trashed. A link is trashed, not what it points to.
   */
  async trash(input: string): Promise<void> {
    const resolved = await this.resolve(input);
    if (resolved.relative === "") {
      throw new JesutobitsError(
        ErrorCodes.fsInvalidPath,
        "The project folder cannot be moved to the trash",
        {
          details: { path: "" },
        },
      );
    }
    try {
      await lstat(resolved.absolute);
    } catch (error) {
      throw fsError(error, resolved.relative);
    }
    if (!this.trashPath) {
      throw new JesutobitsError(
        ErrorCodes.fsTrashFailed,
        "Moving files to the trash is not available here",
        {
          details: { path: resolved.relative },
        },
      );
    }
    const trashPath = this.trashPath;
    await this.ownChange([resolved.relative], async () => {
      try {
        await trashPath(resolved.absolute);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new JesutobitsError(
          ErrorCodes.fsTrashFailed,
          `${display(resolved.relative)} could not be moved to the trash`,
          { details: { path: resolved.relative, reason } },
        );
      }
      await this.markSelf(resolved.relative, resolved.absolute, true);
    });
    this.counter++;
    this.log.info("moved to the trash", { path: resolved.relative });
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
    await this.ownChange([source.relative, target.relative], async () => {
      try {
        await lstat(source.absolute);
        await mkdir(path.dirname(destination), { recursive: true });
        await rename(source.absolute, destination);
      } catch (error) {
        throw fsError(error, source.relative);
      }
      if (!sameFile) await this.markSelf(source.relative, source.real, true);
      await this.markSelf(target.relative, destination);
    });
    this.counter++;
    // A move can change what a path points at (SECURITY.md section 5.2, rule 5).
    await this.resolve(to);
  }

  /**
   * Runs a change this service makes. Until it is done and marked, the watcher waits before
   * judging these paths: under load, the OS event can arrive before the mark is recorded.
   */
  private async ownChange<T>(paths: readonly string[], work: () => Promise<T>): Promise<T> {
    let done: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    for (const relative of paths) this.pendingSelf.set(relative, finished);
    try {
      return await work();
    } finally {
      done();
      for (const relative of paths) {
        if (this.pendingSelf.get(relative) === finished) this.pendingSelf.delete(relative);
      }
    }
  }

  private async markSelf(relative: string, real: string, removed = false): Promise<void> {
    let mark: SelfMark = "removed";
    if (!removed) {
      const info = await stat(real).catch(() => undefined);
      if (!info) return;
      mark = info.isDirectory() ? "directory" : { size: info.size, mtimeMs: info.mtimeMs };
    }
    this.selfMarks.set(relative, { mark, expires: Date.now() + SELF_MARK_MS });
  }

  /** Looks at a changed path now: whether it exists, and whether this service changed it. */
  private async classify(relative: string): Promise<FileChange> {
    await this.pendingSelf.get(relative);
    const now = Date.now();
    for (const [key, entry] of this.selfMarks) {
      if (entry.expires < now) this.selfMarks.delete(key);
    }
    const mark = this.selfMarks.get(relative)?.mark;
    const info = await stat(path.join(this.guard.projectRootReal, ...relative.split("/"))).catch(
      () => undefined,
    );
    if (!info)
      return { path: relative, kind: "removed", isDirectory: false, self: mark === "removed" };
    const isDirectory = info.isDirectory();
    const self =
      mark === "directory"
        ? isDirectory
        : typeof mark === "object" && mark.size === info.size && mark.mtimeMs === info.mtimeMs;
    return { path: relative, kind: "upsert", isDirectory, self };
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
