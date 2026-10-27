import { ErrorCodes, JesutobitsError, isJesutobitsError } from "@jesutobits/protocol";
import { globToRegExp } from "@jesutobits/shared";
import { runCommand } from "../process/run-command.js";
import type { WorkspaceService } from "../workspace/workspace-service.js";

export interface TextSearchOptions {
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  /** Only paths matching this glob (ripgrep's `--glob` syntax). */
  glob?: string;
  limit: number;
}

export interface TextMatch {
  /** Project-relative, `/` separated. */
  path: string;
  /** From 1. */
  line: number;
  /** From 1, in characters. */
  column: number;
  /** The line, cut to MAX_LINE_CHARS. */
  text: string;
}

export interface TextSearchOutcome {
  matches: TextMatch[];
  /** More matches exist than `limit` (or ripgrep's output was cut). */
  truncated: boolean;
  engine: "ripgrep" | "fallback";
}

export interface TextSearchContext {
  workspace: WorkspaceService;
  /** The ripgrep VS Code ships (`--ripgrep`, ADR-0015); without it the JS fallback runs. */
  ripgrep?: string | undefined;
  /** Every non-ignored file (the quick-open index), for the fallback. */
  files(): string[];
  signal?: AbortSignal;
}

const MAX_LINE_CHARS = 300;
/** Folders never searched, whatever .gitignore says (AGENT_HARNESS.md section 6). */
const BUILT_IN_IGNORES = ["node_modules", ".git", "dist", "build", ".next", "coverage"];
/** The fallback skips larger files; ripgrep has no such limit. */
const FALLBACK_MAX_FILE_BYTES = 1024 * 1024;
const SEARCH_TIMEOUT_MS = 30_000;

/** Checks the pattern up front, so a bad regex is the caller's error, not a crash. */
function compile(options: TextSearchOptions): RegExp {
  const source = options.isRegex
    ? options.query
    : options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(source, options.caseSensitive ? "g" : "gi");
  } catch (error) {
    throw new JesutobitsError(
      ErrorCodes.fsInvalidQuery,
      `The regular expression is not valid: ${(error as Error).message}`,
      {
        details: { query: options.query },
      },
    );
  }
}

/**
 * Project text search (FR-074, `search_text`): ripgrep over the project root, respecting
 * .gitignore and .jesutobitsignore, never following links (so it stays inside the project).
 * Without ripgrep, or if it cannot start, a slower JS scan of the indexed files runs.
 */
export async function searchText(
  options: TextSearchOptions,
  ctx: TextSearchContext,
): Promise<TextSearchOutcome> {
  const regex = compile(options);
  if (ctx.ripgrep) {
    try {
      return await ripgrep(options, ctx);
    } catch (error) {
      // A cancel or a bad pattern is an answer; anything else falls back.
      if (ctx.signal?.aborted) throw error;
      if (isJesutobitsError(error) && error.code === ErrorCodes.fsInvalidQuery) throw error;
    }
  }
  return fallback(options, regex, ctx);
}

async function ripgrep(
  options: TextSearchOptions,
  ctx: TextSearchContext,
): Promise<TextSearchOutcome> {
  const args = [
    "--json",
    "--hidden",
    "--no-require-git",
    "--no-config",
    "--max-columns",
    String(MAX_LINE_CHARS),
    "--max-columns-preview",
    "--max-filesize",
    "10M",
    options.caseSensitive ? "--case-sensitive" : "--ignore-case",
    ...(options.isRegex ? [] : ["--fixed-strings"]),
    ...BUILT_IN_IGNORES.flatMap((name) => ["--glob", `!${name}/`]),
    ...((await hasIgnoreFile(ctx.workspace)) ? ["--ignore-file", ".jesutobitsignore"] : []),
    ...(options.glob ? ["--glob", options.glob] : []),
    "-e",
    options.query,
    "--",
    ".",
  ];
  const result = await runCommand([ctx.ripgrep as string, ...args], {
    cwd: ctx.workspace.realRoot,
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxOutputBytes: 8 * 1024 * 1024,
    ...(ctx.signal && { signal: ctx.signal }),
  });
  // 0: matches, 1: none, 2: an error (a bad pattern, or unreadable files with matches).
  if (result.exitCode === 2 && !result.stdout.includes('"type":"match"')) {
    const reason = result.stderr.split("\n").find((line) => line.trim() !== "") ?? "ripgrep failed";
    throw new JesutobitsError(
      ErrorCodes.fsInvalidQuery,
      `The search failed: ${reason.slice(0, 300)}`,
      {
        details: { query: options.query },
      },
    );
  }
  const matches: TextMatch[] = [];
  let truncated = result.truncated;
  for (const line of result.stdout.split("\n")) {
    if (!line.startsWith('{"type":"match"')) continue;
    let event: RgMatch;
    try {
      event = JSON.parse(line) as RgMatch;
    } catch {
      continue; // The last line of cut output.
    }
    const path = event.data.path.text?.replace(/^\.[\\/]/, "").replaceAll("\\", "/");
    const text = event.data.lines.text;
    if (path === undefined || text === undefined) continue;
    if (matches.length >= options.limit) {
      truncated = true;
      break;
    }
    const first = event.data.submatches[0];
    matches.push({
      path,
      line: event.data.line_number,
      column: first
        ? Buffer.from(text, "utf8").subarray(0, first.start).toString("utf8").length + 1
        : 1,
      text: trimLine(text),
    });
  }
  return { matches, truncated, engine: "ripgrep" };
}

async function hasIgnoreFile(workspace: WorkspaceService): Promise<boolean> {
  return workspace.stat(".jesutobitsignore").then(
    (info) => info.kind === "file",
    () => false,
  );
}

interface RgMatch {
  data: {
    path: { text?: string };
    lines: { text?: string };
    line_number: number;
    submatches: Array<{ start: number }>;
  };
}

async function fallback(
  options: TextSearchOptions,
  regex: RegExp,
  ctx: TextSearchContext,
): Promise<TextSearchOutcome> {
  const glob = options.glob;
  const paths = ctx
    .files()
    .filter((path) => glob === undefined || globToRegExp(glob, { caseSensitive: false }).test(path))
    .sort();
  const matches: TextMatch[] = [];
  for (const path of paths) {
    ctx.signal?.throwIfAborted();
    let text: string;
    try {
      text = (await ctx.workspace.readText(path, FALLBACK_MAX_FILE_BYTES)).text;
    } catch {
      continue; // Binary, too large or gone: ripgrep would skip it too.
    }
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      regex.lastIndex = 0;
      const found = regex.exec(line);
      if (!found) continue;
      if (matches.length >= options.limit) return { matches, truncated: true, engine: "fallback" };
      matches.push({ path, line: index + 1, column: found.index + 1, text: trimLine(line) });
    }
  }
  return { matches, truncated: false, engine: "fallback" };
}

function trimLine(text: string): string {
  const line = text.replace(/\r?\n$/, "");
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}
