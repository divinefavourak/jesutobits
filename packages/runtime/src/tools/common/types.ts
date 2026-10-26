import type {
  ActivityCategory,
  FileChange,
  PermissionAction,
  PlanItem,
  RiskClass,
  ToolError,
} from "@jesutobits/protocol";
import type { FileIndex, WorkspaceService } from "@jesutobits/services";
import type { z } from "zod";
import type { ProhibitedPlaces } from "../../permissions/prohibited.js";

/**
 * The tool contract (AGENT_HARNESS.md section 5.1). Tools are the only way the model affects
 * anything, and none runs without the PermissionBroker's grant (invariant 1).
 */
export interface ToolDefinition<I = unknown> {
  /** snake_case, unique. */
  readonly name: string;
  /** Written for the model; says when NOT to use the tool. */
  readonly description: string;
  readonly input: z.ZodType<I>;
  readonly timeoutMs: number;
  readonly activity: ActivityCategory;
  /** Absent: available everywhere. */
  readonly availability?: { requiresTrust?: boolean };
  /**
   * What the call would do, for the broker (SECURITY.md section 4). May look at the disk
   * (resolve paths, read a file's size) but never change anything.
   */
  classify(input: I, ctx: ToolContext): Promise<RiskAssessment>;
  execute(input: I, ctx: ToolContext, signal: AbortSignal): Promise<ToolResult>;
  /** One line for the timeline, before (no result) and after the call. */
  summarize(input: I, result?: ToolResult): string;
}

export interface RiskAssessment {
  classes: RiskClass[];
  /** The exact action an approval card shows (SECURITY.md principle 3). */
  action?: PermissionAction;
  /** Never allowed, whatever the preset or the user says; the reason is shown (4.3). */
  prohibited?: string;
  /** A unified diff of what would change, for the approval card. */
  diff?: string;
  /**
   * What "Allow for this session" would allow, if anything: the rule's match and its
   * description in words, shown on the card before the user clicks.
   */
  sessionRule?: { match: SessionRuleMatch; description: string };
}

/** A Phase 2 session rule: this tool, on these paths (all of them when absent). */
export interface SessionRuleMatch {
  tool: string;
  paths?: string[];
}

export type ToolResult =
  | {
      ok: true;
      /** What the model sees: compact and factual, at most 16 KB (truncated by the runner). */
      modelText: string;
      /** Shown in the expanded timeline row. */
      outputPreview?: string;
      diff?: FileChange[];
      /** Possible secrets masked out of `modelText` (SECURITY.md section 6.1). */
      hiddenSecrets?: number;
      /** For the harness: the turn waits for the user before going on (`ask_user`). */
      awaitUser?: { questionId: string };
    }
  | { ok: false; error: ToolError; modelText: string };

/** What a tool may use. Only through these does a tool reach files or the user. */
export interface ToolContext {
  projectId: string;
  sessionId: string;
  turnId: string;
  callId: string;
  /** The only way to touch files (invariant 2). */
  workspace: WorkspaceService;
  /** Places never allowed, inside the project or not (SECURITY.md section 4.3). */
  prohibited: ProhibitedPlaces;
  /** The quick-open index: every non-ignored file path, for `search_files`. */
  files: FileIndex | undefined;
  /** What the session last read of each file (FR-052, `stale_read`). */
  reads: ReadTracker;
  /** Pre-images before every change (ADR-0012). */
  checkpoints: {
    before(path: string): Promise<string>;
    after(path: string, after: { bytes: Uint8Array } | null): void;
  };
  /** The user chose "Share with values hidden": return secret files with values masked. */
  redactValues: boolean;
  /** Masks known secrets and token shapes; returns how many were hidden. */
  redact(text: string): { text: string; hidden: number };
  /** `update_plan`. */
  setPlan(items: PlanItem[]): void;
  /** `ask_user`: shows the question and returns its ID; the harness waits for the answer. */
  askUser(question: string, options: string[]): string;
  /** Text search over the project (`search_text`): ripgrep, or the JS fallback. */
  searchText?(query: TextSearchQuery, signal: AbortSignal): Promise<TextSearchResult>;
}

/** Content hashes the session saw, by project-relative path. */
export interface ReadTracker {
  get(path: string): string | undefined;
  set(path: string, hash: string): void;
  forget(path: string): void;
}

export interface TextSearchQuery {
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  glob?: string;
  limit: number;
}

export interface TextSearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface TextSearchResult {
  matches: TextSearchMatch[];
  /** More matches exist than `limit`. */
  truncated: boolean;
}

/** A tool error result, with `modelText` saying the same for the model. */
export function toolError(
  code: ToolError["code"],
  message: string,
  extra: { retryable?: boolean; details?: Record<string, unknown> } = {},
): ToolResult {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: extra.retryable ?? false,
      ...(extra.details && { details: extra.details }),
    },
    modelText: `Error (${code}): ${message}`,
  };
}

/** Erases the input type so tools of different inputs fit in one registry. */
export type AnyTool = ToolDefinition<never>;
