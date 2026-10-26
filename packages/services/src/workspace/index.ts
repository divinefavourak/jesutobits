export { canonicalProjectPath } from "./canonical-path.js";
export { FileIndex, type IndexOptions, type QuickOpenResult } from "./file-index.js";
export {
  isNoisy,
  nodeRawWatch,
  type ChangeBatch,
  type ChangeKind,
  type FileChange,
  type RawWatch,
  type WatchHandle,
  type WatchOptions,
} from "./file-watcher.js";
export { IgnoreRules } from "./ignore-rules.js";
export {
  createProjectFolder,
  folderExists,
  prepareWorkspaceFolder,
  type ProjectTemplate,
} from "./project-folder.js";
export { PathGuard, type ResolvedPath } from "./path-guard.js";
export type { LineEndings, TextFormat } from "./text.js";
export {
  DEFAULT_MAX_TEXT_BYTES,
  hashBytes,
  MAX_SNAPSHOT_BYTES,
  WorkspaceService,
  type DirEntry,
  type EntryKind,
  type FileStat,
  type Snapshot,
  type TextFile,
  type WorkspaceServiceOptions,
  type WriteOptions,
  type WriteResult,
} from "./workspace-service.js";
