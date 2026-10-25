import { readdir } from "node:fs/promises";
import path from "node:path";
import { fuzzyFilter, type Logger } from "@jesutobits/shared";
import type { ChangeBatch } from "./file-watcher.js";
import type { WorkspaceService } from "./workspace-service.js";

export interface IndexOptions {
  /** Stop indexing beyond this many files; `complete` is then false. */
  maxFiles?: number;
  /** Folders read between yields to the event loop, so the runtime stays responsive. */
  foldersPerYield?: number;
}

export interface QuickOpenResult {
  path: string;
  score: number;
  /** Matched character positions in `path`, for highlighting. */
  positions: number[];
}

const DEFAULT_MAX_FILES = 250_000;

/**
 * The file list behind quick open (FR-074, UX_AND_INTERFACE.md section 5.3). Built by an
 * asynchronous walk that skips ignored folders without entering them and yields to the
 * event loop, so a 100,000-file project never blocks the runtime (NFR-019). Links are not
 * followed. Kept current from watcher batches.
 */
export class FileIndex {
  private readonly files = new Set<string>();
  private truncated = false;
  private building: Promise<void> = Promise.resolve();
  private generation = 0;

  private constructor(
    private readonly workspace: WorkspaceService,
    private readonly log: Logger,
    private readonly options: Required<IndexOptions>,
  ) {}

  /** Starts building at once; `ready` resolves when the first walk is done. */
  static build(workspace: WorkspaceService, log: Logger, options: IndexOptions = {}): FileIndex {
    const index = new FileIndex(workspace, log.child({ module: "file-index" }), {
      maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
      foldersPerYield: options.foldersPerYield ?? 32,
    });
    index.rebuild();
    return index;
  }

  get ready(): Promise<void> {
    return this.building;
  }

  get size(): number {
    return this.files.size;
  }

  /** False when the walk stopped at `maxFiles`. */
  get complete(): boolean {
    return !this.truncated;
  }

  has(relative: string): boolean {
    return this.files.has(relative);
  }

  /**
   * The best matches for `text`. An empty query lists `recent` files first. Recent files
   * also get a boost, the most recent the most.
   */
  query(text: string, limit: number, recent: readonly string[] = []): QuickOpenResult[] {
    const boost = new Map(recent.map((file, index) => [file, Math.max(1, 10 - index)]));
    if (text === "") {
      const ordered = [
        ...recent.filter((file) => this.files.has(file)),
        ...[...this.files].filter((file) => !boost.has(file)).sort(),
      ];
      return ordered.slice(0, limit).map((file) => ({ path: file, score: 0, positions: [] }));
    }
    // Score everything, add the boost, then cut: a boosted file can climb into the list.
    return fuzzyFilter(text, this.files, (file) => file, Number.POSITIVE_INFINITY)
      .map(({ item, score, positions }) => ({
        path: item,
        score: score + (boost.get(item) ?? 0),
        positions,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Applies a watcher batch: adds new files, walks new folders, drops removed ones. */
  async apply(batch: ChangeBatch): Promise<void> {
    if (batch.overflow) {
      this.rebuild();
      return this.building;
    }
    for (const change of batch.changes) {
      if (change.kind === "removed") {
        this.files.delete(change.path);
        const prefix = `${change.path}/`;
        for (const file of this.files) if (file.startsWith(prefix)) this.files.delete(file);
      } else if (change.isDirectory) {
        if (!(await this.workspace.ignores.isIgnored(change.path, true))) {
          await this.walk(change.path, this.generation);
        }
      } else if (!(await this.workspace.ignores.isIgnored(change.path, false))) {
        this.add(change.path);
      }
    }
  }

  /** Starts over, abandoning any walk in progress. */
  rebuild(): void {
    const generation = ++this.generation;
    this.files.clear();
    this.truncated = false;
    const started = performance.now();
    this.building = this.walk("", generation).then(
      () => {
        if (generation !== this.generation) return;
        this.log.info("file index built", {
          files: this.files.size,
          complete: !this.truncated,
          ms: Math.round(performance.now() - started),
        });
      },
      (error: unknown) => this.log.error("could not build the file index", { err: error }),
    );
  }

  private add(relative: string): void {
    if (this.files.size >= this.options.maxFiles) {
      this.truncated = true;
      return;
    }
    this.files.add(relative);
  }

  private async walk(start: string, generation: number): Promise<void> {
    const queue = [start];
    let since = 0;
    while (queue.length > 0 && generation === this.generation && !this.truncated) {
      const folder = queue.shift() as string;
      let entries;
      try {
        entries = await readdir(path.join(this.workspace.realRoot, ...folder.split("/")), {
          withFileTypes: true,
        });
      } catch {
        continue; // Removed or unreadable meanwhile.
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const relative = folder === "" ? entry.name : `${folder}/${entry.name}`;
        const isDirectory = entry.isDirectory();
        if (!isDirectory && !entry.isFile()) continue;
        if (await this.workspace.ignores.isIgnored(relative, isDirectory)) continue;
        if (isDirectory) queue.push(relative);
        else this.add(relative);
      }
      if (++since >= this.options.foldersPerYield) {
        since = 0;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }
}
