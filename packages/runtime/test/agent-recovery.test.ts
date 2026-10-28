// Recovery and guardrails: reverting a turn's changes (ADR-0012), the turn's limits
// (AGENT_HARNESS.md 3.4, FR-033), the loop guard (3.6), retrying a failed turn, and a
// turn interrupted by a dead runtime (FR-041).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answerStep,
  awaitTurnEnd,
  dispose,
  errorOf,
  result,
  send,
  setupAgent,
  start,
  tempBase,
  toolStep,
  turnEvents,
  writeCassette,
} from "./agent-helpers.js";
import type { MethodResult } from "@jesutobits/protocol";
import type { RuntimeHarness } from "./harness/runtime-harness.js";

let base: string;
let project: string;
let harness: RuntimeHarness | undefined;

beforeEach(() => {
  base = tempBase("jesutobits-agent-recovery-");
  project = path.join(base, "my-app");
  mkdirSync(path.join(project, "src"), { recursive: true });
  // A pre-image with a byte-order mark and Windows line endings (restored byte for byte).
  writeFileSync(path.join(project, "src", "a.ts"), "\uFEFFexport const a = 1;\r\n");
  writeFileSync(path.join(project, "src", "b.ts"), "export const b = 1;\r\n");
  writeFileSync(path.join(project, "package.json"), '{ "name": "my-app" }\n');
});

afterEach(async () => {
  harness?.kill();
  await harness?.exited;
  harness = undefined;
  dispose(base);
});

/** Waits for a question's turn-specific fields. */
async function questionOf(
  h: RuntimeHarness,
  turnId: string,
): Promise<{ questionId: string; question: string; options: string[]; source: string }> {
  const asked = await h.waitForEvent(
    (event) => event.type === "question.asked" && event.turnId === turnId,
  );
  return asked as { questionId: string; question: string; options: string[]; source: string };
}

describe("checkpoints and revert (ADR-0012)", () => {
  it("restores the pre-image byte for byte, refusing changed files unless forced", async () => {
    harness = start(
      writeCassette(base, "change-both.jsonl", [
        toolStep("c1", "read_file", JSON.stringify({ path: "src/a.ts" }), "Reading a.", {
          lastUserTextIncludes: "change both files",
        }),
        toolStep(
          "c2",
          "edit_file",
          JSON.stringify({ path: "src/a.ts", edits: [{ oldText: "a = 1", newText: "a = 2" }] }),
        ),
        toolStep("c3", "read_file", JSON.stringify({ path: "src/b.ts" }), "Reading b."),
        toolStep(
          "c4",
          "edit_file",
          JSON.stringify({ path: "src/b.ts", edits: [{ oldText: "b = 1", newText: "b = 2" }] }),
        ),
        answerStep("Both changed."),
      ]),
    );
    const { sessionId } = await setupAgent(harness, project);
    const turnId = await send(harness, sessionId, "change both files");
    const end = await awaitTurnEnd(harness, turnId);
    expect(end.type).toBe("turn.completed");

    // The turn's writes are real, and a keeps its BOM and CRLF.
    expect(readFileSync(path.join(project, "src", "a.ts"), "utf8")).toBe(
      "\uFEFFexport const a = 2;\r\n",
    );

    const listed = result<"checkpoints.listForTurn">(
      await harness.call("checkpoints.listForTurn", { turnId }),
    );
    expect(listed.files).toMatchObject([
      { path: "src/a.ts", change: "modified", added: 1, removed: 1, unchangedSince: true },
      { path: "src/b.ts", change: "modified", added: 1, removed: 1, unchangedSince: true },
    ]);

    // Reverting one path: an untouched file restores, a changed one is left alone.
    const partial = result<"checkpoints.revertFile">(
      await harness.call("checkpoints.revertFile", { turnId, path: "src/b.ts" }),
    );
    expect(partial).toEqual({ restored: ["src/b.ts"], conflicts: [] });
    expect(readFileSync(path.join(project, "src", "b.ts"), "utf8")).toBe("export const b = 1;\r\n");
    expect(readFileSync(path.join(project, "src", "a.ts"), "utf8")).toBe(
      "\uFEFFexport const a = 2;\r\n",
    );

    // Someone else changed a since the turn: a plain revert refuses it.
    writeFileSync(path.join(project, "src", "a.ts"), "\uFEFFexport const a = 3;\r\n");
    const refused = result<"checkpoints.revertTurn">(
      await harness.call("checkpoints.revertTurn", { turnId }),
    );
    expect(refused).toEqual({ restored: [], conflicts: ["src/a.ts"] });

    // `force` accepts losing the outsider's change and restores the exact bytes.
    const forced = result<"checkpoints.revertTurn">(
      await harness.call("checkpoints.revertTurn", { turnId, force: ["src/a.ts"] }),
    );
    expect(forced).toEqual({ restored: ["src/a.ts"], conflicts: [] });
    const bytes = readFileSync(path.join(project, "src", "a.ts"));
    expect(bytes.toString("utf8")).toBe("\uFEFFexport const a = 1;\r\n");
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("latin1")).toContain("\r\n");

    // Reverting twice changes nothing: the pre-image is already the truth.
    const again = result<"checkpoints.revertTurn">(
      await harness.call("checkpoints.revertTurn", { turnId }),
    );
    expect(again).toEqual({ restored: [], conflicts: [] });
  });
});

