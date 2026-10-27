import type { RuntimeEventBase } from "@jesutobits/protocol";
import { describe, expect, it } from "vitest";
import {
  applyEvent,
  applyEvents,
  EMPTY_TIMELINE,
  liveTurn,
  type SessionTimeline,
  type TimelineItem,
  type TurnView,
} from "./timeline-reducer";
import {
  at,
  BASE_TS,
  CALL_ID,
  fileChange,
  MODEL_ID,
  modelError,
  modelReasoningDelta,
  modelRequestStarted,
  modelStepCompleted,
  modelTextDelta,
  modelUsage,
  OTHER_TURN_ID,
  PERMISSION_ID,
  permissionRequested,
  permissionResolved,
  planUpdated,
  PROJECT_ID,
  QUESTION_ID,
  questionAsked,
  questionAnswered,
  runtimeWarning,
  SESSION_ID,
  summary,
  toolCompleted,
  toolStarted,
  TURN_ID,
  turnCancelled,
  turnCompleted,
  turnFailed,
  turnInterrupted,
  turnStarted,
  turnStateChanged,
} from "./test-events";

const FAILED_CALL_ID = "call_01JAB2C3D4E5F6G7H8J9K0M1N8";
const SECOND_QUESTION_ID = "qst_01JAB2C3D4E5F6G7H8J9K0M1N8";

function turnAt(timeline: SessionTimeline, index = 0): TurnView {
  const found = timeline.turns[index];
  if (!found) throw new Error(`No turn at index ${index}`);
  return found;
}

function itemOfKind<K extends TimelineItem["kind"]>(
  timeline: SessionTimeline,
  kind: K,
  match: (item: Extract<TimelineItem, { kind: K }>) => boolean = () => true,
): Extract<TimelineItem, { kind: K }> {
  const found = turnAt(timeline).items.find(
    (item) => item.kind === kind && match(item as Extract<TimelineItem, { kind: K }>),
  ) as Extract<TimelineItem, { kind: K }> | undefined;
  if (!found) throw new Error(`No ${kind} item`);
  return found;
}

const messageAt = (timeline: SessionTimeline, step = 0) =>
  itemOfKind(timeline, "message", (item) => item.step === step);
const toolAt = (timeline: SessionTimeline, callId = CALL_ID) =>
  itemOfKind(timeline, "tool", (item) => item.callId === callId);
const permissionAt = (timeline: SessionTimeline) => itemOfKind(timeline, "permission");
const questionAt = (timeline: SessionTimeline, questionId = QUESTION_ID) =>
  itemOfKind(timeline, "question", (item) => item.questionId === questionId);

/** A turn with a streaming message, a running tool, an open approval and an open question. */
function openTurn(): SessionTimeline {
  let timeline = applyEvent(EMPTY_TIMELINE, turnStarted({ seq: 1, text: "Add a date picker" }));
  timeline = applyEvent(timeline, modelRequestStarted({ seq: 2, step: 0 }));
  timeline = applyEvent(timeline, modelTextDelta({ seq: 3, step: 0, text: "Partial" }));
  timeline = applyEvent(timeline, toolStarted({ seq: 4 }));
  timeline = applyEvent(timeline, permissionRequested({ seq: 5 }));
  timeline = applyEvent(timeline, questionAsked({ seq: 6, choices: ["Postgres", "SQLite"] }));
  return timeline;
}

