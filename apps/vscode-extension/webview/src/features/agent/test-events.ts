import type {
  ActivityCategory,
  FileChange,
  JesutobitsErrorData,
  PermissionAction,
  PermissionDecision,
  PlanItem,
  ProviderError,
  RiskClass,
  RuntimeEventBase,
  Session,
  ToolError,
  TurnMode,
  TurnState,
  TurnStateReason,
  TurnSummary,
} from "@jesutobits/protocol";

/**
 * Builders for schema-valid runtime events (test support only, never imported by the app).
 *
 * The reducer validates every event against `packages/protocol`, so a builder has to supply
 * the base fields and the event's own payload. IDs use the protocol's Crockford base32
 * format: a prefix, an underscore and 26 characters.
 */

export const PROJECT_ID = "prj_1";
export const SESSION_ID = "ses_01JAB2C3D4E5F6G7H8J9K0M1N2";
export const TURN_ID = "trn_01JAB2C3D4E5F6G7H8J9K0M1N2";
export const OTHER_TURN_ID = "trn_01JAB2C3D4E5F6G7H8J9K0M1N7";
export const CALL_ID = "call_01JAB2C3D4E5F6G7H8J9K0M1N5";
export const PERMISSION_ID = "perm_01JAB2C3D4E5F6G7H8J9K0M1N3";
export const QUESTION_ID = "qst_01JAB2C3D4E5F6G7H8J9K0M1N4";
export const MESSAGE_ID = "msg_01JAB2C3D4E5F6G7H8J9K0M1N6";
export const MODEL_ID = "openai/gpt-5";

export const BASE_TS = "2026-10-26T10:00:00.000Z";

/** A timestamp `seconds` after the base time, so event order reads clearly. */
export function at(seconds: number): string {
  return new Date(Date.parse(BASE_TS) + seconds * 1000).toISOString();
}

/** Fields every builder accepts; `null` leaves a correlation ID out of the event. */
export interface EventOptions {
  seq?: number;
  ts?: string;
  projectId?: string;
  sessionId?: string | null;
  turnId?: string | null;
  callId?: string | null;
}

function withBase(
  type: string,
  options: EventOptions,
  payload: Record<string, unknown>,
): RuntimeEventBase {
  const {
    seq = 0,
    ts = BASE_TS,
    projectId = PROJECT_ID,
    sessionId = SESSION_ID,
    turnId = TURN_ID,
    callId,
  } = options;
  return {
    seq,
    ts,
    type,
    projectId,
    ...(sessionId !== null && { sessionId }),
    ...(turnId !== null && { turnId }),
    ...(callId !== null && callId !== undefined && { callId }),
    ...payload,
  } as RuntimeEventBase;
}

export function fileChange(overrides: Partial<FileChange> = {}): FileChange {
  return {
    path: "src/a.ts",
    change: "modified",
    added: 2,
    removed: 1,
    ...overrides,
  };
}

export function summary(overrides: Partial<TurnSummary> = {}): TurnSummary {
  return {
    files: [],
    steps: 1,
    toolCalls: 0,
    inputTokens: 100,
    outputTokens: 200,
    costUsd: 0.001,
    verification: null,
    hiddenSecrets: 0,
    ...overrides,
  };
}

export function providerError(overrides: Partial<ProviderError> = {}): ProviderError {
  return {
    category: "rate_limited",
    message: "OpenRouter is busy",
    retryable: true,
    ...overrides,
  };
}

export function toolError(overrides: Partial<ToolError> = {}): ToolError {
  return {
    code: "process_failed",
    message: "Exit code 1",
    retryable: false,
    ...overrides,
  };
}

export function errorData(overrides: Partial<JesutobitsErrorData> = {}): JesutobitsErrorData {
  return {
    code: "provider.rate_limited",
    message: "OpenRouter is busy",
    retryable: true,
    ...overrides,
  };
}