describe("turn limits (AGENT_HARNESS.md 3.4, FR-033)", () => {
  /** Tells the runtime to allow only two steps per turn. */
  async function withTwoStepLimit(h: RuntimeHarness): Promise<void> {
    result<"runtime.configure">(
      await h.call("runtime.configure", {
        settings: { providers: {}, agent: { limits: { stepsPerTurn: 2 } }, privacy: {} },
        appDirs: [],
      } as never),
    );
  }

  it("asks at the configured step limit and stops the turn on Stop", async () => {
    harness = start(
      writeCassette(base, "limit-stop.jsonl", [
        toolStep("c1", "read_file", JSON.stringify({ path: "src/a.ts" }), "Looking."),
        toolStep("c2", "read_file", JSON.stringify({ path: "src/a.ts" }), "Looking again."),
      ]),
    );
    const { sessionId } = await setupAgent(harness, project);
    await withTwoStepLimit(harness);

    const turnId = await send(harness, sessionId, "read a.ts over and over");
    const asked = await questionOf(harness, turnId);
    expect(asked).toMatchObject({
      question: "The turn reached 2 steps. Continue for 20 more?",
      options: ["Continue", "Stop"],
      source: "limit",
    });
    result<"agent.answerQuestion">(
      await harness.call("agent.answerQuestion", { questionId: asked.questionId, answer: "Stop" }),
    );
    const end = await awaitTurnEnd(harness, turnId);
    expect(end.type).toBe("turn.cancelled");
    // Stop at a limit ends the turn with the limit's reason, not the user's cancel hand.
    const cancelled = await harness.waitForEvent(
      (event) =>
        event.type === "turn.state_changed" && event.turnId === turnId && event.to === "cancelled",
    );
    expect((cancelled as { reason?: string }).reason).toBe("limit");
  });

  it("raises the limit on Continue and finishes the later step", async () => {
    harness = start(
      writeCassette(base, "limit-continue.jsonl", [
        toolStep("c1", "read_file", JSON.stringify({ path: "src/a.ts" }), "Looking."),
        toolStep("c2", "read_file", JSON.stringify({ path: "src/a.ts" }), "Looking more."),
        answerStep("Done reading."),
      ]),
    );
    const { sessionId } = await setupAgent(harness, project);
    await withTwoStepLimit(harness);

    const turnId = await send(harness, sessionId, "read a.ts twice, then report");
    const asked = await questionOf(harness, turnId);
    result<"agent.answerQuestion">(
      await harness.call("agent.answerQuestion", {
        questionId: asked.questionId,
        answer: "Continue",
      }),
    );
    const end = await awaitTurnEnd(harness, turnId);
    expect(end.type).toBe("turn.completed");
    // The raise let the third step run: it is in the summary's count.
    expect((end as { summary?: { steps?: number } }).summary?.steps).toBe(3);
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: "question.answered",
        questionId: asked.questionId,
        answer: "Continue",
      }),
    );
  });
});

