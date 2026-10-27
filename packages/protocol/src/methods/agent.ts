import { z } from "zod";
import {
  FileChangeSchema,
  ModelInfoSchema,
  PermissionDecisionSchema,
  PermissionIdSchema,
  PolicyPresetSchema,
  ProviderErrorSchema,
  QuestionIdSchema,
  RuleIdSchema,
  SessionIdSchema,
  SessionSchema,
  TurnIdSchema,
  TurnModeSchema,
  TurnStateSchema,
} from "../agent.js";
import { RuntimeEventBaseSchema } from "../events.js";
import { defineMethod } from "./define.js";

// sessions.* (ARCHITECTURE.md section 6.3). All act on the active project and fail with
// `fs.no_project` without one.

export const sessionsList = defineMethod({
  name: "sessions.list",
  description: "The active project's sessions, most recently updated first.",
  callers: ["workbench"],
  params: z.object({ includeArchived: z.boolean().default(false) }),
  result: z.object({ sessions: z.array(SessionSchema) }),
});

export const sessionsCreate = defineMethod({
  name: "sessions.create",
  description: "Start a new session in the active project.",
  callers: ["workbench"],
  params: z.object({
    /** Defaults to the provider's default model from settings. */
    modelId: z.string().min(1).optional(),
    title: z.string().min(1).max(200).optional(),
  }),
  result: z.object({ session: SessionSchema }),
});

export const sessionsGet = defineMethod({
  name: "sessions.get",
  description: "A session and the turn running in it, if any.",
  callers: ["workbench"],
  params: z.object({ id: SessionIdSchema }),
  result: z.object({
    session: SessionSchema,
    activeTurn: z.object({ turnId: TurnIdSchema, state: TurnStateSchema }).nullable(),
  }),
});

/** Most events a page holds; the runtime also stops early to stay under the message limit. */
export const MAX_HISTORY_PAGE = 2000;

/**
 * A session's history as the events it produced, oldest first (DATA_AND_PERSISTENCE.md
 * section 4, `events`). Text deltas are not stored; each step's final text is in its
 * `model.step_completed` event. The Workbench folds these through the same reducer as
 * live events, so history and live activity look the same.
 */
export const sessionsHistory = defineMethod({
  name: "sessions.history",
  description: "A page of a session's stored events, oldest first.",
  callers: ["workbench"],
  params: z.object({
    id: SessionIdSchema,
    /** The `next` of the previous page; omitted for the first page. */
    after: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(MAX_HISTORY_PAGE).default(MAX_HISTORY_PAGE),
  }),
  result: z.object({
    /** Each event also carries its own type-specific fields. */
    events: z.array(RuntimeEventBaseSchema.loose()),
    /** Pass as `after` for the next page; null when this page is the last. */
    next: z.number().int().nonnegative().nullable(),
  }),
});

export const sessionsRename = defineMethod({
  name: "sessions.rename",
  description: "Rename a session.",
  callers: ["workbench"],
  params: z.object({ id: SessionIdSchema, title: z.string().min(1).max(200) }),
  result: z.object({ session: SessionSchema }),
});

export const sessionsArchive = defineMethod({
  name: "sessions.archive",
  description: "Hide a session from the list, or show it again; its history is kept.",
  callers: ["workbench"],
  params: z.object({ id: SessionIdSchema, archived: z.boolean().default(true) }),
  result: z.object({ session: SessionSchema }),
});

export const sessionsDelete = defineMethod({
  name: "sessions.delete",
  description: "Delete a session and its history. Files the agent changed stay as they are.",
  callers: ["workbench"],
  params: z.object({ id: SessionIdSchema }),
  result: z.object({}),
});

// agent.* (AGENT_HARNESS.md section 3).

export const agentSendMessage = defineMethod({
  name: "agent.sendMessage",
  description: "Send the user's message and start a turn.",
  callers: ["workbench"],
  params: z.object({
    sessionId: SessionIdSchema,
    text: z.string().min(1).max(100_000),
    mode: TurnModeSchema.default("agent"),
  }),
  result: z.object({ turnId: TurnIdSchema }),
});

export const agentCancelTurn = defineMethod({
  name: "agent.cancelTurn",
  description: "Stop the turn; it reaches cancelled within 2 s (NFR-025).",
  callers: ["workbench"],
  params: z.object({ turnId: TurnIdSchema }),
  result: z.object({}),
});

export const agentPauseTurn = defineMethod({
  name: "agent.pauseTurn",
  description: "Let the current tool finish, then hold the turn until it is resumed.",
  callers: ["workbench"],
  params: z.object({ turnId: TurnIdSchema }),
  result: z.object({}),
});

export const agentResumeTurn = defineMethod({
  name: "agent.resumeTurn",
  description: "Continue a paused turn.",
  callers: ["workbench"],
  params: z.object({ turnId: TurnIdSchema }),
  result: z.object({}),
});

