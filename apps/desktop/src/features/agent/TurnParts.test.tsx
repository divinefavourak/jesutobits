import type { MethodParams, RuntimeEventBase } from "@jesutobits/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { MockHostBridge } from "../../host-bridge";
import { createWorkbench, WorkbenchProvider, type Workbench } from "../../state/workbench-context";
import { PlanChecklist, QuestionCard, ToolRow, TurnSummaryCard } from "./TurnParts";
import {
  applyEvents,
  EMPTY_TIMELINE,
  type SessionTimeline,
  type TimelineItem,
  type TurnView,
} from "./timeline-reducer";
import {
  CALL_ID,
  fileChange,
  OTHER_TURN_ID,
  QUESTION_ID,
  questionAsked,
  questionAnswered,
  summary,
  toolCompleted,
  toolStarted,
  TURN_ID,
  turnCompleted,
  turnFailed,
  turnInterrupted,
  turnStarted,
} from "./test-events";

function makeWorkbench(): { bridge: MockHostBridge; workbench: Workbench } {
  const bridge = new MockHostBridge();
  return { bridge, workbench: createWorkbench(bridge) };
}

function mount(ui: ReactNode, workbench: Workbench): void {
  render(<WorkbenchProvider value={workbench}>{ui}</WorkbenchProvider>);
}

function fold(events: RuntimeEventBase[]): SessionTimeline {
  return applyEvents(EMPTY_TIMELINE, [turnStarted({ seq: 1 }), ...events]);
}

function turnOf(timeline: SessionTimeline): TurnView {
  const turn = timeline.turns[0];
  if (!turn) throw new Error("No turn");
  return turn;
}

function itemOfKind<K extends TimelineItem["kind"]>(
  timeline: SessionTimeline,
  kind: K,
): Extract<TimelineItem, { kind: K }> {
  const item = turnOf(timeline).items.find(
    (candidate): candidate is Extract<TimelineItem, { kind: K }> => candidate.kind === kind,
  );
  if (!item) throw new Error(`No ${kind} item`);
  return item;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = () => undefined;
});

describe("QuestionCard (FR-036)", () => {
  it("answers with an option button and with free text", async () => {
    const { bridge, workbench } = makeWorkbench();
    const answers: Array<MethodParams<"agent.answerQuestion">> = [];
    bridge.handle("agent.answerQuestion", (params) => {
      answers.push(params);
      return {};
    });

    const timeline = fold([questionAsked({ seq: 2, choices: ["Postgres", "SQLite"] })]);
    mount(<QuestionCard item={itemOfKind(timeline, "question")} />, workbench);

    await userEvent.click(screen.getByRole("button", { name: "Postgres" }));
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toEqual({ questionId: QUESTION_ID, answer: "Postgres" });

    await userEvent.type(screen.getByLabelText("Your answer"), "MySQL");
    await userEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(answers).toHaveLength(2));
    expect(answers[1]).toEqual({ questionId: QUESTION_ID, answer: "MySQL" });
  });

  it("shows the answer of an answered question", () => {
    const { workbench } = makeWorkbench();
    const timeline = fold([
      questionAsked({ seq: 2, choices: ["Postgres", "SQLite"] }),
      questionAnswered({ seq: 3, answer: "SQLite" }),
    ]);

    mount(<QuestionCard item={itemOfKind(timeline, "question")} />, workbench);

    expect(screen.getByText(/You answered: SQLite/)).toBeTruthy();
  });

  it("shows a question that closed without an answer", () => {
    const { workbench } = makeWorkbench();
    const timeline = fold([
      questionAsked({ seq: 2, source: "limit" }),
      questionAnswered({ seq: 3, answer: null }),
    ]);

    mount(<QuestionCard item={itemOfKind(timeline, "question")} />, workbench);

    expect(screen.getByText(/Closed without an answer/)).toBeTruthy();
  });
});

describe("PlanChecklist (FR-035)", () => {
  it("labels the plan as the agent's and shows every item", () => {
    const { workbench } = makeWorkbench();
    mount(
      <PlanChecklist
        items={[
          { id: "1", text: "Read the file", status: "done" },
          { id: "2", text: "Edit the title", status: "in_progress" },
          { id: "3", text: "Run the tests", status: "pending" },
        ]}
      />,
      workbench,
    );

    expect(screen.getByText(/Plan written by the agent/)).toBeTruthy();
    expect(screen.getByText("Read the file")).toBeTruthy();
    expect(screen.getByText("Edit the title")).toBeTruthy();
    expect(screen.getByText("Run the tests")).toBeTruthy();
  });
});