describe("loop guard (AGENT_HARNESS.md 3.6)", () => {
  it("asks after three identical reads and stops the turn on Stop", async () => {
    const read = toolStep("call", "read_file", JSON.stringify({ path: "src/a.ts" }), "Same thing.");
    harness = start(writeCassette(base, "loop.jsonl", [read, read, read]));
    const { sessionId } = await setupAgent(harness, project);

    const turnId = await send(harness, sessionId, "keep reading a.ts");
    const asked = await questionOf(harness, turnId);
    expect(asked).toMatchObject({
      question:
        "The agent called read_file 3 times with the same input and got the same result. Let it continue?",
      options: ["Continue", "Stop"],
      source: "loop",
    });
    result<"agent.answerQuestion">(
      await harness.call("agent.answerQuestion", { questionId: asked.questionId, answer: "Stop" }),
    );
    const end = await awaitTurnEnd(harness, turnId);
    expect(end.type).toBe("turn.cancelled");
    expect(
      turnEvents(harness, turnId).some(
        (event) => (event as { tool?: string }).tool === "read_file",
      ),
    ).toBe(true);
  });
});

describe("empty replies (AGENT_HARNESS.md 3.4, 3.6)", () => {
  /** A reasoning model that spent the whole output limit thinking: no text, no tool call. */
  const thoughtOnly = {
    events: [
      { type: "reasoning_delta", text: "Let me think about the architecture..." },
      { type: "usage", inputTokens: 100, outputTokens: 16_384 },
      { type: "finish", reason: "length" },
    ],
  };
  const cutOff = {
    events: [
      { type: "text_delta", text: "Here is the plan" },
      { type: "usage", inputTokens: 100, outputTokens: 16_384 },
      { type: "finish", reason: "length" },
    ],
  };

  it("never ends the turn on a reply spent on thinking, even after the one continuation", async () => {
    harness = start(
      writeCassette(base, "thought-only.jsonl", [
        cutOff,
        thoughtOnly,
        answerStep("Done.", { lastUserTextIncludes: "Stop planning and act now" }),
      ]),
    );
    const { sessionId } = await setupAgent(harness, project);

    const turnId = await send(harness, sessionId, "build it");
    const end = await awaitTurnEnd(harness, turnId);
    expect(end.type).toBe("turn.completed");
    expect(
      turnEvents(harness, turnId).some(
        (event) =>
          event.type === "model.step_completed" && (event as { text?: string }).text === "Done.",
      ),
    ).toBe(true);
  });

  it("asks after two empty replies in a row and stops the turn on Stop", async () => {
    harness = start(writeCassette(base, "empty.jsonl", [thoughtOnly, thoughtOnly]));
    const { sessionId } = await setupAgent(harness, project);

    const turnId = await send(harness, sessionId, "build it");
    const asked = await questionOf(harness, turnId);
    expect(asked).toMatchObject({
      question: "The model sent empty replies twice in a row. Try again?",
      source: "loop",
    });
    result<"agent.answerQuestion">(
      await harness.call("agent.answerQuestion", { questionId: asked.questionId, answer: "Stop" }),
    );
    expect((await awaitTurnEnd(harness, turnId)).type).toBe("turn.cancelled");
  });
});

