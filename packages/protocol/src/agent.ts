import { z } from "zod";

/**
 * Shapes shared by the agent's methods and events (AGENT_HARNESS.md sections 2, 3, 5 and 8;
 * SECURITY.md section 4). The runtime produces them; the Workbench only displays them.
 */

const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`), `Expected a ${prefix}_ ID`);

export const SessionIdSchema = id("ses");
export const TurnIdSchema = id("trn");
export const CallIdSchema = id("call");
export const PermissionIdSchema = id("perm");
export const QuestionIdSchema = id("qst");
export const RuleIdSchema = id("rule");
export const MessageIdSchema = id("msg");

/** The turn state machine (AGENT_HARNESS.md section 3.2). `interrupted` is assigned at startup. */
export const TurnStateSchema = z.enum([
  "understanding",
  "thinking",
  "responding",
  "tool_running",
  "awaiting_approval",
  "awaiting_user",
  "compacting",
  "paused",
  "completed",
  "cancelled",
  "failed",
  "interrupted",
]);
export type TurnState = z.infer<typeof TurnStateSchema>;

export const FINAL_TURN_STATES: readonly TurnState[] = [
  "completed",
  "cancelled",
  "failed",
  "interrupted",
];

export function isFinalTurnState(state: TurnState): boolean {
  return FINAL_TURN_STATES.includes(state);
}

/** Why a turn changed state, for the timeline and the companion (AGENT_HARNESS.md section 8). */
export const TurnStateReasonSchema = z.enum([
  "user_cancel",
  "limit",
  "approval",
  "question",
  "error",
  "pause",
  "compaction",
]);
export type TurnStateReason = z.infer<typeof TurnStateReasonSchema>;

/** Agent replies with tools; Ask mode answers without them (UX_AND_INTERFACE.md 6.1). */
export const TurnModeSchema = z.enum(["agent", "ask"]);
export type TurnMode = z.infer<typeof TurnModeSchema>;

/** What a tool does, for the timeline and the companion (AGENT_HARNESS.md section 5.1). */
export const ActivityCategorySchema = z.enum([
  "reading",
  "editing",
  "running",
  "installing",
  "testing",
  "previewing",
  "planning",
  "asking",
  "git",
]);
export type ActivityCategory = z.infer<typeof ActivityCategorySchema>;

/** SECURITY.md section 4.1. */
export const RiskClassSchema = z.enum([
  "read",
  "sensitive_read",
  "write",
  "destructive",
  "execute",
  "network",
  "vcs",
  "external",
  "outside_workspace",
]);
export type RiskClass = z.infer<typeof RiskClassSchema>;

/**
 * SECURITY.md section 4.2. A project's chosen preset; an untrusted project is evaluated
 * with the Restricted column whatever its preset is.
 */
export const PolicyPresetSchema = z.enum(["cautious", "balanced", "autonomous"]);
export type PolicyPreset = z.infer<typeof PolicyPresetSchema>;

/** AGENT_HARNESS.md section 5.2. What the model and the timeline see when a tool fails. */
export const ToolErrorCodeSchema = z.enum([
  "invalid_input",
  "not_found",
  "outside_workspace",
  "permission_denied",
  "stale_read",
  "conflict",
  "too_large",
  "timeout",
  "process_failed",
  "not_supported",
  "cancelled",
  "internal",
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;

export const ToolErrorSchema = z.object({
  code: ToolErrorCodeSchema,
  /** Factual and short; never a secret or an absolute path outside the project. */
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

/** AGENT_HARNESS.md section 2.5. */
export const ProviderErrorCategorySchema = z.enum([
  "auth",
  "insufficient_credits",
  "rate_limited",
  "context_length",
  "invalid_request",
  "content_filter",
  "provider_unavailable",
  "timeout",
  "network",
  "cancelled",
  "unknown",
]);
export type ProviderErrorCategory = z.infer<typeof ProviderErrorCategorySchema>;

export const ProviderErrorSchema = z.object({
  category: ProviderErrorCategorySchema,
  /** Safe to show. */
  message: z.string(),
  httpStatus: z.number().int().optional(),
  /** For example OpenRouter's `error.metadata.error_type`. */
  providerErrorType: z.string().optional(),
  retryAfterMs: z.number().nonnegative().optional(),
  retryable: z.boolean(),
});
export type ProviderError = z.infer<typeof ProviderErrorSchema>;

/** One item of the agent-declared plan (`update_plan`, FR-035). */
export const PlanItemSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(500),
  status: z.enum(["pending", "in_progress", "done", "skipped"]),
});
export type PlanItem = z.infer<typeof PlanItemSchema>;

/** AGENT_HARNESS.md section 2.1. */
export const ModelInfoSchema = z.object({
  /** As the provider names it, for example `anthropic/claude-sonnet-x`. */
  id: z.string().min(1),
  displayName: z.string(),
  /** Tokens. */
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  capabilities: z.object({
    tools: z.boolean(),
    toolChoice: z.boolean(),
    parallelToolCalls: z.boolean(),
    vision: z.boolean(),
    structuredOutputs: z.boolean(),
    reasoning: z.boolean(),
  }),
  pricing: z
    .object({
      inputPerMTok: z.number().nonnegative(),
      outputPerMTok: z.number().nonnegative(),
      currency: z.literal("USD"),
    })
    .optional(),
  source: z.enum(["provider", "override"]),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

/** A conversation in a project (DATA_AND_PERSISTENCE.md section 4, `sessions`). */
export const SessionSchema = z.object({
  id: SessionIdSchema,
  projectId: z.string(),
  title: z.string(),
  providerId: z.string(),
  modelId: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archived: z.boolean(),
  costUsd: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type Session = z.infer<typeof SessionSchema>;

/**
 * What a permission request asks to do, shown exactly on the approval card (FR-055,
 * SECURITY.md principle 3). Paths are project-relative. `command` and `git` arrive with
 * the command tools in Phase 3.
 */
export const PermissionActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    op: z.enum(["read", "write", "delete", "move"]),
    paths: z.array(z.string()).min(1),
  }),
  z.object({
    kind: z.literal("command"),
    argv: z.array(z.string()).min(1),
    cwd: z.string(),
    shell: z.boolean(),
  }),
  z.object({
    kind: z.literal("git"),
    op: z.literal("commit"),
    message: z.string(),
    paths: z.array(z.string()),
  }),
]);
export type PermissionAction = z.infer<typeof PermissionActionSchema>;

/**
 * The user's answer on an approval card (SECURITY.md sections 4.4 and 6.2). Each request
 * lists the answers it accepts: `allow_redacted` ("Share with values hidden") only for
 * secret-pattern files, `allow_session` only when a session rule can express the action.
 */
export const PermissionDecisionSchema = z.enum([
  "allow_once",
  "allow_session",
  "allow_redacted",
  "deny",
]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

/** How a file changed in a turn, for timeline rows and the turn summary. */
export const FileChangeSchema = z.object({
  path: z.string(),
  change: z.enum(["created", "modified", "deleted", "moved"]),
  /** For `moved`: where it was. */
  from: z.string().optional(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
});
export type FileChange = z.infer<typeof FileChangeSchema>;

/** AGENT_HARNESS.md section 7.3. Phase 2 has no checks yet (they arrive in Phase 3). */
export const VerificationLabelSchema = z.enum([
  "verified",
  "partially_verified",
  "unverified",
  "failing",
  "no_checks",
]);
export type VerificationLabel = z.infer<typeof VerificationLabelSchema>;

/** Built by the harness from what happened, not by the model (AGENT_HARNESS.md 7.4). */
export const TurnSummarySchema = z.object({
  /** Files the turn's tools changed, in the order they were first changed. */
  files: z.array(FileChangeSchema),
  steps: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  /**
   * Null when no file changed. A turn that changed files is never `verified` without fresh
   * passing evidence; until checks exist (Phase 3) it is `unverified`.
   */
  verification: VerificationLabelSchema.nullable(),
  /** Possible secrets hidden from the model in tool output (SECURITY.md section 6.1). */
  hiddenSecrets: z.number().int().nonnegative(),
});
export type TurnSummary = z.infer<typeof TurnSummarySchema>;