export const agentRetryTurn = defineMethod({
  name: "agent.retryTurn",
  description: "Continue a failed or interrupted turn's work in a new turn.",
  callers: ["workbench"],
  params: z.object({ turnId: TurnIdSchema }),
  result: z.object({ turnId: TurnIdSchema }),
});

export const agentAnswerQuestion = defineMethod({
  name: "agent.answerQuestion",
  description: "Answer a question the agent, or a limit, asked.",
  callers: ["workbench"],
  params: z.object({ questionId: QuestionIdSchema, answer: z.string().min(1).max(10_000) }),
  result: z.object({}),
});

export const agentSetModel = defineMethod({
  name: "agent.setModel",
  description: "Use another model for the session's next turns.",
  callers: ["workbench"],
  params: z.object({ sessionId: SessionIdSchema, modelId: z.string().min(1) }),
  result: z.object({ session: SessionSchema }),
});

// permissions.* (SECURITY.md section 4).

export const permissionsRespond = defineMethod({
  name: "permissions.respond",
  description: "Answer a pending approval card.",
  callers: ["workbench"],
  params: z.object({
    permissionId: PermissionIdSchema,
    decision: PermissionDecisionSchema,
    /** With `deny`: guidance the model receives ("Deny with message"). */
    message: z.string().min(1).max(2000).optional(),
  }),
  result: z.object({}),
});

export const PermissionRuleSchema = z.object({
  id: RuleIdSchema,
  scope: z.enum(["session", "project"]),
  sessionId: SessionIdSchema.nullable(),
  tool: z.string(),
  /** What the rule matches, in words, as the approval card showed it. */
  description: z.string(),
  createdAt: z.iso.datetime(),
});
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

export const permissionsListRules = defineMethod({
  name: "permissions.listRules",
  description: "Rules of the active project and its sessions.",
  callers: ["workbench"],
  params: z.object({}),
  result: z.object({ rules: z.array(PermissionRuleSchema) }),
});

export const permissionsRemoveRule = defineMethod({
  name: "permissions.removeRule",
  description: "Remove a rule; matching actions ask again.",
  callers: ["workbench"],
  params: z.object({ id: RuleIdSchema }),
  result: z.object({}),
});

const PolicyResultSchema = z.object({
  preset: PolicyPresetSchema,
  /** The project is untrusted, so the Restricted column applies whatever the preset. */
  restricted: z.boolean(),
});

export const permissionsGetPolicy = defineMethod({
  name: "permissions.getPolicy",
  description: "The active project's policy preset.",
  callers: ["workbench"],
  params: z.object({}),
  result: PolicyResultSchema,
});

export const permissionsSetPolicy = defineMethod({
  name: "permissions.setPolicy",
  description: "Change the active project's policy preset.",
  callers: ["workbench"],
  params: z.object({ preset: PolicyPresetSchema }),
  result: PolicyResultSchema,
});

// checkpoints.* (ADR-0012).

export const CheckpointFileSchema = FileChangeSchema.extend({
  /** The file is as the turn left it, so reverting cannot lose someone else's change. */
  unchangedSince: z.boolean(),
});

export const checkpointsListForTurn = defineMethod({
  name: "checkpoints.listForTurn",
  description: "The files a turn's tools changed, and whether each changed again since.",
  callers: ["workbench"],
  params: z.object({ turnId: TurnIdSchema }),
  result: z.object({ files: z.array(CheckpointFileSchema) }),
});

export const RevertOutcomeSchema = z.object({
  /** Restored to how they were before the turn. */
  restored: z.array(z.string()),
  /** Changed since the turn, by the user or another program: left alone unless forced. */
  conflicts: z.array(z.string()),
});

export const checkpointsRevertTurn = defineMethod({
  name: "checkpoints.revertTurn",
  description: "Restore every file the turn's tools changed, except those changed since.",
  callers: ["workbench"],
  params: z.object({
    turnId: TurnIdSchema,
    /** Paths to restore even though they changed since the turn. */
    force: z.array(z.string()).default([]),
  }),
  result: RevertOutcomeSchema,
});

export const checkpointsRevertFile = defineMethod({
  name: "checkpoints.revertFile",
  description: "Restore one file the turn's tools changed.",
  callers: ["workbench"],
  params: z.object({
    turnId: TurnIdSchema,
    path: z.string().min(1),
    force: z.boolean().default(false),
  }),
  result: RevertOutcomeSchema,
});

// models.* (AGENT_HARNESS.md section 2).

export const modelsList = defineMethod({
  name: "models.list",
  description: "The provider's models, cached for 24 hours; `refresh` fetches them again.",
  callers: ["workbench"],
  params: z.object({ refresh: z.boolean().default(false) }),
  result: z.object({ models: z.array(ModelInfoSchema), fetchedAt: z.iso.datetime().nullable() }),
});

export const modelsTestConnection = defineMethod({
  name: "models.testConnection",
  description: "Check the stored key with the provider (FR-023).",
  callers: ["workbench"],
  params: z.object({}),
  result: z.object({ ok: z.boolean(), error: ProviderErrorSchema.optional() }),
});
