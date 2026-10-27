import { z } from "zod";
import { PreviewStatusSchema } from "./methods/preview.js";
import {
  ActivityCategorySchema,
  FileChangeSchema,
  MessageIdSchema,
  PermissionActionSchema,
  PermissionDecisionSchema,
  PermissionIdSchema,
  PlanItemSchema,
  ProviderErrorSchema,
  QuestionIdSchema,
  RiskClassSchema,
  SessionSchema,
  ToolErrorSchema,
  TurnIdSchema,
  TurnModeSchema,
  TurnStateReasonSchema,
  TurnStateSchema,
  TurnSummarySchema,
} from "./agent.js";
import { JesutobitsErrorDataSchema } from "./errors.js";

/** Runtime events travel as JSON-RPC notifications with this method name (ADR-0003). */
export const EVENT_NOTIFICATION_METHOD = "event";

/** `family.name`, for example `turn.started` or `fs.changed`. */
const EVENT_TYPE_PATTERN = /^[a-z]+(?:\.[a-z_]+)+$/;

/**
 * Fields shared by every runtime event (ARCHITECTURE.md section 6.4).
 * Event-specific schemas extend this with their own top-level fields (`defineEvent`).
 */
export const RuntimeEventBaseSchema = z.object({
  /** Per runtime process, strictly increasing. Gaps trigger `events.replay`. */
  seq: z.number().int().nonnegative(),
  ts: z.iso.datetime(),
  /** Discriminator, for example `turn.started`. */
  type: z.string().regex(EVENT_TYPE_PATTERN),
  projectId: z.string().optional(),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  callId: z.string().optional(),
  processId: z.string().optional(),
});
export type RuntimeEventBase = z.infer<typeof RuntimeEventBaseSchema>;

/** Correlation IDs an emitter may attach to an event. */
export type EventCorrelation = Partial<
  Pick<RuntimeEventBase, "projectId" | "sessionId" | "turnId" | "callId" | "processId">
>;

export interface EventDefinition<
  Type extends string = string,
  Payload extends z.ZodRawShape = z.ZodRawShape,
> {
  readonly type: Type;
  readonly description: string;
  /** The event's own fields, which sit next to the base fields. */
  readonly payload: z.ZodObject<Payload>;
  /** The full event: base fields, `type` fixed to this event, then the payload. */
  readonly schema: z.ZodType;
}

export function defineEvent<const Type extends string, Payload extends z.ZodRawShape>(definition: {
  type: Type;
  description: string;
  payload: z.ZodObject<Payload>;
}): EventDefinition<Type, Payload> {
  if (!EVENT_TYPE_PATTERN.test(definition.type)) {
    throw new Error(`Invalid event type ${definition.type}`);
  }
  return {
    ...definition,
    schema: RuntimeEventBaseSchema.extend({
      type: z.literal(definition.type),
      ...definition.payload.shape,
    }).strict(),
  };
}

// Catalogue (ARCHITECTURE.md section 6.4). Each family lands with the feature that emits it.

/** Something went wrong that the user may want to know about, without failing an action. */
export const runtimeWarningEvent = defineEvent({
  type: "runtime.warning",
  description: "A non-fatal problem in the runtime, shown in the Output panel.",
  payload: z.object({
    message: z.string(),
    code: z.string().optional(),
  }),
});

/** An error not tied to a request the Workbench made (those fail the request instead). */
export const runtimeErrorEvent = defineEvent({
  type: "runtime.error",
  description: "An error in background work, with the JesutobitsError that describes it.",
  payload: z.object({
    error: JesutobitsErrorDataSchema,
  }),
});

/**
 * Files in the active project changed (AGENT_HARNESS.md section 6), batched every 100 ms.
 * `self` changes were made through WorkspaceService (an editor save, a tool write). On
 * `overflow`, the Workbench reloads what it shows instead of applying `changes`.
 */
export const fsChangedEvent = defineEvent({
  type: "fs.changed",
  description: "A batch of file changes in the active project.",
  payload: z.object({
    projectId: z.string(),
    changes: z.array(
      z.object({
        path: z.string(),
        kind: z.enum(["upsert", "removed"]),
        isDirectory: z.boolean(),
        self: z.boolean(),
      }),
    ),
    overflow: z.boolean(),
    changeCounter: z.number().int().nonnegative(),
  }),
});

// The agent (AGENT_HARNESS.md section 8). Every agent event carries `sessionId` and
// `turnId`; tool and permission events also carry `callId`. Except for text and reasoning
// deltas, they are stored with the session, and `sessions.history` returns them.

/** A session's title, model or totals changed. */
export const sessionUpdatedEvent = defineEvent({
  type: "session.updated",
  description: "A session changed: title, model, archive state or cost.",
  payload: z.object({ session: SessionSchema }),
});

