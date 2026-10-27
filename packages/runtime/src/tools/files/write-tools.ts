import { ErrorCodes, isJesutobitsError, type FileChange } from "@jesutobits/protocol";
import { countLineChanges, unifiedDiff } from "@jesutobits/shared";
import { z } from "zod";
import { checkPath, errorResult } from "../common/paths.js";
import {
  toolError,
  type RiskAssessment,
  type ToolContext,
  type ToolDefinition,
} from "../common/types.js";

const FILE_TOOL_TIMEOUT_MS = 30_000;
/** Approval cards and model results show at most this much diff. */
const MAX_DIFF_CHARS = 16_000;
/** write_file content limit; larger generated files are not what the agent should write. */
const MAX_WRITE_CHARS = 1_000_000;

const PathSchema = z.string().min(1).max(1024).describe("Project-relative path, using /");

/** The file as it is now: its text and hash, or null when it does not exist. */
async function current(
  ctx: ToolContext,
  path: string,
): Promise<{ text: string; hash: string } | null> {
  try {
    const file = await ctx.workspace.readText(path);
    return { text: file.text, hash: file.hash };
  } catch (error) {
    if (isJesutobitsError(error) && error.code === ErrorCodes.fsNotFound) return null;
    throw error;
  }
}

/**
 * FR-052: an existing file may be changed only if the session read it and it has not
 * changed since. Returns an error result, or undefined when the write may go ahead.
 */
function staleRead(ctx: ToolContext, path: string, hash: string) {
  const seen = ctx.reads.get(path);
  if (seen === undefined) {
    return toolError("stale_read", `Read ${path} with read_file before changing it`, {
      retryable: true,
    });
  }
  if (seen !== hash) {
    return toolError(
      "stale_read",
      `${path} changed since you last read it (perhaps the user edited it). Read it again before changing it.`,
      { retryable: true },
    );
  }
  return undefined;
}

function diffFor(path: string, before: string, after: string): string {
  return unifiedDiff(before, after, {
    fromName: `a/${path}`,
    toName: `b/${path}`,
    maxChars: MAX_DIFF_CHARS,
  });
}

function writeAssessment(
  check: Awaited<ReturnType<typeof checkPath>>,
  tool: string,
  diff: string | undefined,
): RiskAssessment {
  return {
    classes: check.classes,
    action: { kind: "file", op: "write", paths: [check.relative] },
    ...(check.prohibited !== undefined && { prohibited: check.prohibited }),
    ...(diff !== undefined && { diff }),
    sessionRule: {
      match: { tool },
      description: `${tool}: change files in this project for the rest of this session`,
    },
  };
}

/** Writes through the checkpoint: pre-image first, then the change, then how it was left. */
async function checkpointedWrite(
  ctx: ToolContext,
  path: string,
  text: string,
  expectedHash: string | null,
): Promise<{ path: string; hash: string }> {
  const relative = await ctx.checkpoints.before(path);
  const written = await ctx.workspace.writeText(relative, text, { expectedHash });
  const after = await ctx.workspace.snapshot(relative);
  ctx.checkpoints.after(relative, after && { bytes: after.bytes });
  ctx.reads.set(relative, written.hash);
  return { path: relative, hash: written.hash };
}

const WriteInput = z.object({
  path: PathSchema,
  content: z.string().max(MAX_WRITE_CHARS),
  createDirs: z.boolean().default(true),
});

