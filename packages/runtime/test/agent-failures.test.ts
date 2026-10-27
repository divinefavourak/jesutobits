// Provider failures (AGENT_HARNESS.md 2.5, FR-025): a hard failure ends the turn with a
// plain message and an action; a retryable one retries inside the step and never re-runs
// a tool; content shown by a voided attempt does not survive the retry.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answerStep,
  awaitTurnEnd,
  dispose,
  send,
  setupAgent,
  start,
  tempBase,
  turnEvents,
  writeCassette,
} from "./agent-helpers.js";
import type { RuntimeHarness } from "./harness/runtime-harness.js";

let base: string;
let project: string;
let harness: RuntimeHarness | undefined;

beforeEach(() => {
  base = tempBase("jesutobits-agent-failures-");
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

/** An error event as a provider stream would deliver it after `amount` of content. */
function midStreamError(category: string, message: string): Record<string, unknown> {
  return {
    type: "error",
    error: { category, message, retryable: category === "provider_unavailable" },
    afterContent: true,
  };
}

describe("a hard provider failure", () => {
  it("ends the turn once, telling the user to check their credits (402)", async () => {
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
      ]),
    );
    const { sessionId } = await setupAgent(harness, project);
    const turnId = await send(harness, sessionId, "the credits ran out");

    const end = await awaitTurnEnd(harness, turnId);
    expect(end.type).toBe("turn.failed");
    expect((end as { error?: Record<string, unknown> }).error).toMatchObject({
      code: "provider.insufficient_credits",
      message: "Check your OpenRouter credits: the account has run out.",
      userAction: "check_credits",
      details: {
        category: "insufficient_credits",
        providerMessage: "You have insufficient credits for this request.",
        httpStatus: 402,
      },
    });
    // Not retryable: the runtime asked the provider exactly once.
    expect(
      turnEvents(harness, turnId).filter((event) => event.type === "model.request_started"),
    ).toHaveLength(1);
    expect(end).toMatchObject({ type: "turn.failed", error: { retryable: false } });
  });
});

describe("a rate-limited request", () => {
  it("counts down to the retry and finishes on the second attempt (429)", async () => {
    harness = start(
      writeCassette(base, "rate-limit.jsonl", [
        {
          events: [
            {
              type: "http_error",
              status: 429,
              message: "The rate limit is exceeded.",
              retryAfterMs: 50,
            },
          ],
        },
        answerStep("Went through after the wait.", {
          lastUserTextIncludes: "the rate limit is exceeded",
        }),
      ]),
    );
    const { sessionId } = await setupAgent(harness, project);
    const turnId = await send(harness, sessionId, "the rate limit is exceeded");

    const end = await awaitTurnEnd(harness, turnId);
    expect(end.type).toBe("turn.completed");
    const events = turnEvents(harness, turnId);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "model.error",
        attempt: 1,
        retryInMs: 50,
        error: expect.objectContaining({ category: "rate_limited", httpStatus: 429 }),
      }),
    );
    // Two attempts, both announced for the same step.
    expect(events.filter((event) => event.type === "model.request_started")).toMatchObject([
      { attempt: 1 },
      { attempt: 2 },
    ]);
    // The Workbench is told, in the user's words, that re-trying is under way.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "runtime.warning",
        code: "provider.rate_limited",
        message: "OpenRouter is limiting requests. Trying again in 1 s.",
      }),
    );
  });
});

describe("a stream that dies after content", () => {
  it("discards the voided attempt and finishes with only the retry's text", async () => {
    harness = start(
      writeCassette(base, "mid-stream.jsonl", [
        {
          events: [
            { type: "text_delta", text: "Half an answer cut off. " },
            midStreamError("provider_unavailable", "The model stopped mid-answer."),
          ],
        },
        answerStep("The whole answer, from the second attempt."),
      ]),
    );
    const { sessionId } = await setupAgent(harness, project);
    const turnId = await send(harness, sessionId, "please tell the whole answer");

    const end = await awaitTurnEnd(harness, turnId);
    expect(end.type).toBe("turn.completed");
    expect(
      turnEvents(harness, turnId).filter((event) => event.type === "model.request_started"),
    ).toHaveLength(2);
    // The step's result is the retry's text alone: the voided attempt streamed to the
    // user in the moment, but never became the step.
    const completedSteps = turnEvents(harness, turnId).filter(
      (event) => event.type === "model.step_completed",
    );
    expect(completedSteps).toHaveLength(1);
    expect(completedSteps[0]).toMatchObject({
      type: "model.step_completed",
      text: "The whole answer, from the second attempt.",
    });
    expect(turnEvents(harness, turnId).some((event) => event.type === "model.text_delta")).toBe(
      true,
    );
  });

  it("fails the turn after a second cut-off attempt, ready for a manual retry", async () => {
    harness = start(
      writeCassette(base, "double-cut.jsonl", [
        {
          events: [
            { type: "text_delta", text: "First cut off. " },
            midStreamError("provider_unavailable", "The model stopped mid-answer."),
          ],
        },
        {
          events: [
            { type: "text_delta", text: "Second cut off. " },
            midStreamError("provider_unavailable", "The model stopped mid-answer."),
          ],
        },
      ]),
    );
    const { sessionId } = await setupAgent(harness, project);
    const turnId = await send(harness, sessionId, "please persist");

    const end = await awaitTurnEnd(harness, turnId);
    expect(end.type).toBe("turn.failed");
    expect((end as { error?: Record<string, unknown> }).error).toMatchObject({
      code: "provider.unavailable",
      userAction: "retry",
      retryable: true,
      details: { category: "provider_unavailable" },
    });
    // Another retryable failure ends the turn after two attempts; no third try.
    expect(
      turnEvents(harness, turnId).filter((event) => event.type === "model.request_started"),
    ).toHaveLength(2);
  });
});