export function turnStarted(
  options: EventOptions & {
    mode?: TurnMode;
    modelId?: string;
    /** `null` starts a retry, which carries no message of its own. */
    text?: string | null;
    retryOf?: string;
  } = {},
): RuntimeEventBase {
  const { mode = "agent", modelId = MODEL_ID, text = "Add a date picker", retryOf } = options;
  return withBase("turn.started", options, {
    mode,
    modelId,
    ...(text !== null && { message: { id: MESSAGE_ID, text } }),
    ...(retryOf !== undefined && { retryOf }),
  });
}

export function turnStateChanged(
  options: EventOptions & {
    to: TurnState;
    from?: TurnState | null;
    reason?: TurnStateReason;
  },
): RuntimeEventBase {
  const { to, from = null, reason } = options;
  return withBase("turn.state_changed", options, {
    from,
    to,
    ...(reason !== undefined && { reason }),
  });
}

export function turnCompleted(
  options: EventOptions & { summary?: TurnSummary } = {},
): RuntimeEventBase {
  return withBase("turn.completed", options, { summary: options.summary ?? summary() });
}

export function turnCancelled(
  options: EventOptions & { summary?: TurnSummary } = {},
): RuntimeEventBase {
  return withBase("turn.cancelled", options, { summary: options.summary ?? summary() });
}

export function turnFailed(
  options: EventOptions & { error?: JesutobitsErrorData; summary?: TurnSummary } = {},
): RuntimeEventBase {
  return withBase("turn.failed", options, {
    error: options.error ?? errorData(),
    summary: options.summary ?? summary(),
  });
}

export function turnInterrupted(options: EventOptions = {}): RuntimeEventBase {
  return withBase("turn.interrupted", options, {});
}

export function modelRequestStarted(
  options: EventOptions & { step?: number; attempt?: number; modelId?: string } = {},
): RuntimeEventBase {
  const { step = 0, attempt = 1, modelId = MODEL_ID } = options;
  return withBase("model.request_started", options, { step, attempt, modelId });
}

export function modelTextDelta(
  options: EventOptions & { step?: number; text: string },
): RuntimeEventBase {
  const { step = 0, text } = options;
  return withBase("model.text_delta", options, { step, text });
}

export function modelReasoningDelta(
  options: EventOptions & { step?: number; text: string },
): RuntimeEventBase {
  const { step = 0, text } = options;
  return withBase("model.reasoning_delta", options, { step, text });
}

export function modelStepCompleted(
  options: EventOptions & {
    step?: number;
    text: string;
    toolCalls?: Array<{ callId: string; tool: string }>;
    finishReason?: "stop" | "tool_calls" | "length" | "content_filter" | "error";
  },
): RuntimeEventBase {
  const { step = 0, text, toolCalls = [], finishReason = "stop" } = options;
  return withBase("model.step_completed", options, { step, text, toolCalls, finishReason });
}

export function modelUsage(
  options: EventOptions & {
    step?: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    turnCostUsd?: number;
    sessionCostUsd?: number;
  } = {},
): RuntimeEventBase {
  const {
    step = 0,
    inputTokens = 100,
    outputTokens = 200,
    costUsd = 0.001,
    turnCostUsd = 0.001,
    sessionCostUsd = 0.001,
  } = options;
  return withBase("model.usage", options, {
    step,
    inputTokens,
    outputTokens,
    costUsd,
    turnCostUsd,
    sessionCostUsd,
  });
}

export function modelError(
  options: EventOptions & {
    step?: number;
    attempt?: number;
    error?: ProviderError;
    retryInMs?: number;
  } = {},
): RuntimeEventBase {
  const { step = 0, attempt = 1, error = providerError(), retryInMs } = options;
  return withBase("model.error", options, {
    step,
    attempt,
    error,
    ...(retryInMs !== undefined && { retryInMs }),
  });
}