export const writeFile: ToolDefinition<z.output<typeof WriteInput>> = {
  name: "write_file",
  description:
    "Create a file, or replace a whole file you have read in this session. For changes to part of an existing file, use edit_file instead. Missing folders are created. The previous content is kept so the user can revert the turn.",
  input: WriteInput,
  timeoutMs: FILE_TOOL_TIMEOUT_MS,
  activity: "editing",
  async classify(input, ctx) {
    const check = await checkPath(ctx, input.path, "write");
    let diff: string | undefined;
    if (!check.prohibited && !check.classes.includes("outside_workspace")) {
      const existing = await current(ctx, check.relative).catch(() => null);
      diff = diffFor(check.relative, existing?.text ?? "", input.content);
    }
    return writeAssessment(check, "write_file", diff);
  },
  async execute(input, ctx, signal) {
    try {
      const existing = await current(ctx, input.path);
      if (existing) {
        const stale = staleRead(
          ctx,
          (await ctx.workspace.resolve(input.path)).relative,
          existing.hash,
        );
        if (stale) return stale;
      } else if (!input.createDirs) {
        const parent = input.path.split("/").slice(0, -1).join("/");
        if (parent !== "") {
          const info = await ctx.workspace.stat(parent).catch(() => undefined);
          if (info?.kind !== "directory") {
            return toolError("not_found", `The folder ${parent} does not exist`);
          }
        }
      }
      signal.throwIfAborted();
      const written = await checkpointedWrite(
        ctx,
        input.path,
        input.content,
        existing?.hash ?? null,
      );
      const counts = countLineChanges(existing?.text ?? "", input.content);
      const change: FileChange = {
        path: written.path,
        change: existing ? "modified" : "created",
        ...counts,
      };
      return {
        ok: true,
        modelText: `${existing ? "Replaced" : "Created"} ${written.path} (+${counts.added} -${counts.removed}).`,
        diff: [change],
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return errorResult(error);
    }
  },
  summarize: (input, result) => {
    const change = result?.ok ? result.diff?.[0] : undefined;
    if (!change) return `Writing ${input.path}`;
    const verb = change.change === "created" ? "Created" : "Wrote";
    return `${verb} ${change.path} (+${change.added} -${change.removed})`;
  },
};

const EditInput = z.object({
  path: PathSchema,
  edits: z
    .array(
      z.object({
        oldText: z.string().min(1),
        newText: z.string(),
        expectedOccurrences: z.number().int().min(1).default(1),
      }),
    )
    .min(1)
    .max(50),
});

type EditPlan = { ok: true; text: string } | { ok: false; message: string };

/**
 * Applies exact-string replacements in order. A CRLF file is matched and edited with LF
 * line ends, and written back as CRLF by WorkspaceService.
 */
function applyEdits(original: string, edits: z.output<typeof EditInput>["edits"]): EditPlan {
  const crlf = original.includes("\r\n") && !/(?<!\r)\n/.test(original);
  let text = crlf ? original.replaceAll("\r\n", "\n") : original;
  for (const [index, edit] of edits.entries()) {
    const oldText = crlf ? edit.oldText.replaceAll("\r\n", "\n") : edit.oldText;
    const newText = crlf ? edit.newText.replaceAll("\r\n", "\n") : edit.newText;
    const count = text.split(oldText).length - 1;
    if (count !== edit.expectedOccurrences) {
      const which = edits.length > 1 ? `Edit ${index + 1}: ` : "";
      const found =
        count === 0
          ? `oldText was not found.${nearestHint(text, oldText)}`
          : `oldText was found ${count} times, not ${edit.expectedOccurrences}. Include more surrounding lines to make it unique, or set expectedOccurrences.`;
      return { ok: false, message: `${which}${found}` };
    }
    text = text.split(oldText).join(newText);
  }
  return { ok: true, text };
}

/** Points at the line most like the first line of `oldText`, which is usually a whitespace slip. */
function nearestHint(text: string, oldText: string): string {
  const first = oldText
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim();
  if (!first) return "";
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.trim() === first);
  if (index === -1) return " Read the file again and copy the text exactly.";
  return ` Line ${index + 1} has the same text with different indentation or surrounding lines: ${JSON.stringify(lines[index])}.`;
}

