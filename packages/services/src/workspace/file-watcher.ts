import { watch } from "node:fs";

export type ChangeKind = "upsert" | "removed";

export interface FileChange {
  /** Relative to the project root, `/` separated. */
  path: string;
  /** Exists now (created or modified), or is gone. The OS events cannot tell more reliably. */
  kind: ChangeKind;
  isDirectory: boolean;
  /** Made by this WorkspaceService (an editor save, a tool write), not by someone else. */
  self: boolean;
}

export interface ChangeBatch {
  changes: FileChange[];
  /** Too many changes, or the OS lost track: callers should reload what they show. */
  overflow: boolean;
  /** `WorkspaceService.changeCounter` after this batch. */
  changeCounter: number;
}

export interface WatchHandle {
  close(): void;
}

export interface WatchOptions {
  /** Called on watcher errors, for example when the project folder is deleted. */
  onError?: (error: unknown) => void;
  /** Batching window (AGENT_HARNESS.md section 6: 100 ms). */
  intervalMs?: number;
  /** More changes than this in one window become one `overflow` batch. */
  maxChanges?: number;
  /** The OS watch; tests replace it to send exact events. */
  rawWatch?: RawWatch;
}

/** Calls `onPath` with root-relative names as the OS reports them; null when unknown. */
export type RawWatch = (
  root: string,
  onPath: (relative: string | null) => void,
  onError: (error: unknown) => void,
) => WatchHandle;

/**
 * Recursive `fs.watch`. Reliable on Windows and macOS; on Linux, Node watches each folder
 * with inotify, so very large trees can reach the system's watch limit (the watcher then
 * reports an error and the explorer falls back to manual refresh).
 */
export const nodeRawWatch: RawWatch = (root, onPath, onError) => {
  const watcher = watch(root, { recursive: true }, (_event, filename) =>
    onPath(filename === null ? null : String(filename)),
  );
  watcher.on("error", onError);
  return { close: () => watcher.close() };
};

/**
 * Folders whose churn is never reported path by path: Git's internals change on every
 * command, and an install rewrites thousands of files in node_modules. Changes there still
 * advance the change counter.
 */
export function isNoisy(relative: string): boolean {
  const names = relative.split("/");
  return names[0] === ".git" || names.includes("node_modules");
}
