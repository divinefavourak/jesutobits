// Interaction and control of a running turn (AGENT_HARNESS.md sections 3.5 and 5.9):
// ask_user FR-036, update_plan FR-035, cancels reach `cancelled` in 2 s (NFR-025), and
// pausing holds the turn at the next safe point (UX 6.1).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answerStep,
  awaitTurnEnd,
  dispose,
  indexOf,
  result,
  send,
  setupAgent,
  start,
  tempBase,
  toolStep,
  turnEvents,
  writeCassette,
} from "./agent-helpers.js";
import type { RuntimeHarness } from "./harness/runtime-harness.js";

let base: string;
let project: string;
let harness: RuntimeHarness | undefined;

beforeEach(() => {
  base = tempBase("jesutobits-agent-interact-");
  project = path.join(base, "my-app");
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "src", "a.ts"), "export const a = 1;\r\n");
  writeFileSync(path.join(project, "package.json"), '{ "name": "my-app" }\n');
});

afterEach(async () => {
  harness?.kill();
  await harness?.exited;
  harness = undefined;
  dispose(base);
});

describe("ask_user (FR-036)", () => {
  it("waits for the answer and gives it to the model as the tool's result", async () => {
    const cassette = writeCassette(base, "ask.jsonl", [
      toolStep(
        "c1",
        "ask_user",
        JSON.stringify({ question: "Which colour?", options: ["dark", "light"] }),
        "One choice please.",
      ),
      answerStep("Dark it is.", { lastToolResultIncludes: "The user answered: dark" }),
    ]);
    harness = start(cassette);
    const { sessionId } = await setupAgent(harness, project);

    const turnId = await send(harness, sessionId, "make the hero button dark or light");
    const asked = await harness.waitForEvent(
      (event) => event.type === "question.asked" && event.turnId === turnId,
    );
    // The turn state machine says `awaiting_user` while the card is open.
    expect(asked).toMatchObject({
      question: "Which colour?",
      options: ["dark", "light"],
      source: "agent",
    });
    await harness.waitForEvent(
      (event) =>
        event.type === "turn.state_changed" &&
        event.turnId === turnId &&
        event.to === "awaiting_user",
    );

    result<"agent.answerQuestion">(
      await harness.call("agent.answerQuestion", {
        questionId: asked.questionId as string,
        answer: "dark",
      }),
    );
    const end = await awaitTurnEnd(harness, turnId);
    expect(end.type).toBe("turn.completed");
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: "question.answered",
        questionId: asked.questionId as string,
        answer: "dark",
      }),
    );
  });
});

describe("update_plan (FR-035)", () => {
  it("emits the plan as the agent declared it", async () => {
    const items = [
      { id: "1", text: "Read the file", status: "done" },
      { id: "2", text: "Edit the file", status: "in_progress" },
      { id: "3", text: "Report", status: "pending" },
    ];
    const cassette = writeCassette(base, "plan.jsonl", [
      toolStep("c1", "update_plan", JSON.stringify({ items })),
      answerStep("Plan looks like this."),
    ]);
    harness = start(cassette);
    const { sessionId } = await setupAgent(harness, project);

    const turnId = await send(harness, sessionId, "summarise the work in a plan");
    const end = await awaitTurnEnd(harness, turnId);
    expect(end.type).toBe("turn.completed");
    expect(harness.events).toContainEqual(expect.objectContaining({ type: "plan.updated", items }));
  });
});