export const turnStartedEvent = defineEvent({
  type: "turn.started",
  description: "The user sent a message (or retried a turn) and a turn began.",
  payload: z.object({
    mode: TurnModeSchema,
    modelId: z.string(),
    /** The user's message; absent when the turn retries another one. */
    message: z.object({ id: MessageIdSchema, text: z.string() }).optional(),
    retryOf: TurnIdSchema.optional(),
  }),
});

export const turnStateChangedEvent = defineEvent({
  type: "turn.state_changed",
  description: "A transition of the turn state machine (AGENT_HARNESS.md section 3.2).",
  payload: z.object({
    /** Null for the first state of a turn. */
    from: TurnStateSchema.nullable(),
    to: TurnStateSchema,
    reason: TurnStateReasonSchema.optional(),
  }),
});

export const turnCompletedEvent = defineEvent({
  type: "turn.completed",
  description: "The model finished; the summary is built by the harness.",
  payload: z.object({ summary: TurnSummarySchema }),
});

export const turnFailedEvent = defineEvent({
  type: "turn.failed",
  description: "A fatal error or hard limit ended the turn.",
  payload: z.object({ error: JesutobitsErrorDataSchema, summary: TurnSummarySchema }),
});

export const turnCancelledEvent = defineEvent({
  type: "turn.cancelled",
  description: "The user stopped the turn.",
  payload: z.object({ summary: TurnSummarySchema }),
});

/** Stored at startup for a turn that was live when the runtime died; never sent live. */
export const turnInterruptedEvent = defineEvent({
  type: "turn.interrupted",
  description: "The runtime stopped while this turn was running.",
  payload: z.object({}),
});

/**
 * A model request began. `attempt` counts from 1; a retry of the same step starts its text
 * again, so the Workbench drops the step's earlier deltas.
 */
export const modelRequestStartedEvent = defineEvent({
  type: "model.request_started",
  description: "A model request for one step of the turn began.",
  payload: z.object({
    step: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    modelId: z.string(),
  }),
});

export const modelTextDeltaEvent = defineEvent({
  type: "model.text_delta",
  description: "Streamed answer text (FR-024). Not stored.",
  payload: z.object({ step: z.number().int().nonnegative(), text: z.string() }),
});

export const modelReasoningDeltaEvent = defineEvent({
  type: "model.reasoning_delta",
  description: "Streamed reasoning text from models that expose it. Not stored.",
  payload: z.object({ step: z.number().int().nonnegative(), text: z.string() }),
});

/** A step's stream ended successfully; `text` is its complete answer text. */
export const modelStepCompletedEvent = defineEvent({
  type: "model.step_completed",
  description: "One model response finished, with its full text and the tools it called.",
  payload: z.object({
    step: z.number().int().nonnegative(),
    text: z.string(),
    toolCalls: z.array(z.object({ callId: z.string(), tool: z.string() })),
    finishReason: z.enum(["stop", "tool_calls", "length", "content_filter", "error"]),
  }),
});

export const modelUsageEvent = defineEvent({
  type: "model.usage",
  description: "Tokens and cost of a step, with the turn's and session's running totals.",
  payload: z.object({
    step: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative(),
    turnCostUsd: z.number().nonnegative(),
    sessionCostUsd: z.number().nonnegative(),
  }),
});

export const modelErrorEvent = defineEvent({
  type: "model.error",
  description: "A model request failed; it is retried when `retryInMs` is set.",
  payload: z.object({
    step: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    error: ProviderErrorSchema,
    retryInMs: z.number().int().nonnegative().optional(),
  }),
});

export const planUpdatedEvent = defineEvent({
  type: "plan.updated",
  description: "The agent declared or updated its plan (`update_plan`, FR-035).",
  payload: z.object({ items: z.array(PlanItemSchema) }),
});

export const toolStartedEvent = defineEvent({
  type: "tool.started",
  description: "A tool call was validated and is being authorised and run.",
  payload: z.object({
    tool: z.string(),
    category: ActivityCategorySchema,
    /** One line for the timeline, for example "Reading src/App.tsx". */
    summary: z.string(),
    risk: z.array(RiskClassSchema),
    /** The input, redacted and with long strings shortened. */
    inputPreview: z.record(z.string(), z.unknown()),
  }),
});

/**
 * A tool call ended. Failures (invalid input, a denial, a blocked action, an error) are
 * `ok: false` with the ToolError the model also receives.
 */