describe("ToolRow (UX_AND_INTERFACE.md section 6.3)", () => {
  it("says Stopped for a tool whose turn ended while it ran", () => {
    const { workbench } = makeWorkbench();
    const timeline = fold([toolStarted({ seq: 2 }), turnCompleted({ seq: 3 })]);

    mount(<ToolRow item={itemOfKind(timeline, "tool")} />, workbench);

    expect(screen.getByText("Stopped")).toBeTruthy();
    expect(screen.queryByText("Running")).toBeNull();
  });

  it("shows no Running badge once a tool completed", () => {
    const { workbench } = makeWorkbench();
    const timeline = fold([
      toolStarted({ seq: 2 }),
      toolCompleted({ seq: 3, callId: CALL_ID, ok: true, summary: "Edited src/a.ts" }),
    ]);

    mount(<ToolRow item={itemOfKind(timeline, "tool")} />, workbench);

    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.queryByText("Done")).toBeNull();
    expect(screen.getByText("Edited src/a.ts")).toBeTruthy();
  });
});

describe("TurnSummaryCard (UX_AND_INTERFACE.md section 6.5)", () => {
  it("shows the Unverified label and the files of a turn that changed some", () => {
    const { workbench } = makeWorkbench();
    const files = [fileChange({ path: "src/a.ts", change: "modified", added: 3, removed: 1 })];
    const timeline = fold([
      toolStarted({ seq: 2 }),
      toolCompleted({ seq: 3, ok: true, diff: files }),
      turnCompleted({ seq: 4, summary: summary({ files, verification: "unverified" }) }),
    ]);

    mount(<TurnSummaryCard turn={turnOf(timeline)} />, workbench);

    expect(screen.getByText("Unverified")).toBeTruthy();
    expect(screen.getByText("1 file changed")).toBeTruthy();
    expect(screen.getByText(/src\/a\.ts/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revert turn" })).toBeTruthy();
  });

  it("says No files changed and shows no label when nothing changed", () => {
    const { workbench } = makeWorkbench();
    const timeline = fold([turnCompleted({ seq: 2, summary: summary({ files: [] }) })]);

    mount(<TurnSummaryCard turn={turnOf(timeline)} />, workbench);

    expect(screen.getByText("No files changed")).toBeTruthy();
    expect(screen.queryByText("Unverified")).toBeNull();
    expect(screen.queryByText("Verified")).toBeNull();
    expect(screen.queryByRole("button", { name: "Revert turn" })).toBeNull();
  });

  it("reverts the turn, lists conflicts and restores them when forced", async () => {
    const { bridge, workbench } = makeWorkbench();
    const calls: Array<MethodParams<"checkpoints.revertTurn">> = [];
    bridge.handle("checkpoints.revertTurn", (params) => {
      calls.push(params);
      return (params.force?.length ?? 0) > 0
        ? { restored: ["src/a.ts", "src/b.ts"], conflicts: [] }
        : { restored: ["src/a.ts"], conflicts: ["src/b.ts"] };
    });

    const files = [fileChange({ path: "src/a.ts" })];
    const timeline = fold([
      toolStarted({ seq: 2 }),
      toolCompleted({ seq: 3, ok: true, diff: files }),
      turnCompleted({ seq: 4, summary: summary({ files, verification: "unverified" }) }),
    ]);

    mount(<TurnSummaryCard turn={turnOf(timeline)} />, workbench);

    await userEvent.click(screen.getByRole("button", { name: "Revert turn" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ turnId: TURN_ID, force: [] });

    const conflict = await screen.findByText("src/b.ts");
    expect(conflict).toBeTruthy();
    expect(
      screen.getByText("These files changed after the turn and were left as they are:"),
    ).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Restore them anyway" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ turnId: TURN_ID, force: ["src/b.ts"] });
  });

  it("shows the error and Retry for a failed turn", async () => {
    const { bridge, workbench } = makeWorkbench();
    const retries: Array<MethodParams<"agent.retryTurn">> = [];
    bridge.handle("agent.retryTurn", (params) => {
      retries.push(params);
      return { turnId: OTHER_TURN_ID };
    });

    const timeline = fold([
      turnFailed({
        seq: 2,
        error: { code: "provider.rate_limited", message: "OpenRouter is busy", retryable: true },
      }),
    ]);

    mount(<TurnSummaryCard turn={turnOf(timeline)} />, workbench);

    expect(screen.getByRole("alert").textContent).toContain("The turn failed: OpenRouter is busy");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(retries).toHaveLength(1));
    expect(retries[0]).toEqual({ turnId: TURN_ID });
  });

  it("shows the interrupted note and Retry when a turn has no summary", async () => {
    const { bridge, workbench } = makeWorkbench();
    const retries: Array<MethodParams<"agent.retryTurn">> = [];
    bridge.handle("agent.retryTurn", (params) => {
      retries.push(params);
      return { turnId: OTHER_TURN_ID };
    });

    const timeline = fold([turnInterrupted({ seq: 2 })]);
    mount(<TurnSummaryCard turn={turnOf(timeline)} />, workbench);

    expect(
      screen.getByText("Interrupted: Jesutobits stopped while the agent was working."),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(retries).toHaveLength(1));
    expect(retries[0]).toEqual({ turnId: TURN_ID });
  });
});
