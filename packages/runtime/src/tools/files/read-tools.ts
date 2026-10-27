import { ErrorCodes, isJesutobitsError } from "@jesutobits/protocol";
import { globToRegExp } from "@jesutobits/shared";
import { z } from "zod";
import {
  holdsAuthToken,
  hideValues,
  isSecretPatternFile,
} from "../../permissions/secret-patterns.js";
import { checkPath, errorResult } from "../common/paths.js";
import {
  toolError,
  type RiskAssessment,
  type ToolContext,
  type ToolDefinition,
} from "../common/types.js";

/** read_file refuses larger files (AGENT_HARNESS.md section 5.3). */
export const MAX_READ_BYTES = 2 * 1024 * 1024;
const DEFAULT_READ_LINES = 400;
const MAX_READ_LINES = 2000;
const MAX_LIST_ENTRIES = 500;
const FILE_TOOL_TIMEOUT_MS = 30_000;

const PathSchema = z.string().min(1).max(1024).describe("Project-relative path, using /");

/** One path, classified as a read; a secret-pattern file asks first (SECURITY.md 6.2). */
async function classifyRead(
  ctx: ToolContext,
  path: string,
  checkContent: boolean,
): Promise<RiskAssessment> {
  const check = await checkPath(ctx, path, "read");
  // .npmrc and .yarnrc.yml are secret only when they hold a token: look before deciding.
  if (checkContent && check.classes.includes("sensitive_read") && !check.prohibited) {
    const name = check.relative.split("/").pop() ?? "";
    if (name === ".npmrc" || name === ".yarnrc.yml") {
      const text = await ctx.workspace
        .readText(check.relative, MAX_READ_BYTES)
        .then((file) => file.text)
        .catch(() => undefined);
      if (text !== undefined && !holdsAuthToken(text)) {
        check.classes = check.classes.filter((risk) => risk !== "sensitive_read");
      }
    }
  }
  return {
    classes: check.classes,
    action: { kind: "file", op: "read", paths: [check.relative] },
    ...(check.prohibited !== undefined && { prohibited: check.prohibited }),
  };
}

const ListInput = z.object({
  path: PathSchema.default("."),
  depth: z.number().int().min(1).max(3).default(1),
  includeIgnored: z.boolean().default(false),
});

export const listDirectory: ToolDefinition<z.output<typeof ListInput>> = {
  name: "list_directory",
  description:
    "List a folder's entries with their type and size, up to 3 levels deep. Ignored folders (node_modules, build output, .gitignore matches) are shown but not entered. Use search_files to find files by name across the project instead of listing folder by folder.",
  input: ListInput,
  timeoutMs: FILE_TOOL_TIMEOUT_MS,
  activity: "reading",
  classify: async (input, ctx) => {
    const check = await checkPath(ctx, input.path, "read");
    return {
      classes: check.classes,
      action: { kind: "file", op: "read", paths: [check.relative || "."] },
      ...(check.prohibited !== undefined && { prohibited: check.prohibited }),
    };
  },
  async execute(input, ctx, signal) {
    const lines: string[] = [];
    let shown = 0;
    let more = false;
    const walk = async (folder: string, level: number): Promise<void> => {
      for (const entry of await ctx.workspace.listDir(folder)) {
        signal.throwIfAborted();
        if (shown >= MAX_LIST_ENTRIES) {
          more = true;
          return;
        }
        if (entry.ignored && !input.includeIgnored && entry.kind !== "directory") continue;
        const indent = "  ".repeat(level - 1);
        shown++;
        if (entry.kind === "directory") {
          const note = entry.ignored
            ? " (ignored, not listed)"
            : entry.outside
              ? " (link outside the project, not followed)"
              : "";
          lines.push(`${indent}${entry.name}/${note}`);
          if (level < input.depth && !(entry.ignored && !input.includeIgnored) && !entry.outside) {
            await walk(entry.path, level + 1);
          }
        } else {
          const size = await ctx.workspace
            .stat(entry.path)
            .then((info) => ` (${info.size} bytes)`)
            .catch(() => "");
          lines.push(`${indent}${entry.name}${entry.kind === "other" ? " (other)" : size}`);
        }
      }
    };
    try {
      await walk(input.path, 1);
    } catch (error) {
      if (signal.aborted) throw error;
      return errorResult(error);
    }
    if (more)
      lines.push(`... more entries not shown (limit ${MAX_LIST_ENTRIES}); list a subfolder`);
    const text = lines.length > 0 ? lines.join("\n") : "(empty folder)";
    return { ok: true, modelText: text, outputPreview: `${shown} entries` };
  },
  summarize: (input, result) =>
    result?.ok ? `Listed ${input.path} (${result.outputPreview ?? ""})` : `Listing ${input.path}`,
};

