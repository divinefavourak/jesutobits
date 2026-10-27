import {
  getEvent,
  isFinalTurnState,
  type ActivityCategory,
  type FileChange,
  type JesutobitsErrorData,
  type PermissionAction,
  type PermissionDecision,
  type PlanItem,
  type ProviderError,
  type RiskClass,
  type RuntimeEventBase,
  type ToolError,
  type TurnMode,
  type TurnState,
  type TurnStateReason,
  type TurnSummary,
} from "@jesutobits/protocol";

/**
 * A session's activity as the Workbench shows it, folded from runtime events (invariant 6).
 * Live events and stored history (`sessions.history`) go through the same `applyEvent`, so
 * a reloaded session looks exactly as it did live. Nothing here is invented: every field
 * comes from an event.
 */
export interface SessionTimeline {
  turns: TurnView[];
}

export interface TurnView {
  turnId: string;
  mode: TurnMode;
  modelId: string;
  /** The user's message; absent for a retry. */
  userText?: string;
  retryOf?: string;
  state: TurnState;
  reason?: TurnStateReason;
  startedAt: string;
  endedAt?: string;
  /** In order of arrival. */
  items: TimelineItem[];
  /** The latest plan the agent declared. */
  plan?: PlanItem[];
  summary?: TurnSummary;
  error?: JesutobitsErrorData;
  costUsd: number;
}

export type TimelineItem =
  | {
      kind: "message";
      step: number;
      /** Streamed so far, or the step's full text once complete. */
      text: string;
      reasoning: string;
      complete: boolean;
    }
  | {
      kind: "tool";
      callId: string;
      tool: string;
      category: ActivityCategory;
      summary: string;
      risk: RiskClass[];
      inputPreview: Record<string, unknown>;
      /** `stopped`: the turn ended while it ran, so its outcome is unknown. */
      status: "running" | "ok" | "failed" | "stopped";
      startedAt: string;
      durationMs?: number;
      outputPreview?: string;
      diff?: FileChange[];
      error?: ToolError;
    }
  | {
      kind: "permission";
      permissionId: string;
      callId?: string;
      tool: string;
      action: PermissionAction;
      risk: RiskClass[];
      reasons: string[];
      agentExplanation?: string;
      diff?: string;
      sessionRule?: string;
      options: PermissionDecision[];
      /** Null while it waits for an answer. */
      decision: PermissionDecision | "withdrawn" | null;
    }
  | {
      kind: "question";
      questionId: string;
      question: string;
      options: string[];
      source: "agent" | "limit" | "loop";
      /** Undefined while open; null when it closed unanswered. */
      answer?: string | null;
    }
  | {
      kind: "model_error";
      step: number;
      attempt: number;
      error: ProviderError;
      retryInMs?: number;
    }
  | { kind: "compaction"; at: string }
  | { kind: "warning"; message: string; code?: string };

export const EMPTY_TIMELINE: SessionTimeline = { turns: [] };

type Ev = RuntimeEventBase & Record<string, unknown>;

/** Validates an event against its schema; unknown or malformed events are ignored. */
function parse<T>(event: RuntimeEventBase): (Ev & T) | undefined {
  const definition = getEvent(event.type);
  if (!definition) return undefined;
  const result = definition.schema.safeParse(event);
  return result.success ? (result.data as Ev & T) : undefined;
}

function updateTurn(
  timeline: SessionTimeline,
  turnId: string | undefined,
  update: (turn: TurnView) => TurnView,
): SessionTimeline {
  if (!turnId) return timeline;
  const index = timeline.turns.findIndex((turn) => turn.turnId === turnId);
  if (index === -1) return timeline;
  const turns = [...timeline.turns];
  turns[index] = update(turns[index] as TurnView);
  return { turns };
}

function withItem(
  turn: TurnView,
  match: (item: TimelineItem) => boolean,
  update: (item: TimelineItem | undefined) => TimelineItem,
): TurnView {
  const index = turn.items.findIndex(match);
  const items = [...turn.items];
  if (index === -1) items.push(update(undefined));
  else items[index] = update(items[index]);
  return { ...turn, items };
}

function hasItem(
  timeline: SessionTimeline,
  turnId: string | undefined,
  match: (item: TimelineItem) => boolean,
): boolean {
  return timeline.turns.some((turn) => turn.turnId === turnId && turn.items.some(match));
}

const isMessage = (step: number) => (item: TimelineItem) =>
  item.kind === "message" && item.step === step;