describe("timeline reducer", () => {
  it("starts a turn with the user's text and ignores a duplicate turn.started", () => {
    const started = turnStarted({ seq: 1, text: "Add a date picker" });
    const timeline = applyEvent(EMPTY_TIMELINE, started);

    expect(timeline.turns).toHaveLength(1);
    const turn = turnAt(timeline);
    expect(turn.turnId).toBe(TURN_ID);
    expect(turn.userText).toBe("Add a date picker");
    expect(turn.mode).toBe("agent");
    expect(turn.modelId).toBe(MODEL_ID);
    expect(turn.state).toBe("understanding");
    expect(turn.startedAt).toBe(BASE_TS);
    expect(turn.endedAt).toBeUndefined();

    const duplicate = applyEvent(timeline, turnStarted({ seq: 2, text: "Something else" }));
    expect(duplicate).toBe(timeline);
    expect(turnAt(duplicate).userText).toBe("Add a date picker");
  });

  it("follows turn.state_changed, records the end time and adds a compaction item", () => {
    let timeline = applyEvent(EMPTY_TIMELINE, turnStarted({ seq: 1 }));

    timeline = applyEvent(timeline, turnStateChanged({ seq: 2, to: "thinking" }));
    expect(turnAt(timeline).state).toBe("thinking");
    expect(turnAt(timeline).endedAt).toBeUndefined();

    timeline = applyEvent(timeline, turnStateChanged({ seq: 3, to: "paused", reason: "pause" }));
    expect(turnAt(timeline).reason).toBe("pause");
    timeline = applyEvent(timeline, turnStateChanged({ seq: 4, to: "thinking" }));
    expect(turnAt(timeline).reason).toBeUndefined();

    timeline = applyEvent(timeline, turnStateChanged({ seq: 5, to: "compacting", ts: at(3) }));
    expect(turnAt(timeline).state).toBe("compacting");
    expect(turnAt(timeline).items).toEqual([{ kind: "compaction", at: at(3) }]);

    timeline = applyEvent(timeline, turnStateChanged({ seq: 6, to: "completed", ts: at(9) }));
    expect(turnAt(timeline).state).toBe("completed");
    expect(turnAt(timeline).endedAt).toBe(at(9));
  });

  it("accumulates text and reasoning per step, and a retried attempt starts the text again", () => {
    let timeline = applyEvent(EMPTY_TIMELINE, turnStarted({ seq: 1 }));
    timeline = applyEvent(timeline, modelRequestStarted({ seq: 2, step: 0, attempt: 1 }));
    timeline = applyEvent(timeline, modelTextDelta({ seq: 3, step: 0, text: "Hel" }));
    timeline = applyEvent(timeline, modelTextDelta({ seq: 4, step: 0, text: "lo" }));
    timeline = applyEvent(timeline, modelReasoningDelta({ seq: 5, step: 0, text: "Thinking" }));
    timeline = applyEvent(timeline, modelReasoningDelta({ seq: 6, step: 0, text: " it through" }));

    expect(messageAt(timeline, 0)).toMatchObject({
      text: "Hello",
      reasoning: "Thinking it through",
      complete: false,
    });

    timeline = applyEvent(timeline, modelTextDelta({ seq: 7, step: 1, text: "Second step" }));
    expect(messageAt(timeline, 1).text).toBe("Second step");
    expect(messageAt(timeline, 0).text).toBe("Hello");

    timeline = applyEvent(timeline, modelRequestStarted({ seq: 8, step: 0, attempt: 2 }));
    expect(messageAt(timeline, 0)).toMatchObject({ text: "", reasoning: "", complete: false });
    expect(messageAt(timeline, 1).text).toBe("Second step");

    timeline = applyEvent(timeline, modelTextDelta({ seq: 9, step: 0, text: "New" }));
    timeline = applyEvent(timeline, modelReasoningDelta({ seq: 10, step: 0, text: "Again" }));
    timeline = applyEvent(
      timeline,
      modelStepCompleted({ seq: 11, step: 0, text: "The full answer" }),
    );

    expect(messageAt(timeline, 0)).toMatchObject({
      text: "The full answer",
      reasoning: "Again",
      complete: true,
    });
  });

  it("takes a tool from running to ok with its duration and diff, and to failed with its error", () => {
    let timeline = applyEvent(EMPTY_TIMELINE, turnStarted({ seq: 1 }));
    timeline = applyEvent(timeline, toolStarted({ seq: 2, callId: CALL_ID }));

    expect(toolAt(timeline)).toMatchObject({
      status: "running",
      startedAt: BASE_TS,
      tool: "edit_file",
      category: "editing",
      risk: ["write"],
      inputPreview: { path: "src/a.ts" },
    });

    const diff = [fileChange({ path: "src/a.ts", change: "modified", added: 3, removed: 1 })];
    timeline = applyEvent(
      timeline,
      toolCompleted({
        seq: 3,
        callId: CALL_ID,
        ok: true,
        durationMs: 1_200,
        summary: "Edited src/a.ts (+3 −1)",
        diff,
      }),
    );
    expect(toolAt(timeline)).toMatchObject({
      status: "ok",
      durationMs: 1_200,
      summary: "Edited src/a.ts (+3 −1)",
      diff,
    });
    expect(toolAt(timeline).error).toBeUndefined();

    timeline = applyEvent(
      timeline,
      toolStarted({
        seq: 4,
        callId: FAILED_CALL_ID,
        tool: "run_command",
        category: "running",
        summary: "Running the tests",
      }),
    );
    timeline = applyEvent(
      timeline,
      toolCompleted({
        seq: 5,
        callId: FAILED_CALL_ID,
        tool: "run_command",
        ok: false,
        durationMs: 250,
        summary: "Tests failed",
        error: { code: "process_failed", message: "Exit code 1", retryable: false },
      }),
    );

    expect(toolAt(timeline, FAILED_CALL_ID)).toMatchObject({
      status: "failed",
      durationMs: 250,
      error: { code: "process_failed", message: "Exit code 1" },
    });
  });

  it("adds a tool row from tool.completed alone", () => {
    const timeline = applyEvents(EMPTY_TIMELINE, [
      turnStarted({ seq: 1 }),
      toolCompleted({ seq: 2, callId: CALL_ID, ok: true, summary: "Read src/a.ts" }),
    ]);

    expect(toolAt(timeline)).toMatchObject({
      status: "ok",
      category: "reading",
      risk: [],
      inputPreview: {},
      startedAt: BASE_TS,
      summary: "Read src/a.ts",
    });
  });

  it("adds one approval card per permission and records its decision", () => {
    let timeline = applyEvent(EMPTY_TIMELINE, turnStarted({ seq: 1 }));
    timeline = applyEvent(
      timeline,
      permissionRequested({
        seq: 2,
        risk: ["write", "destructive"],
        reasons: ["Writes a file in the project"],
        agentExplanation: "The title needs to change.",
        diff: "+new",
        sessionRule: "Change files in src/",
        offered: ["allow_once", "allow_session", "deny"],
      }),
    );

    expect(permissionAt(timeline)).toMatchObject({
      permissionId: PERMISSION_ID,
      decision: null,
      action: { kind: "file", op: "write", paths: ["src/a.ts"] },
      options: ["allow_once", "allow_session", "deny"],
      agentExplanation: "The title needs to change.",
    });

    const duplicate = applyEvent(timeline, permissionRequested({ seq: 3 }));
    expect(duplicate).toBe(timeline);
    expect(turnAt(duplicate).items).toHaveLength(1);

    timeline = applyEvent(timeline, permissionResolved({ seq: 4, decision: "allow_session" }));
    expect(permissionAt(timeline).decision).toBe("allow_session");
  });

  it("adds one question per questionId and records the answer, including a closed one", () => {
    let timeline = applyEvent(EMPTY_TIMELINE, turnStarted({ seq: 1 }));
    timeline = applyEvent(
      timeline,
      questionAsked({ seq: 2, choices: ["Postgres", "SQLite"], source: "agent" }),
    );

    expect(questionAt(timeline)).toMatchObject({
      questionId: QUESTION_ID,
      options: ["Postgres", "SQLite"],
      source: "agent",
    });
    // Undefined while the question is open (timeline-reducer.ts, QuestionItem).
    expect(questionAt(timeline).answer).toBeUndefined();

    const duplicate = applyEvent(timeline, questionAsked({ seq: 3 }));
    expect(duplicate).toBe(timeline);
    expect(turnAt(duplicate).items).toHaveLength(1);

    timeline = applyEvent(timeline, questionAnswered({ seq: 4, answer: "SQLite" }));
    expect(questionAt(timeline).answer).toBe("SQLite");

    timeline = applyEvent(
      timeline,
      questionAsked({ seq: 5, questionId: SECOND_QUESTION_ID, question: "Any preference?" }),
    );
    timeline = applyEvent(
      timeline,
      questionAnswered({ seq: 6, questionId: SECOND_QUESTION_ID, answer: null }),
    );
    expect(questionAt(timeline, SECOND_QUESTION_ID).answer).toBeNull();
  });

  it("keeps the latest plan, the turn cost and model errors, and only warns for a turn", () => {
    let timeline = applyEvent(EMPTY_TIMELINE, turnStarted({ seq: 1 }));

    timeline = applyEvent(
      timeline,
      planUpdated({
        seq: 2,
        items: [{ id: "1", text: "Read the file", status: "in_progress" }],
      }),
    );
    const latest = [
      { id: "1", text: "Read the file", status: "done" as const },
      { id: "2", text: "Edit it", status: "pending" as const },
    ];
    timeline = applyEvent(timeline, planUpdated({ seq: 3, items: latest }));
    expect(turnAt(timeline).plan).toEqual(latest);

    timeline = applyEvent(timeline, modelUsage({ seq: 4, turnCostUsd: 0.042 }));
    expect(turnAt(timeline).costUsd).toBe(0.042);

    timeline = applyEvent(timeline, modelError({ seq: 5, attempt: 2, retryInMs: 2_000 }));
    expect(itemOfKind(timeline, "model_error")).toMatchObject({
      kind: "model_error",
      step: 0,
      attempt: 2,
      retryInMs: 2_000,
      error: { category: "rate_limited" },
    });

    timeline = applyEvent(timeline, runtimeWarning({ seq: 6, message: "The provider was slow" }));
    expect(turnAt(timeline).items.at(-1)).toEqual({
      kind: "warning",
      message: "The provider was slow",
    });

    const withoutTurn = applyEvent(
      timeline,
      runtimeWarning({ seq: 7, turnId: null, message: "Not about a turn" }),
    );
    expect(withoutTurn).toBe(timeline);
    expect(turnAt(withoutTurn).items).toHaveLength(2);
  });

  it("closes open items when a turn completes, and keeps the summary", () => {
    const files = [fileChange({ path: "src/a.ts", change: "modified", added: 3, removed: 1 })];
    const timeline = applyEvent(
      openTurn(),
      turnCompleted({ seq: 7, summary: summary({ files, verification: "unverified" }) }),
    );
    const turn = turnAt(timeline);

    expect(turn.state).toBe("completed");
    expect(turn.summary).toEqual(summary({ files, verification: "unverified" }));
    expect(turn.endedAt).toBe(BASE_TS);

    const tool = toolAt(timeline);
    expect(tool.status).toBe("stopped");
    expect(tool.status).not.toBe("failed");
    expect(tool.status).not.toBe("ok");
    expect(permissionAt(timeline).decision).toBe("withdrawn");
    expect(questionAt(timeline).answer).toBeNull();
    expect(messageAt(timeline).complete).toBe(true);
  });

  it("closes open items when a turn is cancelled", () => {
    const timeline = applyEvent(openTurn(), turnCancelled({ seq: 7 }));

    expect(turnAt(timeline).state).toBe("cancelled");
    expect(turnAt(timeline).summary).toEqual(summary());
    expect(turnAt(timeline).error).toBeUndefined();
    expect(toolAt(timeline).status).toBe("stopped");
    expect(permissionAt(timeline).decision).toBe("withdrawn");
    expect(questionAt(timeline).answer).toBeNull();
  });

  it("closes open items when a turn fails, and keeps its error", () => {
    const error = {
      code: "provider.rate_limited" as const,
      message: "OpenRouter is busy",
      retryable: true,
    };
    const timeline = applyEvent(openTurn(), turnFailed({ seq: 7, error }));

    expect(turnAt(timeline).state).toBe("failed");
    expect(turnAt(timeline).error).toEqual(error);
    expect(turnAt(timeline).summary).toEqual(summary());
    expect(toolAt(timeline).status).toBe("stopped");
    expect(permissionAt(timeline).decision).toBe("withdrawn");
    expect(questionAt(timeline).answer).toBeNull();
  });

  it("marks a turn interrupted and closes what was running", () => {
    const timeline = applyEvent(openTurn(), turnInterrupted({ seq: 7 }));

    expect(turnAt(timeline).state).toBe("interrupted");
    expect(turnAt(timeline).endedAt).toBe(BASE_TS);
    expect(toolAt(timeline).status).toBe("stopped");
    expect(permissionAt(timeline).decision).toBe("withdrawn");
    expect(questionAt(timeline).answer).toBeNull();
  });

  it("leaves the timeline unchanged for a malformed payload or an unknown type", () => {
    const timeline = applyEvent(EMPTY_TIMELINE, turnStarted({ seq: 1 }));

    const missingFields = {
      seq: 2,
      ts: BASE_TS,
      type: "turn.state_changed",
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
    } as RuntimeEventBase;
    expect(applyEvent(timeline, missingFields)).toBe(timeline);

    const badId = permissionRequested({ seq: 3, permissionId: "perm_not-an-id" });
    expect(applyEvent(timeline, badId)).toBe(timeline);

    const unknown = {
      seq: 4,
      ts: BASE_TS,
      type: "mystery.event",
      projectId: PROJECT_ID,
    } as RuntimeEventBase;
    expect(applyEvent(timeline, unknown)).toBe(timeline);
    expect(turnAt(timeline).items).toHaveLength(0);
  });

  it("folds a recorded sequence exactly as live events, and reports only the last live turn", () => {
    const events: RuntimeEventBase[] = [
      turnStarted({ seq: 1 }),
      modelRequestStarted({ seq: 2, step: 0 }),
      modelTextDelta({ seq: 3, step: 0, text: "Hello" }),
      modelStepCompleted({ seq: 4, step: 0, text: "Hello" }),
    ];
    const folded = events.reduce(applyEvent, EMPTY_TIMELINE);

    expect(applyEvents(EMPTY_TIMELINE, events)).toEqual(folded);
    expect(liveTurn(folded)?.turnId).toBe(TURN_ID);

    const completed = applyEvents(folded, [turnCompleted({ seq: 5 })]);
    expect(liveTurn(completed)).toBeUndefined();

    const second = applyEvents(completed, [
      turnStarted({ seq: 6, turnId: OTHER_TURN_ID, text: "A second turn" }),
    ]);
    expect(liveTurn(second)?.turnId).toBe(OTHER_TURN_ID);

    const lastIsFinal = applyEvents(second, [
      turnStarted({ seq: 7, turnId: "trn_01JAB2C3D4E5F6G7H8J9K0M1N8", text: "A third turn" }),
      turnCompleted({ seq: 8, turnId: "trn_01JAB2C3D4E5F6G7H8J9K0M1N8" }),
    ]);
    expect(liveTurn(lastIsFinal)).toBeUndefined();
    expect(turnAt(lastIsFinal, 1).state).toBe("understanding");
  });
});