const ReadInput = z.object({
  path: PathSchema,
  offset: z.number().int().min(1).optional().describe("First line to show, from 1"),
  limit: z.number().int().min(1).max(MAX_READ_LINES).default(DEFAULT_READ_LINES),
});

export const readFile: ToolDefinition<z.output<typeof ReadInput>> = {
  name: "read_file",
  description: `Read a text file with line numbers (${DEFAULT_READ_LINES} lines by default, up to ${MAX_READ_LINES}; use offset for more). Read a file before editing it: edits are refused if the file changed since your last read. Binary files return only their size.`,
  input: ReadInput,
  timeoutMs: FILE_TOOL_TIMEOUT_MS,
  activity: "reading",
  classify: (input, ctx) => classifyRead(ctx, input.path, true),
  async execute(input, ctx, signal) {
    let file;
    try {
      file = await ctx.workspace.readText(input.path, MAX_READ_BYTES);
    } catch (error) {
      if (isJesutobitsError(error) && error.code === ErrorCodes.fsBinary) {
        const info = await ctx.workspace.stat(input.path).catch(() => undefined);
        const size = info ? `${info.size} bytes` : "unknown size";
        return {
          ok: true,
          modelText: `${input.path} is a binary file (${size}); its content is not shown.`,
          outputPreview: `binary, ${size}`,
        };
      }
      return errorResult(error);
    }
    signal.throwIfAborted();
    ctx.reads.set(file.path, file.hash);

    let text = file.text;
    let hiddenValues = false;
    if (ctx.redactValues && isSecretPatternFile(file.path)) {
      text = hideValues(text);
      hiddenValues = true;
    }
    const all = text.split(/\r?\n/);
    // A final newline does not make an extra empty line.
    if (all.length > 1 && all.at(-1) === "") all.pop();
    const start = Math.min((input.offset ?? 1) - 1, all.length);
    const shown = all.slice(start, start + input.limit);
    const width = String(start + shown.length).length;
    const numbered = shown
      .map((line, index) => `${String(start + index + 1).padStart(width)}\t${line}`)
      .join("\n");
    const redacted = ctx.redact(numbered);

    const end = start + shown.length;
    const notes: string[] = [];
    if (hiddenValues) notes.push("Values were hidden at the user's request; keys are shown.");
    if (end < all.length) {
      notes.push(
        `Showing lines ${start + 1}-${end} of ${all.length}. Call read_file with offset ${end + 1} for more.`,
      );
    }
    if (all.length === 0 || (all.length === 1 && all[0] === "")) notes.push("(empty file)");
    return {
      ok: true,
      modelText: [redacted.text, ...notes].filter((part) => part !== "").join("\n"),
      outputPreview: `${shown.length} of ${all.length} lines`,
      hiddenSecrets: redacted.hidden,
    };
  },
  summarize: (input, result) => {
    if (!result?.ok) return `Reading ${input.path}`;
    return `Read ${input.path} (${result.outputPreview ?? ""})`;
  },
};

const SearchFilesInput = z.object({
  pattern: z.string().min(1).max(500).describe("Glob, for example src/**/*.tsx or *.test.ts"),
  limit: z.number().int().min(1).max(1000).default(200),
});

export const searchFiles: ToolDefinition<z.output<typeof SearchFilesInput>> = {
  name: "search_files",
  description:
    "Find files by path with a glob (src/**/*.ts, *.css). A pattern without / matches file names at any depth. Ignored files (node_modules, build output, .gitignore) are not searched. To search inside files use search_text.",
  input: SearchFilesInput,
  timeoutMs: FILE_TOOL_TIMEOUT_MS,
  activity: "reading",
  classify: async () => ({ classes: ["read"] }),
  async execute(input, ctx) {
    if (!ctx.files) return toolError("not_supported", "The file index is not available");
    await ctx.files.ready;
    const regex = globToRegExp(input.pattern, { caseSensitive: false });
    const matches = ctx.files
      .list()
      .filter((path) => regex.test(path))
      .sort();
    const shown = matches.slice(0, input.limit);
    const lines = shown.length > 0 ? shown.join("\n") : "No files match.";
    const more =
      matches.length > shown.length
        ? `\n... ${matches.length - shown.length} more; narrow the pattern`
        : "";
    const partial = ctx.files.complete
      ? ""
      : "\nThe index stopped at its file limit; some files may be missing.";
    return {
      ok: true,
      modelText: `${lines}${more}${partial}`,
      outputPreview: `${matches.length} files`,
    };
  },
  summarize: (input, result) =>
    result?.ok
      ? `Searched files for ${input.pattern} (${result.outputPreview ?? ""})`
      : `Searching files for ${input.pattern}`,
};