/** Folds one event into the timeline. Pure: returns a new timeline or the same one. */
export function applyEvent(timeline: SessionTimeline, event: RuntimeEventBase): SessionTimeline {
  switch (event.type) {
    case "turn.started": {
      const e = parse<{
        mode: TurnMode;
        modelId: string;
        message?: { id: string; text: string };
        retryOf?: string;
      }>(event);
      if (!e?.turnId || timeline.turns.some((turn) => turn.turnId === e.turnId)) return timeline;
      const turn: TurnView = {
        turnId: e.turnId,
        mode: e.mode,
        modelId: e.modelId,
        state: "understanding",
        startedAt: e.ts,
        items: [],
        costUsd: 0,
        ...(e.message && { userText: e.message.text }),
        ...(e.retryOf && { retryOf: e.retryOf }),
      };
      return { turns: [...timeline.turns, turn] };
    }
    case "turn.state_changed": {
      const e = parse<{ to: TurnState; reason?: TurnStateReason }>(event);
      if (!e) return timeline;
      return updateTurn(timeline, e.turnId, (turn) => {
        const next: TurnView = { ...turn, state: e.to };
        if (e.reason) next.reason = e.reason;
        else delete next.reason;
        if (isFinalTurnState(e.to)) next.endedAt = e.ts;
        if (e.to === "compacting") next.items = [...turn.items, { kind: "compaction", at: e.ts }];
        return next;
      });
    }
    case "turn.completed":
    case "turn.cancelled": {
      const e = parse<{ summary: TurnSummary }>(event);
      if (!e) return timeline;
      const state: TurnState = event.type === "turn.completed" ? "completed" : "cancelled";
      return updateTurn(timeline, e.turnId, (turn) => ({
        ...turn,
        state,
        summary: e.summary,
        endedAt: turn.endedAt ?? e.ts,
        items: closeOpen(turn.items),
      }));
    }
    case "turn.failed": {
      const e = parse<{ error: JesutobitsErrorData; summary: TurnSummary }>(event);
      if (!e) return timeline;
      return updateTurn(timeline, e.turnId, (turn) => ({
        ...turn,
        state: "failed",
        summary: e.summary,
        error: e.error,
        endedAt: turn.endedAt ?? e.ts,
        items: closeOpen(turn.items),
      }));
    }
    case "turn.interrupted": {
      const e = parse(event);
      if (!e) return timeline;
      return updateTurn(timeline, e.turnId, (turn) => ({
        ...turn,
        state: "interrupted",
        endedAt: turn.endedAt ?? e.ts,
        items: closeOpen(turn.items),
      }));
    }
    case "model.request_started": {
      const e = parse<{ step: number; attempt: number }>(event);
      if (!e) return timeline;
      // A retried attempt starts the step's text again.
      return updateTurn(timeline, e.turnId, (turn) =>
        withItem(turn, isMessage(e.step), () => ({
          kind: "message",
          step: e.step,
          text: "",
          reasoning: "",
          complete: false,
        })),
      );
    }
    case "model.text_delta":
    case "model.reasoning_delta": {
      const e = parse<{ step: number; text: string }>(event);
      if (!e) return timeline;
      const reasoning = event.type === "model.reasoning_delta";
      return updateTurn(timeline, e.turnId, (turn) =>
        withItem(turn, isMessage(e.step), (item) => {
          const base =
            item?.kind === "message"
              ? item
              : {
                  kind: "message" as const,
                  step: e.step,
                  text: "",
                  reasoning: "",
                  complete: false,
                };
          return reasoning
            ? { ...base, reasoning: base.reasoning + e.text }
            : { ...base, text: base.text + e.text };
        }),
      );
    }
    case "model.step_completed": {
      const e = parse<{ step: number; text: string }>(event);
      if (!e) return timeline;
      return updateTurn(timeline, e.turnId, (turn) =>
        withItem(turn, isMessage(e.step), (item) => ({
          kind: "message",
          step: e.step,
          text: e.text,
          reasoning: item?.kind === "message" ? item.reasoning : "",
          complete: true,
        })),
      );
    }
    case "model.usage": {
      const e = parse<{ turnCostUsd: number }>(event);
      if (!e) return timeline;
      return updateTurn(timeline, e.turnId, (turn) => ({ ...turn, costUsd: e.turnCostUsd }));
    }
    case "model.error": {
      const e = parse<{ step: number; attempt: number; error: ProviderError; retryInMs?: number }>(
        event,
      );
      if (!e) return timeline;
      return updateTurn(timeline, e.turnId, (turn) => ({
        ...turn,
        items: [
          ...turn.items,
          {
            kind: "model_error",
            step: e.step,
            attempt: e.attempt,
            error: e.error,
            ...(e.retryInMs !== undefined && { retryInMs: e.retryInMs }),
          },
        ],
      }));
    }
    case "plan.updated": {
      const e = parse<{ items: PlanItem[] }>(event);
      if (!e) return timeline;
      return updateTurn(timeline, e.turnId, (turn) => ({ ...turn, plan: e.items }));
    }
    case "tool.started": {
      const e = parse<{
        tool: string;
        category: ActivityCategory;
        summary: string;
        risk: RiskClass[];
        inputPreview: Record<string, unknown>;
      }>(event);
      if (!e?.callId) return timeline;
      const callId = e.callId;
      return updateTurn(timeline, e.turnId, (turn) =>
        withItem(
          turn,
          (item) => item.kind === "tool" && item.callId === callId,
          () => ({
            kind: "tool",
            callId,
            tool: e.tool,
            category: e.category,
            summary: e.summary,
            risk: e.risk,
            inputPreview: e.inputPreview,
            status: "running",
            startedAt: e.ts,
          }),
        ),
      );
    }
    case "tool.completed": {
      const e = parse<{
        tool: string;
        ok: boolean;
        durationMs: number;
        summary: string;
        outputPreview?: string;
        diff?: FileChange[];
        error?: ToolError;
      }>(event);
      if (!e?.callId) return timeline;
      const callId = e.callId;
      return updateTurn(timeline, e.turnId, (turn) =>
        withItem(
          turn,
          (item) => item.kind === "tool" && item.callId === callId,
          (item) => ({
            kind: "tool",
            callId,
            tool: e.tool,
            category: item?.kind === "tool" ? item.category : "reading",
            summary: e.summary,
            risk: item?.kind === "tool" ? item.risk : [],
            inputPreview: item?.kind === "tool" ? item.inputPreview : {},
            startedAt: item?.kind === "tool" ? item.startedAt : e.ts,
            status: e.ok ? "ok" : "failed",
            durationMs: e.durationMs,
            ...(e.outputPreview !== undefined && { outputPreview: e.outputPreview }),
            ...(e.diff && { diff: e.diff }),
            ...(e.error && { error: e.error }),
          }),
        ),
      );
    }
    case "permission.requested": {
      const e = parse<{
        permissionId: string;
        tool: string;
        action: PermissionAction;
        risk: RiskClass[];
        reasons: string[];
        agentExplanation?: string;
        diff?: string;
        sessionRule?: string;
        options: PermissionDecision[];
      }>(event);
      if (!e) return timeline;
      if (
        hasItem(
          timeline,
          e.turnId,
          (item) => item.kind === "permission" && item.permissionId === e.permissionId,
        )
      ) {
        return timeline;
      }
      return updateTurn(timeline, e.turnId, (turn) => ({
        ...turn,
        items: [
          ...turn.items,
          {
            kind: "permission",
            permissionId: e.permissionId,
            ...(e.callId && { callId: e.callId }),
            tool: e.tool,
            action: e.action,
            risk: e.risk,
            reasons: e.reasons,
            ...(e.agentExplanation !== undefined && { agentExplanation: e.agentExplanation }),
            ...(e.diff !== undefined && { diff: e.diff }),
            ...(e.sessionRule !== undefined && { sessionRule: e.sessionRule }),
            options: e.options,
            decision: null,
          },
        ],
      }));
    }
    case "permission.resolved": {
      const e = parse<{ permissionId: string; decision: PermissionDecision | "withdrawn" }>(event);
      if (!e) return timeline;
      return updateTurn(timeline, e.turnId, (turn) => ({
        ...turn,
        items: turn.items.map((item) =>
          item.kind === "permission" && item.permissionId === e.permissionId
            ? { ...item, decision: e.decision }
            : item,
        ),
      }));
    }
    case "question.asked": {
      const e = parse<{
        questionId: string;
        question: string;
        options: string[];
        source: "agent" | "limit" | "loop";
      }>(event);
      if (!e) return timeline;
      if (
        hasItem(
          timeline,
          e.turnId,
          (item) => item.kind === "question" && item.questionId === e.questionId,
        )
      ) {
        return timeline;
      }
      return updateTurn(timeline, e.turnId, (turn) => ({
        ...turn,
        items: [
          ...turn.items,
          {
            kind: "question",
            questionId: e.questionId,
            question: e.question,
            options: e.options,
            source: e.source,
          },
        ],
      }));
    }
    case "question.answered": {
      const e = parse<{ questionId: string; answer: string | null }>(event);
      if (!e) return timeline;
      return updateTurn(timeline, e.turnId, (turn) => ({
        ...turn,
        items: turn.items.map((item) =>
          item.kind === "question" && item.questionId === e.questionId
            ? { ...item, answer: e.answer }
            : item,
        ),
      }));
    }
    case "runtime.warning": {
      const e = parse<{ message: string; code?: string }>(event);
      if (!e?.turnId) return timeline;
      return updateTurn(timeline, e.turnId, (turn) => ({
        ...turn,
        items: [
          ...turn.items,
          { kind: "warning", message: e.message, ...(e.code !== undefined && { code: e.code }) },
        ],
      }));
    }
    default:
      return timeline;
  }
}

/**
 * When a turn ends, nothing in it is still running: tools without a completion, open
 * approvals and questions are shown as ended (the runtime stopped them).
 */
function closeOpen(items: TimelineItem[]): TimelineItem[] {
  return items.map((item) => {
    if (item.kind === "tool" && item.status === "running") return { ...item, status: "stopped" };
    if (item.kind === "permission" && item.decision === null)
      return { ...item, decision: "withdrawn" };
    if (item.kind === "question" && item.answer === undefined) return { ...item, answer: null };
    if (item.kind === "message" && !item.complete) return { ...item, complete: true };
    return item;
  });
}

export function applyEvents(
  timeline: SessionTimeline,
  events: readonly RuntimeEventBase[],
): SessionTimeline {
  return events.reduce(applyEvent, timeline);
}

/** The turn still running, if any (the composer shows Stop instead of Send). */
export function liveTurn(timeline: SessionTimeline): TurnView | undefined {
  const last = timeline.turns.at(-1);
  return last && !isFinalTurnState(last.state) ? last : undefined;
}