export const editFile: ToolDefinition<z.output<typeof EditInput>> = {
  name: "edit_file",
  description:
    "Change part of a file by exact text replacement. Each oldText must match the file exactly (including indentation) and, by default, exactly once; edits apply in order. Read the file first; the edit is refused if it changed since. Returns the diff.",
  input: EditInput,
  timeoutMs: FILE_TOOL_TIMEOUT_MS,
  activity: "editing",
  async classify(input, ctx) {
    const check = await checkPath(ctx, input.path, "write");
    let diff: string | undefined;
    if (!check.prohibited && !check.classes.includes("outside_workspace")) {
      const existing = await current(ctx, check.relative).catch(() => null);
      const plan = existing && applyEdits(existing.text, input.edits);
      if (existing && plan?.ok) diff = diffFor(check.relative, existing.text, plan.text);
    }
    return writeAssessment(check, "edit_file", diff);
  },
  async execute(input, ctx, signal) {
    try {
      const relative = (await ctx.workspace.resolve(input.path)).relative;
      const existing = await current(ctx, relative);
      if (!existing)
        return toolError("not_found", `${relative} does not exist; use write_file to create it`);
      const stale = staleRead(ctx, relative, existing.hash);
      if (stale) return stale;
      const plan = applyEdits(existing.text, input.edits);
      if (!plan.ok) return toolError("conflict", plan.message, { retryable: true });
      signal.throwIfAborted();
      await checkpointedWrite(ctx, relative, plan.text, existing.hash);
      // Compare as written: WorkspaceService keeps the file's line endings.
      const before = existing.text.replaceAll("\r\n", "\n");
      const after = plan.text.replaceAll("\r\n", "\n");
      const counts = countLineChanges(before, after);
      const diff = diffFor(relative, before, after);
      return {
        ok: true,
        modelText: `Edited ${relative} (+${counts.added} -${counts.removed}):\n${diff}`,
        outputPreview: diff,
        diff: [{ path: relative, change: "modified", ...counts }],
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return errorResult(error);
    }
  },
  summarize: (input, result) => {
    const change = result?.ok ? result.diff?.[0] : undefined;
    return change
      ? `Edited ${change.path} (+${change.added} -${change.removed})`
      : `Editing ${input.path}`;
  },
};

const MoveInput = z.object({ from: PathSchema, to: PathSchema });

export const movePath: ToolDefinition<z.output<typeof MoveInput>> = {
  name: "move_path",
  description:
    "Rename or move a file or folder within the project. Fails if the target exists. Update imports that refer to the old path yourself.",
  input: MoveInput,
  timeoutMs: FILE_TOOL_TIMEOUT_MS,
  activity: "editing",
  async classify(input, ctx) {
    const from = await checkPath(ctx, input.from, "write");
    const to = await checkPath(ctx, input.to, "write");
    const prohibited = from.prohibited ?? to.prohibited;
    return {
      classes: [...new Set([...from.classes, ...to.classes])],
      action: { kind: "file", op: "move", paths: [from.relative, to.relative] },
      ...(prohibited !== undefined && { prohibited }),
      sessionRule: {
        match: { tool: "move_path" },
        description:
          "move_path: move and rename files in this project for the rest of this session",
      },
    };
  },
  async execute(input, ctx, signal) {
    try {
      const from = (await ctx.workspace.resolve(input.from)).relative;
      const to = (await ctx.workspace.resolve(input.to)).relative;
      const files = await ctx.workspace.listFiles(from);
      if (await exists(ctx, to)) {
        return toolError("conflict", `${to} already exists`);
      }
      const targets = files.map((file) => `${to}${file.slice(from.length)}`);
      for (const [index, file] of files.entries()) {
        signal.throwIfAborted();
        await ctx.checkpoints.before(file);
        await ctx.checkpoints.before(targets[index] ?? file);
      }
      await ctx.workspace.rename(from, to);
      for (const [index, file] of files.entries()) {
        const target = targets[index] ?? file;
        ctx.checkpoints.after(file, null);
        const moved = await ctx.workspace.snapshot(target);
        ctx.checkpoints.after(target, moved && { bytes: moved.bytes });
        const seen = ctx.reads.get(file);
        ctx.reads.forget(file);
        if (seen !== undefined) ctx.reads.set(target, seen);
      }
      return {
        ok: true,
        modelText: `Moved ${from} to ${to}${files.length > 1 ? ` (${files.length} files)` : ""}.`,
        diff: [{ path: to, from, change: "moved", added: 0, removed: 0 }],
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return errorResult(error);
    }
  },
  summarize: (input, result) =>
    result?.ok ? `Moved ${input.from} to ${input.to}` : `Moving ${input.from} to ${input.to}`,
};

async function exists(ctx: ToolContext, path: string): Promise<boolean> {
  return ctx.workspace.stat(path).then(
    () => true,
    () => false,
  );
}

const DeleteInput = z.object({
  path: PathSchema,
  recursive: z.boolean().default(false).describe("Required to delete a folder that has files"),
});

export const deletePath: ToolDefinition<z.output<typeof DeleteInput>> = {
  name: "delete_path",
  description:
    "Delete a file, or a folder with recursive: true. Always asks the user. The content is kept by Jesutobits so the user can revert the turn.",
  input: DeleteInput,
  timeoutMs: FILE_TOOL_TIMEOUT_MS,
  activity: "editing",
  async classify(input, ctx) {
    const check = await checkPath(ctx, input.path, "write");
    return {
      classes: [...check.classes, "destructive"],
      action: { kind: "file", op: "delete", paths: [check.relative] },
      ...(check.prohibited !== undefined && { prohibited: check.prohibited }),
      sessionRule: {
        match: { tool: "delete_path", paths: [check.relative] },
        description: `delete_path: delete ${check.relative} again in this session`,
      },
    };
  },
  async execute(input, ctx, signal) {
    try {
      const relative = (await ctx.workspace.resolve(input.path)).relative;
      const info = await ctx.workspace.stat(relative);
      const files = await ctx.workspace.listFiles(relative);
      if (info.kind === "directory" && files.length > 0 && !input.recursive) {
        return toolError(
          "conflict",
          `${relative} is a folder with ${files.length} files; set recursive: true to delete it`,
        );
      }
      const changes: FileChange[] = [];
      for (const file of files) {
        signal.throwIfAborted();
        await ctx.checkpoints.before(file);
        const before = await ctx.workspace.readText(file).catch(() => undefined);
        changes.push({
          path: file,
          change: "deleted",
          added: 0,
          removed: before ? countLineChanges(before.text, "").removed : 0,
        });
      }
      await ctx.workspace.remove(relative, { recursive: input.recursive });
      for (const file of files) {
        ctx.checkpoints.after(file, null);
        ctx.reads.forget(file);
      }
      return {
        ok: true,
        modelText: `Deleted ${relative}${files.length > 1 ? ` (${files.length} files)` : ""}. The user can restore it by reverting the turn.`,
        diff: changes,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return errorResult(error);
    }
  },
  summarize: (input, result) => (result?.ok ? `Deleted ${input.path}` : `Deleting ${input.path}`),
};
