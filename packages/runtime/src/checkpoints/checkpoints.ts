import type { FileChange } from "@jesutobits/protocol";
import type { WorkspaceService } from "@jesutobits/services";
import { countLineChanges, newId } from "@jesutobits/shared";
import type { BlobStore } from "../storage/blob-store.js";
import type { Database } from "../storage/database.js";

interface Row {
  id: string;
  path: string;
  before_hash: string | null;
  after_hash: string | null;
  created_at: string;
}

export interface CheckpointFile extends FileChange {
  /** The file is as the turn left it, so restoring it loses nobody's later change. */
  unchangedSince: boolean;
}

export interface RevertOutcome {
  restored: string[];
  /** Changed since the turn and not forced: left alone. */
  conflicts: string[];
}

/**
 * Tool-level checkpoints (ADR-0012): before a turn first changes a file, its exact bytes
 * (or "did not exist") are kept as a blob and a row `{turn, path, before, after}`. Reverting
 * restores the pre-image byte for byte, but only where the file is still as the turn left
 * it, unless the caller forces it.
 */
export class Checkpoints {
  constructor(
    private readonly db: Database,
    private readonly blobs: BlobStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Keeps the pre-image of `input` before the turn changes it. Only the first call per
   * turn and path stores anything, so the pre-image is how the file was before the turn.
   * Returns the project-relative path the row is keyed by.
   */
  async before(
    workspace: WorkspaceService,
    projectId: string,
    turnId: string,
    input: string,
  ): Promise<string> {
    const { relative } = await workspace.resolve(input);
    if (this.row(turnId, relative)) return relative;
    const snapshot = await workspace.snapshot(relative);
    // The blob first: a row never points at a missing blob.
    const beforeHash = snapshot ? this.blobs.put(snapshot.bytes) : null;
    this.db.run(
      `INSERT INTO checkpoints (id, project_id, owner_id, kind, path, before_hash, after_hash, created_at)
       VALUES (?, ?, ?, 'tool', ?, ?, ?, ?)`,
      [newId("ckp"), projectId, turnId, relative, beforeHash, beforeHash, this.now().toISOString()],
    );
    return relative;
  }

  /**
   * Records how the turn left the file: the SHA-256 of its new bytes (which the caller
   * passes, so no second read is needed), or null when it was removed. The new content is
   * kept as a blob too when given, so diffs can be shown later.
   */
  after(turnId: string, relative: string, after: { bytes: Uint8Array } | null): void {
    const hash = after ? this.blobs.put(after.bytes) : null;
    this.db.run("UPDATE checkpoints SET after_hash = ? WHERE owner_id = ? AND path = ?", [
      hash,
      turnId,
      relative,
    ]);
  }

  /** The turn's files in the order it first changed them. */
  async list(workspace: WorkspaceService, turnId: string): Promise<CheckpointFile[]> {
    const files: CheckpointFile[] = [];
    for (const row of this.rows(turnId)) {
      if (row.before_hash === row.after_hash) continue;
      const current = await workspace.snapshot(row.path).catch(() => undefined);
      files.push({
        ...this.change(row),
        unchangedSince: current !== undefined && (current?.hash ?? null) === row.after_hash,
      });
    }
    return files;
  }

  /** FileChange for each file the turn changed (for the turn summary). */
  changes(turnId: string): FileChange[] {
    return this.rows(turnId)
      .filter((row) => row.before_hash !== row.after_hash)
      .map((row) => this.change(row));
  }

  /**
   * Restores the turn's files (or only `paths`). A file changed since the turn is a
   * conflict unless its path is in `force`. Restored rows then record the pre-image as the
   * current state, so reverting twice changes nothing.
   */
  async revert(
    workspace: WorkspaceService,
    turnId: string,
    options: { paths?: readonly string[]; force?: readonly string[] } = {},
  ): Promise<RevertOutcome> {
    const outcome: RevertOutcome = { restored: [], conflicts: [] };
    const only = options.paths && new Set(options.paths);
    const force = new Set(options.force ?? []);
    for (const row of this.rows(turnId)) {
      if (only && !only.has(row.path)) continue;
      if (row.before_hash === row.after_hash) continue;
      const current = await workspace.snapshot(row.path);
      if ((current?.hash ?? null) !== row.after_hash && !force.has(row.path)) {
        outcome.conflicts.push(row.path);
        continue;
      }
      if (row.before_hash === null) {
        if (current) await workspace.remove(row.path);
      } else {
        const bytes = this.blobs.get(row.before_hash);
        if (!bytes) {
          // Should not happen (blobs are written first); reported, never guessed.
          outcome.conflicts.push(row.path);
          continue;
        }
        await workspace.writeBytes(row.path, bytes);
      }
      this.db.run("UPDATE checkpoints SET after_hash = before_hash WHERE id = ?", [row.id]);
      outcome.restored.push(row.path);
    }
    return outcome;
  }

  /** Startup sweep (DATA_AND_PERSISTENCE.md 6.3): blobs no row refers to are removed. */
  sweep(): number {
    const keep = new Set<string>();
    for (const row of this.db.all<{ hash: string | null }>(
      "SELECT before_hash AS hash FROM checkpoints UNION SELECT after_hash FROM checkpoints",
    )) {
      if (row.hash) keep.add(row.hash);
    }
    return this.blobs.sweep(keep);
  }

  private rows(turnId: string): Row[] {
    return this.db.all<Row>(
      "SELECT id, path, before_hash, after_hash, created_at FROM checkpoints WHERE owner_id = ? ORDER BY created_at, rowid",
      [turnId],
    );
  }

  private row(turnId: string, relative: string): Row | undefined {
    return this.db.get<Row>(
      "SELECT id, path, before_hash, after_hash, created_at FROM checkpoints WHERE owner_id = ? AND path = ?",
      [turnId, relative],
    );
  }

  private change(row: Row): FileChange {
    const text = (hash: string | null) => {
      if (hash === null) return "";
      const bytes = this.blobs.get(hash);
      // Binary content has no lines worth counting.
      return bytes && !bytes.includes(0) ? bytes.toString("utf8") : "";
    };
    const counts = countLineChanges(text(row.before_hash), text(row.after_hash));
    const change =
      row.before_hash === null ? "created" : row.after_hash === null ? "deleted" : "modified";
    return { path: row.path, change, added: counts.added, removed: counts.removed };
  }
}