export function planUpdated(options: EventOptions & { items: PlanItem[] }): RuntimeEventBase {
  return withBase("plan.updated", options, { items: options.items });
}

export function toolStarted(
  options: EventOptions & {
    callId?: string;
    tool?: string;
    category?: ActivityCategory;
    summary?: string;
    risk?: RiskClass[];
    inputPreview?: Record<string, unknown>;
  } = {},
): RuntimeEventBase {
  const {
    callId = CALL_ID,
    tool = "edit_file",
    category = "editing",
    summary = "Editing src/a.ts",
    risk = ["write"],
    inputPreview = { path: "src/a.ts" },
  } = options;
  return withBase(
    "tool.started",
    { ...options, callId },
    {
      tool,
      category,
      summary,
      risk,
      inputPreview,
    },
  );
}

export function toolCompleted(
  options: EventOptions & {
    callId?: string;
    tool?: string;
    ok?: boolean;
    durationMs?: number;
    summary?: string;
    outputPreview?: string;
    diff?: FileChange[];
    error?: ToolError;
  } = {},
): RuntimeEventBase {
  const {
    callId = CALL_ID,
    tool = "edit_file",
    ok = true,
    durationMs = 10,
    summary: text = "Edited src/a.ts",
    outputPreview,
    diff,
    error,
  } = options;
  return withBase(
    "tool.completed",
    { ...options, callId },
    {
      tool,
      ok,
      durationMs,
      summary: text,
      ...(outputPreview !== undefined && { outputPreview }),
      ...(diff !== undefined && { diff }),
      ...(error !== undefined && { error }),
    },
  );
}

export function permissionRequested(
  options: EventOptions & {
    permissionId?: string;
    tool?: string;
    action?: PermissionAction;
    risk?: RiskClass[];
    reasons?: string[];
    agentExplanation?: string;
    diff?: string;
    sessionRule?: string;
    offered?: PermissionDecision[];
  } = {},
): RuntimeEventBase {
  const {
    permissionId = PERMISSION_ID,
    tool = "edit_file",
    action = { kind: "file", op: "write", paths: ["src/a.ts"] },
    risk = ["write"],
    reasons = ["Changes files in the project"],
    agentExplanation,
    diff,
    sessionRule,
    offered = ["allow_once", "deny"],
  } = options;
  return withBase("permission.requested", options, {
    permissionId,
    tool,
    action,
    risk,
    reasons,
    ...(agentExplanation !== undefined && { agentExplanation }),
    ...(diff !== undefined && { diff }),
    ...(sessionRule !== undefined && { sessionRule }),
    options: offered,
  });
}

export function permissionResolved(
  options: EventOptions & {
    permissionId?: string;
    decision: PermissionDecision | "withdrawn";
  },
): RuntimeEventBase {
  const { permissionId = PERMISSION_ID, decision } = options;
  return withBase("permission.resolved", options, { permissionId, decision });
}

export function questionAsked(
  options: EventOptions & {
    questionId?: string;
    question?: string;
    choices?: string[];
    source?: "agent" | "limit" | "loop";
  } = {},
): RuntimeEventBase {
  const {
    questionId = QUESTION_ID,
    question = "Which database should I use?",
    choices = [],
    source = "agent",
  } = options;
  return withBase("question.asked", options, { questionId, question, options: choices, source });
}

export function questionAnswered(
  options: EventOptions & { questionId?: string; answer: string | null },
): RuntimeEventBase {
  const { questionId = QUESTION_ID, answer } = options;
  return withBase("question.answered", options, { questionId, answer });
}

export function runtimeWarning(
  options: EventOptions & { message?: string; code?: string } = {},
): RuntimeEventBase {
  const { message = "The provider was slow", code } = options;
  return withBase("runtime.warning", options, {
    message,
    ...(code !== undefined && { code }),
  });
}

export function sessionUpdated(options: EventOptions & { session: Session }): RuntimeEventBase {
  return withBase("session.updated", options, { session: options.session });
}