export const toolCompletedEvent = defineEvent({
  type: "tool.completed",
  description: "A tool call finished, failed or was refused.",
  payload: z.object({
    tool: z.string(),
    ok: z.boolean(),
    durationMs: z.number().nonnegative(),
    /** One line for the timeline, for example "Edited src/App.tsx (+12 -3)". */
    summary: z.string(),
    outputPreview: z.string().optional(),
    diff: z.array(FileChangeSchema).optional(),
    error: ToolErrorSchema.optional(),
  }),
});

export const permissionRequestedEvent = defineEvent({
  type: "permission.requested",
  description: "A tool call needs the user's approval (FR-055).",
  payload: z.object({
    permissionId: PermissionIdSchema,
    tool: z.string(),
    action: PermissionActionSchema,
    risk: z.array(RiskClassSchema),
    /** Why the policy asks, one plain sentence each. */
    reasons: z.array(z.string()),
    /** Model-provided; shown labelled as the agent's (FR-055). */
    agentExplanation: z.string().optional(),
    /** A unified diff of the change, shortened, when the action writes a file. */
    diff: z.string().optional(),
    /** With `allow_session`: what the session rule would match, in words. */
    sessionRule: z.string().optional(),
    /** The answers this request accepts. */
    options: z.array(PermissionDecisionSchema).min(1),
  }),
});

export const permissionResolvedEvent = defineEvent({
  type: "permission.resolved",
  description: "An approval was answered, or withdrawn because the turn ended.",
  payload: z.object({
    permissionId: PermissionIdSchema,
    decision: z.union([PermissionDecisionSchema, z.literal("withdrawn")]),
  }),
});

export const questionAskedEvent = defineEvent({
  type: "question.asked",
  description: "The turn waits for the user's answer (FR-036, or a limit was reached).",
  payload: z.object({
    questionId: QuestionIdSchema,
    question: z.string(),
    options: z.array(z.string()),
    /** `agent` for `ask_user`; `limit` and `loop` are asked by the harness itself. */
    source: z.enum(["agent", "limit", "loop"]),
  }),
});

export const questionAnsweredEvent = defineEvent({
  type: "question.answered",
  description: "The user answered, or the question closed because the turn ended.",
  payload: z.object({
    questionId: QuestionIdSchema,
    /** Null when the question closed unanswered. */
    answer: z.string().nullable(),
  }),
});

/** The active project's preview changed state (ROADMAP Phase 4). */
export const previewStatusEvent = defineEvent({
  type: "preview.status",
  description: "The preview started, became ready, failed or stopped.",
  payload: z.object({ status: PreviewStatusSchema }),
});

export const EVENTS = {
  [previewStatusEvent.type]: previewStatusEvent,
  [runtimeWarningEvent.type]: runtimeWarningEvent,
  [runtimeErrorEvent.type]: runtimeErrorEvent,
  [fsChangedEvent.type]: fsChangedEvent,
  [sessionUpdatedEvent.type]: sessionUpdatedEvent,
  [turnStartedEvent.type]: turnStartedEvent,
  [turnStateChangedEvent.type]: turnStateChangedEvent,
  [turnCompletedEvent.type]: turnCompletedEvent,
  [turnFailedEvent.type]: turnFailedEvent,
  [turnCancelledEvent.type]: turnCancelledEvent,
  [turnInterruptedEvent.type]: turnInterruptedEvent,
  [modelRequestStartedEvent.type]: modelRequestStartedEvent,
  [modelTextDeltaEvent.type]: modelTextDeltaEvent,
  [modelReasoningDeltaEvent.type]: modelReasoningDeltaEvent,
  [modelStepCompletedEvent.type]: modelStepCompletedEvent,
  [modelUsageEvent.type]: modelUsageEvent,
  [modelErrorEvent.type]: modelErrorEvent,
  [planUpdatedEvent.type]: planUpdatedEvent,
  [toolStartedEvent.type]: toolStartedEvent,
  [toolCompletedEvent.type]: toolCompletedEvent,
  [permissionRequestedEvent.type]: permissionRequestedEvent,
  [permissionResolvedEvent.type]: permissionResolvedEvent,
  [questionAskedEvent.type]: questionAskedEvent,
  [questionAnsweredEvent.type]: questionAnsweredEvent,
} as const;

/** Event types that are not stored with the session (DATA_AND_PERSISTENCE.md section 4). */
export const TRANSIENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  modelTextDeltaEvent.type,
  modelReasoningDeltaEvent.type,
]);

export type EventType = keyof typeof EVENTS;
/** The fields an emitter supplies for an event, besides the base fields. */
export type EventPayload<T extends EventType> = z.input<(typeof EVENTS)[T]["payload"]>;

export function getEvent(type: string): EventDefinition | undefined {
  return Object.hasOwn(EVENTS, type) ? EVENTS[type as EventType] : undefined;
}