describe("cancellation (NFR-025)", () => {
  it("reaches cancelled within 2 s, every time (five turns)", async () => {
    // Five lines: each iteration makes exactly one request, which stalls until cancelled.
    const cassette = writeCassette(
      base,
      "stall.jsonl",
      Array.from({ length: 5 }, () => ({
        events: [
          { type: "text_delta", text: "Starting work." },
          { type: "stall", ms: 5000 },
        ],
      })),
    );
    harness = start(cassette);
    await harness.initialize();
    const { project: opened } = result<"projects.open">(
      await harness.call("projects.open", { path: project }),
    );
    result<"projects.setTrust">(
      await harness.call("projects.setTrust", { id: opened.id, trust: "trusted" }),
    );

    for (let index = 0; index < 5; index++) {
      const { session } = result<"sessions.create">(await harness.call("sessions.create", {}));
      const turnId = await send(harness, session.id, "start and stall");
      await harness.waitForEvent(
        (event) => event.type === "model.text_delta" && event.turnId === turnId,
      );

      const cancelAt = Date.now();
      result<"agent.cancelTurn">(await harness.call("agent.cancelTurn", { turnId }));
      const end = await awaitTurnEnd(harness, turnId, 2500);
      const elapsed = Date.now() - cancelAt;
      expect(elapsed).toBeLessThan(2000);
      expect(end.type).toBe("turn.cancelled");
      // The final state is cancelled, at the user's hand.
      const events = turnEvents(harness, turnId);
      expect(
        events.some((event) => event.type === "turn.state_changed" && event.to === "cancelled"),
      ).toBe(true);
    }
  });

  it("withdraws a pending approval when the turn is cancelled", async () => {
    const cassette = writeCassette(base, "approval-cancel.jsonl", [
      toolStep(
        "c1",
        "edit_file",
        JSON.stringify({ path: "src/a.ts", edits: [{ oldText: "a = 1", newText: "a = 2" }] }),
      ),
    ]);
    harness = start(cassette);
    const { sessionId } = await setupAgent(harness, project);
    result<"permissions.setPolicy">(
      await harness.call("permissions.setPolicy", { preset: "cautious" }),
    );

    const turnId = await send(harness, sessionId, "please change a to 2");
    const asked = await harness.waitForEvent(
      (event) => event.type === "permission.requested" && event.turnId === turnId,
    );
    result<"agent.cancelTurn">(await harness.call("agent.cancelTurn", { turnId }));

    const resolved = await harness.waitForEvent(
      (event) =>
        event.type === "permission.resolved" &&
        event.permissionId === (asked.permissionId as string),
    );
    expect(resolved.decision).toBe("withdrawn");
    const end = await awaitTurnEnd(harness, turnId, 2500);
    expect(end.type).toBe("turn.cancelled");
    expect(readFileSync(path.join(project, "src", "a.ts"), "utf8")).toBe("export const a = 1;\r\n");
  });
});

describe("pause and resume (UX_AND_INTERFACE.md 6.1)", () => {
  // The stall alone takes 3 s, and starting the runtime during a full parallel run can
  // take several more, hence the longer timeout.
  it("pauses after the current tool and continues on resume", async () => {
    // The stall keeps the first stream open so the pause lands while the tool is
    // still pending; the runtime then holds at the next safe point (after tools).
    const cassette = writeCassette(base, "pause.jsonl", [
      {
        ...toolStep("c1", "read_file", JSON.stringify({ path: "src/a.ts" }), "Reading it."),
        events: [
          { type: "text_delta", text: "Reading it." },
          { type: "stall", ms: 3000 },
          { type: "tool_call_start", callId: "c1", name: "read_file" },
          {
            type: "tool_call_args_delta",
            callId: "c1",
            delta: JSON.stringify({ path: "src/a.ts" }),
          },
          { type: "tool_call_end", callId: "c1" },
          { type: "usage", inputTokens: 100, outputTokens: 20, costUsd: 0.001 },
          { type: "finish", reason: "tool_calls" },
        ],
      },
      answerStep("Back to work."),
    ]);
    harness = start(cassette);
    const { sessionId } = await setupAgent(harness, project);

    const turnId = await send(harness, sessionId, "please look at a and report");
    // Pause while the model is still streaming step 1, well before the tool runs.
    await harness.waitForEvent(
      (event) => event.type === "model.text_delta" && event.turnId === turnId,
    );
    result<"agent.pauseTurn">(await harness.call("agent.pauseTurn", { turnId }));
    await harness.waitForEvent(
      (event) =>
        event.type === "tool.started" && event.turnId === turnId && event.tool === "read_file",
    );
    await harness.waitForEvent(
      (event) =>
        event.type === "turn.state_changed" && event.turnId === turnId && event.to === "paused",
    );

    // Held: exactly the first model request has started, none while paused.
    const events = turnEvents(harness, turnId);
    const pausedAt = indexOf(
      events,
      (event) => event.type === "turn.state_changed" && event.to === "paused",
    );
    expect(
      indexOf(events, (event) => event.type === "model.request_started"),
    ).toBeGreaterThanOrEqual(0);
    expect(indexOf(events, (event) => event.type === "model.request_started", pausedAt + 1)).toBe(
      -1,
    );

    result<"agent.resumeTurn">(await harness.call("agent.resumeTurn", { turnId }));

    const resumed = await awaitTurnEnd(harness, turnId);
    expect(resumed.type).toBe("turn.completed");
    // The turn carried on: a fresh model request after the paused point, fed by
    // the tool result the run collected before it was held.
    const after = turnEvents(harness, turnId);
    const resumedRequest = indexOf(
      after,
      (event) => event.type === "model.request_started",
      pausedAt + 1,
    );
    expect(resumedRequest).toBeGreaterThan(pausedAt);
    expect(after.slice(resumedRequest + 1)).toContainEqual(
      expect.objectContaining({ type: "model.text_delta" }),
    );
  }, 20_000);
});