describe("retrying a failed turn", () => {
  it("retries a 402 as a new turn marked retryOf, which succeeds", async () => {
    harness = start(
      writeCassette(base, "credits.jsonl", [
        {
          expect: { lastUserTextIncludes: "the credits ran out" },
          events: [
            {
              type: "http_error",
              status: 402,
              message: "You have insufficient credits for this request.",
            },
          ],
        },
        answerStep("Recovered and done."),
      ]),
    );
    const { sessionId } = await setupAgent(harness, project);

    const failedId = await send(harness, sessionId, "the credits ran out");
    const failed = await awaitTurnEnd(harness, failedId);
    expect(failed.type).toBe("turn.failed");
    expect((failed as { error?: { code?: string; userAction?: string } }).error).toMatchObject({
      code: "provider.insufficient_credits",
      userAction: "check_credits",
    });

    const retry = result<"agent.retryTurn">(
      await harness.call("agent.retryTurn", { turnId: failedId }),
    );
    const retriedId = retry.turnId;
    expect(retriedId).not.toBe(failedId);
    // The retry is its own turn, linked back to the one it retries.
    const started = await harness.waitForEvent(
      (event) => event.type === "turn.started" && event.turnId === retriedId,
    );
    expect((started as { retryOf?: string }).retryOf).toBe(failedId);
    const end = await awaitTurnEnd(harness, retriedId);
    expect(end.type).toBe("turn.completed");
  });
});

describe("an interrupted turn (FR-041)", () => {
  it("is marked interrupted at restart, its approval withdrawn, and a retry succeeds", async () => {
    const dataDir = path.join(base, "data");
    mkdirSync(dataDir);
    const requestCassette = writeCassette(base, "interrupted.jsonl", [
      toolStep(
        "c1",
        "edit_file",
        JSON.stringify({ path: "src/a.ts", edits: [{ oldText: "a = 1", newText: "a = 9" }] }),
      ),
    ]);
    const retryCassette = writeCassette(base, "after-restart.jsonl", [
      answerStep("Carrying on from the stored history."),
    ]);

    // The approval is left pending when the runtime dies.
    const first = start(requestCassette, dataDir);
    const { sessionId } = await setupAgent(first, project);
    result<"permissions.setPolicy">(
      await first.call("permissions.setPolicy", { preset: "cautious" }),
    );
    const turnId = await send(first, sessionId, "change a to 9");
    const asked = await first.waitForEvent(
      (event) => event.type === "permission.requested" && event.turnId === turnId,
    );
    const permissionId = (asked as { permissionId?: string }).permissionId ?? "";
    const beforeBytes = readFileSync(path.join(project, "src", "a.ts"), "utf8");
    expect(beforeBytes).toBe("\uFEFFexport const a = 1;\r\n");

    first.kill(); // As if the Host crashed: no graceful shutdown, no cancellation.
    await first.exited;

    const second = start(retryCassette, dataDir);
    harness = second;
    await second.initialize();
    // The restart opens the same project record from the database.
    const { project: reopened } = result<"projects.open">(
      await second.call("projects.open", { path: project }),
    );
    result<"projects.setTrust">(
      await second.call("projects.setTrust", { id: reopened.id, trust: "trusted" }),
    );
    // Recovery marks the dead turn interrupted and withdraws its pending approvals.
    const interrupted = await second.waitForEvent(
      (event) => event.type === "turn.interrupted" && event.turnId === turnId,
    );
    expect(interrupted.turnId).toBe(turnId);
    const history: MethodResult<"sessions.history"> = result<"sessions.history">(
      await second.call("sessions.history", { id: sessionId }),
    );
    expect(history.events.some((event) => event.type === "turn.interrupted")).toBe(true);

    // The withdrawn permission can never be answered afterwards (SECURITY.md 4.5).
    const refused = errorOf(
      await second.call("permissions.respond", {
        permissionId,
        decision: "allow_once",
        message: "late approval",
      }),
    );
    expect(refused.code).toBe("permission.not_pending");
    expect(readFileSync(path.join(project, "src", "a.ts"), "utf8")).toBe(beforeBytes);

    // The interrupted turn is retryable, and the retry runs from the stored history.
    const retry = result<"agent.retryTurn">(await second.call("agent.retryTurn", { turnId }));
    const retriedId = retry.turnId;
    const started = await second.waitForEvent(
      (event) => event.type === "turn.started" && event.turnId === retriedId,
    );
    expect((started as { retryOf?: string }).retryOf).toBe(turnId);
    const end = await awaitTurnEnd(second, retriedId);
    expect(end.type).toBe("turn.completed");
    expect(
      turnEvents(second, retriedId).some(
        (event) => (event as { text?: string }).text === "Carrying on from the stored history.",
      ),
    ).toBe(true);
  });
});
