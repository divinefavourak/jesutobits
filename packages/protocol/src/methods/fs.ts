import { z } from "zod";
import { defineMethod } from "./define.js";

/**
 * Largest file `fs.readFile` returns. Every message must stay under MAX_MESSAGE_BYTES
 * (4 MiB) after JSON escaping, so larger files are refused with `fs.too_large` until paged
 * reads exist.
 */
export const MAX_EDITOR_FILE_BYTES = 2 * 1024 * 1024;

/** Project-relative, `/` separated; "" is the project folder. */
const RelativePathSchema = z.string().max(4096);
const HashSchema = z.string().regex(/^[0-9a-f]{64}$/, "Expected a SHA-256 hex digest");

export const EntryKindSchema = z.enum(["file", "directory", "other"]);

export const DirEntrySchema = z.object({
  name: z.string(),
  path: RelativePathSchema,
  kind: EntryKindSchema,
  link: z.boolean(),
  outside: z.boolean(),
  ignored: z.boolean(),
});
export type DirEntry = z.infer<typeof DirEntrySchema>;

export const TextFormatSchema = z.object({
  bom: z.boolean(),
  eol: z.enum(["lf", "crlf", "mixed", "none"]),
});

export const fsListDir = defineMethod({
  name: "fs.listDir",
  description: "One folder of the active project; the explorer loads lazily (NFR-019).",
  callers: ["workbench"],
  params: z.object({ path: RelativePathSchema }),
  result: z.object({ entries: z.array(DirEntrySchema) }),
});

export const fsStat = defineMethod({
  name: "fs.stat",
  description: "Kind, size and modification time of a project path.",
  callers: ["workbench"],
  params: z.object({ path: RelativePathSchema }),
  result: z.object({
    path: RelativePathSchema,
    kind: EntryKindSchema,
    size: z.number().int().nonnegative(),
    mtimeMs: z.number(),
  }),
});

export const fsReadFile = defineMethod({
  name: "fs.readFile",
  description: "A text file with its hash for conflict detection (fs.binary, fs.too_large).",
  callers: ["workbench"],
  params: z.object({ path: RelativePathSchema }),
  result: z.object({
    path: RelativePathSchema,
    text: z.string(),
    /** Send back as `expectedHash` when saving. */
    hash: HashSchema,
    size: z.number().int().nonnegative(),
    format: TextFormatSchema,
  }),
});

const WriteResultSchema = z.object({
  path: RelativePathSchema,
  hash: HashSchema,
  size: z.number().int().nonnegative(),
  changeCounter: z.number().int().nonnegative(),
});

/**
 * Saves a text file atomically through WorkspaceService. `expectedHash` is required: the
 * hash last read (a changed file fails with `fs.conflict`, FR-052), or null for a file that
 * must not exist yet.
 */
export const fsWriteFile = defineMethod({
  name: "fs.writeFile",
  description: "Save a text file, refusing if it changed on disk since it was read.",
  callers: ["workbench"],
  params: z.object({
    path: RelativePathSchema.min(1),
    text: z.string(),
    expectedHash: HashSchema.nullable(),
  }),
  result: WriteResultSchema,
});

export const fsCreateFile = defineMethod({
  name: "fs.createFile",
  description: "Create an empty file; fails if it exists.",
  callers: ["workbench"],
  params: z.object({ path: RelativePathSchema.min(1) }),
  result: WriteResultSchema,
});

export const fsCreateDirectory = defineMethod({
  name: "fs.createDirectory",
  description: "Create a folder and any missing parents.",
  callers: ["workbench"],
  params: z.object({ path: RelativePathSchema.min(1) }),
  result: z.object({}),
});

export const fsRename = defineMethod({
  name: "fs.rename",
  description: "Rename or move within the project; never replaces an existing target.",
  callers: ["workbench"],
  params: z.object({ from: RelativePathSchema.min(1), to: RelativePathSchema.min(1) }),
  result: z.object({}),
});

export const fsQuickOpen = defineMethod({
  name: "fs.quickOpen",
  description: "Fuzzy file search for quick open (Ctrl+P), recent files boosted.",
  callers: ["workbench"],
  params: z.object({
    query: z.string().max(256),
    limit: z.number().int().min(1).max(200).default(50),
    /** Recently opened files, most recent first. */
    recent: z.array(RelativePathSchema).max(50).default([]),
  }),
  result: z.object({
    results: z.array(
      z.object({
        path: RelativePathSchema,
        score: z.number(),
        positions: z.array(z.number().int().nonnegative()),
      }),
    ),
    /** The first index build is still running; results may be partial. */
    indexing: z.boolean(),
    /** False when the project has more files than the index keeps. */
    complete: z.boolean(),
  }),
});

/**
 * Project text search (FR-074): ripgrep (the one VS Code ships, ADR-0015), or a
 * slower scan without it. Ignored files are not searched. Results arrive in one reply,
 * capped by `limit`.
 */
export const fsSearch = defineMethod({
  name: "fs.search",
  description: "Search file contents in the active project.",
  callers: ["workbench"],
  params: z.object({
    query: z.string().min(1).max(1000),
    isRegex: z.boolean().default(false),
    caseSensitive: z.boolean().default(false),
    /** Only paths matching this glob, in ripgrep's `--glob` syntax. */
    glob: z.string().min(1).max(500).optional(),
    limit: z.number().int().min(1).max(2000).default(500),
  }),
  result: z.object({
    matches: z.array(
      z.object({
        path: RelativePathSchema,
        /** From 1. */
        line: z.number().int().positive(),
        /** From 1, in characters. */
        column: z.number().int().positive(),
        /** The line, shortened to 300 characters. */
        text: z.string(),
      }),
    ),
    /** More matches exist than `limit`. */
    truncated: z.boolean(),
    engine: z.enum(["ripgrep", "fallback"]),
  }),
});

/**
 * Moves a file or folder to the OS trash (FR-072). The runtime confines the path, then asks
 * the Host to do it (ADR-0014). Fails with `fs.trash_failed` when the OS refuses, for example
 * on a drive without a Recycle Bin; the file is then left where it is.
 */
export const fsTrash = defineMethod({
  name: "fs.trash",
  description: "Move a file or folder in the project to the OS trash.",
  callers: ["workbench"],
  params: z.object({ path: RelativePathSchema.min(1) }),
  result: z.object({}),
});

/**
 * Shows a file or folder in the OS file manager (FR-072 "Reveal in OS"). Like `fs.trash`, the
 * runtime confines the path and the Host acts (ADR-0014).
 */
export const fsReveal = defineMethod({
  name: "fs.reveal",
  description: "Show a project file or folder in the OS file manager.",
  callers: ["workbench"],
  params: z.object({ path: RelativePathSchema }),
  result: z.object({}),
});
