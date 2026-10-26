import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../clock.js";
import {
  ProviderCallError,
  ProviderCaller,
  type CallerTimeouts,
  type StepHooks,
  type StepResult,
} from "./provider-caller.js";
import { parseCassette } from "./scripted/cassette.js";
import { ScriptedProvider } from "./scripted/scripted-provider.js";
import type { ModelProvider, ModelRequest, ModelStreamEvent } from "./types.js";

const cassette = (...lines: object[]) =>
  parseCassette(lines.map((line, step) => JSON.stringify({ step, ...line })).join("\n"));

function makeRequest(text = "hello", extra: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "scripted/model",
    system: "You are the coding agent.",
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }],
    maxOutputTokens: 1000,
    ...extra,
  };
}

function setup(lines: object[], timeouts?: Partial<CallerTimeouts>) {
  const clock = new FakeClock(0);
  const provider = new ScriptedProvider(cassette(...lines), { clock });
  const invalidateCredential = vi.fn();
  const caller = new ProviderCaller({
    provider,
    clock,
    random: () => 0.5,
    invalidateCredential,
    ...(timeouts !== undefined && { timeouts }),
  });
  return { clock, provider, caller, invalidateCredential };
}

interface Tracker<T> {
  settled: boolean;
  value?: T;
  error?: unknown;
  done: Promise<void>;
}

/** Wraps a step promise so a test can move the clock while checking whether it settled. */
function track<T>(promise: Promise<T>): Tracker<T> {
  const tracker: Tracker<T> = { settled: false, done: Promise.resolve() };
  tracker.done = promise.then(
    (value) => {
      tracker.value = value;
      tracker.settled = true;
    },
    (error: unknown) => {
      tracker.error = error;
      tracker.settled = true;
    },
  );
  return tracker;
}

function failureOf(tracker: Tracker<StepResult>): ProviderCallError {
  expect(tracker.error).toBeInstanceOf(ProviderCallError);
  return tracker.error as ProviderCallError;
}

async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await tick();
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Repeatedly moves time until the step settles, so no test waits on a real timer. */
async function advanceUntilSettled<T>(
  clock: FakeClock,
  tracker: Tracker<T>,
  stepMs = 1000,
  maxSteps = 200,
): Promise<void> {
  for (let step = 0; step < maxSteps && !tracker.settled; step++) {
    await clock.advance(stepMs);
  }
  await tick();
  expect(tracker.settled).toBe(true);
}

interface RecordedHooks {
  hooks: StepHooks;
  attempts: number[];
  events: string[];
  errors: Array<{ category: string; attempt: number; retryInMs: number | undefined }>;
}

function recordHooks(): RecordedHooks {
  const attempts: number[] = [];
  const events: string[] = [];
  const errors: RecordedHooks["errors"] = [];
  return {
    attempts,
    events,
    errors,
    hooks: {
      onAttempt: (attempt) => attempts.push(attempt),
      onEvent: (event) => events.push(event.type),
      onError: (error, attempt, retryInMs) =>
        errors.push({ category: error.category, attempt, retryInMs }),
    },
  };
}

const successLine = (text: string, reason: "stop" | "tool_calls" = "stop") => ({
  events: [
    { type: "text_delta", text },
    { type: "finish", reason },
  ],
});

const httpError = (status: number, extra: object = {}) => ({
  events: [{ type: "http_error", status, ...extra }],
});

describe("ProviderCaller", () => {
  it("returns the complete step: joined text, tool calls in start order, usage and finish", async () => {
    const { clock, provider, caller } = setup([
      {
        events: [
          { type: "text_delta", text: "Hello" },
          { type: "text_delta", text: " world" },
          { type: "tool_call_start", callId: "call_1", name: "read_file" },
          { type: "tool_call_args_delta", callId: "call_1", delta: '{"path":' },
          { type: "tool_call_args_delta", callId: "call_1", delta: '"a.ts"}' },
          { type: "tool_call_end", callId: "call_1" },
          { type: "tool_call_start", callId: "call_2", name: "write_file" },
          { type: "tool_call_args_delta", callId: "call_2", delta: '{"path":"b.ts"}' },
          { type: "tool_call_end", callId: "call_2" },
          {
            type: "usage",
            inputTokens: 100,
            outputTokens: 25,
            cachedInputTokens: 40,
            costUsd: 0.001,
          },
          { type: "finish", reason: "tool_calls" },
        ],
      },
    ]);
    const recorder = recordHooks();
    const tracker = track(
      caller.runStep(makeRequest(), new AbortController().signal, recorder.hooks),
    );
    await advanceUntilSettled(clock, tracker);

    expect(tracker.value).toEqual({
      text: "Hello world",
      reasoning: "",
      toolCalls: [
        { id: "call_1", name: "read_file", argumentsJson: '{"path":"a.ts"}' },
        { id: "call_2", name: "write_file", argumentsJson: '{"path":"b.ts"}' },
      ],
      finishReason: "tool_calls",
      usage: { inputTokens: 100, outputTokens: 25, cachedInputTokens: 40, costUsd: 0.001 },
      attempts: 1,
    });
    expect(recorder.attempts).toEqual([1]);
    // Argument deltas are folded into the tool call; the hook sees the call boundaries.
    expect(recorder.events).toEqual([
      "text_delta",
      "text_delta",
      "tool_call_start",
      "tool_call_end",
      "tool_call_start",
      "tool_call_end",
    ]);
    expect(recorder.errors).toEqual([]);
    expect(provider.requests).toHaveLength(1);
    expect(provider.remaining).toBe(0);
  });

  it("waits exactly the Retry-After of a 429 before the retry", async () => {
    const { clock, provider, caller } = setup([
      httpError(429, { retryAfterMs: 2000 }),
      successLine("ok", "stop"),
    ]);
    const recorder = recordHooks();
    const tracker = track(
      caller.runStep(makeRequest(), new AbortController().signal, recorder.hooks),
    );

    await until(() => recorder.errors.length === 1, "the 429 to be reported");
    expect(clock.pending).toBe(1);
    await clock.advance(1999);
    expect(tracker.settled).toBe(false);
    expect(provider.requests).toHaveLength(1);

    await clock.advance(1);
    await tick();
    expect(tracker.settled).toBe(true);

    expect(tracker.value).toMatchObject({ text: "ok", finishReason: "stop", attempts: 2 });
    expect(recorder.attempts).toEqual([1, 2]);
    expect(recorder.errors).toEqual([{ category: "rate_limited", attempt: 1, retryInMs: 2000 }]);
    expect(recorder.events).toEqual(["text_delta"]);
    expect(provider.requests).toHaveLength(2);
    expect(clock.now()).toBe(2000);
  });

  it("backs off 2 s, 4 s and 8 s for four 429s without Retry-After, then fails", async () => {
    const limiting = httpError(429);
    const { clock, provider, caller } = setup([limiting, limiting, limiting, limiting]);
    const recorder = recordHooks();
    const tracker = track(
      caller.runStep(makeRequest(), new AbortController().signal, recorder.hooks),
    );

    await until(() => recorder.errors.length === 1, "the first 429");
    await clock.advance(1999);
    expect(tracker.settled).toBe(false);
    expect(provider.requests).toHaveLength(1);
    await clock.advance(1);
    await advanceUntilSettled(clock, tracker);

    expect(clock.now()).toBe(14_000);
    expect(recorder.attempts).toEqual([1, 2, 3, 4]);
    expect(recorder.errors).toEqual([
      { category: "rate_limited", attempt: 1, retryInMs: 2000 },
      { category: "rate_limited", attempt: 2, retryInMs: 4000 },
      { category: "rate_limited", attempt: 3, retryInMs: 8000 },
      { category: "rate_limited", attempt: 4, retryInMs: undefined },
    ]);
    expect(provider.requests).toHaveLength(4);
    expect(failureOf(tracker).error.category).toBe("rate_limited");
  });

  it("backs off 1 s then 2 s for 503 and 502, then succeeds", async () => {
    const { clock, provider, caller } = setup([
      httpError(503),
      httpError(502),
      successLine("recovered", "stop"),
    ]);
    const recorder = recordHooks();
    const tracker = track(
      caller.runStep(makeRequest(), new AbortController().signal, recorder.hooks),
    );

    await until(() => recorder.errors.length === 1, "the 503");
    await clock.advance(999);
    expect(tracker.settled).toBe(false);
    await clock.advance(1);
    await advanceUntilSettled(clock, tracker);

    expect(clock.now()).toBe(3000);
    expect(recorder.attempts).toEqual([1, 2, 3]);
    expect(recorder.errors).toEqual([
      { category: "provider_unavailable", attempt: 1, retryInMs: 1000 },
      { category: "provider_unavailable", attempt: 2, retryInMs: 2000 },
    ]);
    expect(recorder.events).toEqual(["text_delta"]);
    expect(tracker.value).toMatchObject({ text: "recovered", attempts: 3 });
    expect(provider.requests).toHaveLength(3);
  });

  it("fails after four unavailability errors", async () => {
    const down = httpError(503);
    const { clock, provider, caller } = setup([down, down, down, down]);
    const recorder = recordHooks();
    const tracker = track(
      caller.runStep(makeRequest(), new AbortController().signal, recorder.hooks),
    );
    await advanceUntilSettled(clock, tracker);

    expect(clock.now()).toBe(7000);
    expect(recorder.attempts).toEqual([1, 2, 3, 4]);
    expect(recorder.errors).toEqual([
      { category: "provider_unavailable", attempt: 1, retryInMs: 1000 },
      { category: "provider_unavailable", attempt: 2, retryInMs: 2000 },
      { category: "provider_unavailable", attempt: 3, retryInMs: 4000 },
      { category: "provider_unavailable", attempt: 4, retryInMs: undefined },
    ]);
    expect(provider.requests).toHaveLength(4);
    expect(failureOf(tracker).error.category).toBe("provider_unavailable");
  });

  it("fails at once on 402 without waiting or retrying", async () => {
    const { clock, provider, caller } = setup([httpError(402, { message: "No credits left" })]);
    const recorder = recordHooks();
    const tracker = track(
      caller.runStep(makeRequest(), new AbortController().signal, recorder.hooks),
    );
    await tracker.done;

    expect(tracker.settled).toBe(true);
    expect(clock.now()).toBe(0);
    expect(clock.pending).toBe(0);
    expect(recorder.attempts).toEqual([1]);
    expect(recorder.errors).toEqual([
      { category: "insufficient_credits", attempt: 1, retryInMs: undefined },
    ]);
    expect(provider.requests).toHaveLength(1);
    const failure = failureOf(tracker);
    expect(failure.error.category).toBe("insufficient_credits");
    expect(failure.error.httpStatus).toBe(402);
  });

  it("refetches the credential once after a 401, then succeeds", async () => {
    const { clock, provider, caller, invalidateCredential } = setup([
      httpError(401),
      successLine("after refresh", "stop"),
    ]);
    const recorder = recordHooks();
    const tracker = track(
      caller.runStep(makeRequest(), new AbortController().signal, recorder.hooks),
    );
    await advanceUntilSettled(clock, tracker, 0);

    expect(tracker.value).toMatchObject({ text: "after refresh", attempts: 2 });
    expect(recorder.attempts).toEqual([1, 2]);
    expect(recorder.errors).toEqual([{ category: "auth", attempt: 1, retryInMs: 0 }]);
    expect(provider.requests).toHaveLength(2);
    expect(invalidateCredential).toHaveBeenCalledTimes(1);
    expect(clock.now()).toBe(0);
  });

  it("fails after a second 401 with one credential refresh", async () => {
    const unauthorized = httpError(401);
    const { clock, provider, caller, invalidateCredential } = setup([unauthorized, unauthorized]);
    const recorder = recordHooks();
    const tracker = track(
      caller.runStep(makeRequest(), new AbortController().signal, recorder.hooks),
    );
    await advanceUntilSettled(clock, tracker, 0);

    expect(recorder.attempts).toEqual([1, 2]);
    expect(recorder.errors).toEqual([
      { category: "auth", attempt: 1, retryInMs: 0 },
      { category: "auth", attempt: 2, retryInMs: undefined },
    ]);
    expect(provider.requests).toHaveLength(2);
    expect(invalidateCredential).toHaveBeenCalledTimes(1);
    expect(failureOf(tracker).error.category).toBe("auth");
  });

  it("discards a mid-stream failure and retries the step once", async () => {
    const midStreamFailure = {
      events: [
        { type: "text_delta", text: "partial" },
        {
          type: "error",
          error: {
            category: "provider_unavailable",
            message: "connection reset",
            retryable: true,
          },
          afterContent: true,
        },
      ],
    };
    const { clock, provider, caller } = setup([midStreamFailure, successLine("complete", "stop")]);
    const recorder = recordHooks();
    const tracker = track(
      caller.runStep(makeRequest(), new AbortController().signal, recorder.hooks),
    );
    await advanceUntilSettled(clock, tracker, 0);

    expect(tracker.value).toEqual({
      text: "complete",
      reasoning: "",
      toolCalls: [],
      finishReason: "stop",
      usage: undefined,
      attempts: 2,
    });
    expect(recorder.attempts).toEqual([1, 2]);
    expect(recorder.errors).toEqual([
      { category: "provider_unavailable", attempt: 1, retryInMs: 0 },
    ]);
    expect(recorder.events).toEqual(["text_delta", "text_delta"]);
    expect(provider.requests).toHaveLength(2);
  });

  it("fails after a second mid-stream failure", async () => {
    const midStreamFailure = {
      events: [
        { type: "text_delta", text: "partial" },
        {
          type: "error",
          error: { category: "network", message: "reset", retryable: true },
          afterContent: true,
        },
      ],
    };
    const { clock, provider, caller } = setup([midStreamFailure, midStreamFailure]);
    const recorder = recordHooks();
    const tracker = track(
      caller.runStep(makeRequest(), new AbortController().signal, recorder.hooks),
    );
    await advanceUntilSettled(clock, tracker, 0);

    expect(recorder.attempts).toEqual([1, 2]);
    expect(recorder.errors).toEqual([
      { category: "network", attempt: 1, retryInMs: 0 },
      { category: "network", attempt: 2, retryInMs: undefined },
    ]);
    expect(provider.requests).toHaveLength(2);
    expect(failureOf(tracker).error.category).toBe("network");
  });

  it("times out at 60 s before the first byte, then retries", async () => {
    const { clock, provider, caller } = setup([
      {
        events: [
          { type: "stall", ms: 95_000 },
          { type: "text_delta", text: "too late" },
          { type: "finish", reason: "stop" },
        ],
      },
      successLine("second", "stop"),
    ]);
    const recorder = recordHooks();
    const tracker = track(
      caller.runStep(makeRequest(), new AbortController().signal, recorder.hooks),
    );
    await until(() => clock.pending >= 2, "the first request to stall");

    await clock.advance(60_000);
    await tick();

    expect(tracker.settled).toBe(true);
    expect(tracker.value).toEqual({
      text: "second",
      reasoning: "",
      toolCalls: [],
      finishReason: "stop",
      usage: undefined,
      attempts: 2,
    });
    expect(recorder.errors).toEqual([{ category: "timeout", attempt: 1, retryInMs: 0 }]);
    expect(provider.requests).toHaveLength(2);
    expect(clock.now()).toBe(60_000);
  });

  it("gives reasoning models 120 s before the first byte", async () => {
    // The stall must outlast the 120 s budget, unlike the 60 s case above.
    const { clock, provider, caller } = setup([
      {
        events: [
          { type: "stall", ms: 150_000 },
          { type: "text_delta", text: "too late" },
          { type: "finish", reason: "stop" },
        ],
      },
      successLine("second", "stop"),
    ]);
    const recorder = recordHooks();
    const tracker = track(
      caller.runStep(makeRequest(), new AbortController().signal, recorder.hooks, {
        reasoning: true,
      }),
    );
    await until(() => clock.pending >= 2, "the first request to stall");

    await clock.advance(60_000);
    await tick();
    expect(tracker.settled).toBe(false);
    expect(provider.requests).toHaveLength(1);
    expect(recorder.errors).toEqual([]);

    await clock.advance(60_000);
    await tick();
    expect(tracker.settled).toBe(true);
    expect(tracker.value).toMatchObject({ text: "second", attempts: 2 });
    expect(recorder.errors).toEqual([{ category: "timeout", attempt: 1, retryInMs: 0 }]);
    expect(provider.requests).toHaveLength(2);
    expect(clock.now()).toBe(120_000);
  });

  it("times out after 90 s without bytes and retries the step", async () => {
    const { clock, provider, caller } = setup([
      {
        events: [
          { type: "text_delta", text: "start" },
          { type: "stall", ms: 95_000 },
          { type: "finish", reason: "stop" },
        ],
      },
      successLine("after idle", "stop"),
    ]);
    const recorder = recordHooks();
    const tracker = track(
      caller.runStep(makeRequest(), new AbortController().signal, recorder.hooks),
    );
    await until(() => recorder.events.length === 1 && clock.pending >= 2, "the stream to go idle");

    await clock.advance(89_999);
    expect(tracker.settled).toBe(false);
    expect(provider.requests).toHaveLength(1);

    await clock.advance(1);
    await tick();
    expect(tracker.settled).toBe(true);

    expect(tracker.value).toMatchObject({ text: "after idle", attempts: 2 });
    expect(recorder.attempts).toEqual([1, 2]);
    expect(recorder.errors).toEqual([{ category: "timeout", attempt: 1, retryInMs: 0 }]);
    expect(provider.requests).toHaveLength(2);
    expect(clock.now()).toBe(90_000);
  });

  it("resets the idle timer on a keepalive", async () => {
    const { clock, provider, caller } = setup([
      {
        events: [
          { type: "text_delta", text: "a" },
          { type: "stall", ms: 60_000 },
          { type: "keepalive" },
          { type: "stall", ms: 60_000 },
          { type: "text_delta", text: "b" },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);
    const recorder = recordHooks();
    const tracker = track(
      caller.runStep(makeRequest(), new AbortController().signal, recorder.hooks),
    );
    await advanceUntilSettled(clock, tracker, 5000);

    expect(tracker.value).toMatchObject({
      text: "ab",
      finishReason: "stop",
      attempts: 1,
    });
    expect(recorder.attempts).toEqual([1]);
    expect(recorder.errors).toEqual([]);
    expect(provider.requests).toHaveLength(1);
    expect(clock.now()).toBe(120_000);
  });

  it("fails after two timeouts in a row", async () => {
    const stalling = {
      events: [{ type: "stall", ms: 95_000 }],
    };
    const { clock, provider, caller } = setup([stalling, stalling]);
    const recorder = recordHooks();
    const tracker = track(
      caller.runStep(makeRequest(), new AbortController().signal, recorder.hooks),
    );
    await until(() => clock.pending >= 2, "the first request to stall");

    await clock.advance(60_000);
    await tick();
    expect(provider.requests).toHaveLength(2);

    await clock.advance(60_000);
    await tick();

    expect(tracker.settled).toBe(true);
    expect(recorder.attempts).toEqual([1, 2]);
    expect(recorder.errors).toEqual([
      { category: "timeout", attempt: 1, retryInMs: 0 },
      { category: "timeout", attempt: 2, retryInMs: undefined },
    ]);
    expect(provider.requests).toHaveLength(2);
    expect(failureOf(tracker).error.category).toBe("timeout");
    expect(clock.now()).toBe(120_000);
  });

  it("fails a request that outlives the total budget without retrying", async () => {
    const events: object[] = [];
    for (let i = 0; i < 10; i++) {
      events.push({ type: "stall", ms: 1000 }, { type: "keepalive" });
    }
    events.push({ type: "finish", reason: "stop" });
    const { clock, provider, caller } = setup([{ events }], {
      total: 5000,
      idle: 4000,
      firstByte: 4000,
    });
    const recorder = recordHooks();
    const tracker = track(
      caller.runStep(makeRequest(), new AbortController().signal, recorder.hooks),
    );
    await until(() => clock.pending >= 2, "the keepalive stream to start");

    await clock.advance(4999);
    expect(tracker.settled).toBe(false);

    await clock.advance(1);
    await tick();

    expect(tracker.settled).toBe(true);
    expect(clock.now()).toBe(5000);
    expect(recorder.attempts).toEqual([1]);
    expect(recorder.errors).toEqual([{ category: "timeout", attempt: 1, retryInMs: undefined }]);
    expect(provider.requests).toHaveLength(1);
    expect(failureOf(tracker).error.category).toBe("timeout");
  });

  it("rejects with the abort reason during a stall and makes no further request", async () => {
    const { clock, provider, caller } = setup([
      {
        events: [
          { type: "stall", ms: 30_000 },
          { type: "text_delta", text: "late" },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);
    const controller = new AbortController();
    const reason = new Error("user cancelled");
    const tracker = track(caller.runStep(makeRequest(), controller.signal));
    await until(() => clock.pending >= 2, "the stream to stall");

    const started = performance.now();
    controller.abort(reason);
    await tracker.done;
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(50);
    expect(tracker.error).toBe(reason);
    expect(provider.requests).toHaveLength(1);
    expect(clock.pending).toBe(0);
  });

  it("rejects before sending anything when the signal is already aborted", async () => {
    const { clock, provider, caller } = setup([successLine("unused", "stop")]);
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);

    const tracker = track(caller.runStep(makeRequest(), controller.signal));
    await tracker.done;

    expect(tracker.error).toBe(reason);
    expect(provider.requests).toHaveLength(0);
    expect(clock.now()).toBe(0);
  });

  it("rejects promptly when the provider ignores its abort signal", async () => {
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      id: "hanging",
      listModels: async () => [],
      testConnection: async () => ({ ok: true }),
      stream: (request) => {
        requests.push(request);
        const iterator: AsyncIterator<ModelStreamEvent> = {
          next: () => new Promise<IteratorResult<ModelStreamEvent>>(() => undefined),
        };
        return { [Symbol.asyncIterator]: () => iterator };
      },
    };
    const clock = new FakeClock(0);
    const caller = new ProviderCaller({ provider, clock });
    const controller = new AbortController();
    const reason = new Error("stop");
    const tracker = track(caller.runStep(makeRequest(), controller.signal));
    await until(() => requests.length === 1, "the hanging request to start");

    const started = performance.now();
    controller.abort(reason);
    await tracker.done;
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(50);
    expect(tracker.error).toBe(reason);
    expect(requests).toHaveLength(1);
  });

  it("uses the compacted request after a context_length error", async () => {
    const long = makeRequest("hello", {
      messages: [
        { role: "user", content: [{ type: "text", text: "one" }] },
        { role: "assistant", content: [{ type: "text", text: "two" }] },
        { role: "user", content: [{ type: "text", text: "three" }] },
        { role: "assistant", content: [{ type: "text", text: "four" }] },
      ],
    });
    const smaller = makeRequest("hello", { messages: long.messages.slice(0, 2) });
    const tooLong = httpError(400, { message: "maximum context length exceeded" });
    const { clock, provider, caller } = setup([tooLong, successLine("fits", "stop")]);
    const recorder = recordHooks();
    const onContextLength = vi.fn(async () => smaller);
    const tracker = track(
      caller.runStep(long, new AbortController().signal, {
        ...recorder.hooks,
        onContextLength,
      }),
    );
    await advanceUntilSettled(clock, tracker, 0);

    expect(onContextLength).toHaveBeenCalledTimes(1);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages).toHaveLength(2);
    expect(tracker.value).toMatchObject({ text: "fits", attempts: 2 });
    expect(recorder.attempts).toEqual([1, 2]);
    expect(recorder.errors).toEqual([{ category: "context_length", attempt: 1, retryInMs: 0 }]);
  });

  it("rejects a context_length error when no compaction hook is given", async () => {
    const tooLong = httpError(400, { message: "maximum context length exceeded" });
    const { provider, caller } = setup([tooLong]);
    const recorder = recordHooks();
    const tracker = track(
      caller.runStep(makeRequest(), new AbortController().signal, recorder.hooks),
    );
    await tracker.done;

    expect(provider.requests).toHaveLength(1);
    expect(recorder.attempts).toEqual([1]);
    expect(recorder.errors).toEqual([
      { category: "context_length", attempt: 1, retryInMs: undefined },
    ]);
    expect(failureOf(tracker).error.category).toBe("context_length");
  });

  it("rejects a second context_length error instead of compacting again", async () => {
    const tooLong = httpError(400, { message: "maximum context length exceeded" });
    const { clock, provider, caller } = setup([tooLong, tooLong, successLine("unused", "stop")]);
    const recorder = recordHooks();
    const onContextLength = vi.fn(async () =>
      makeRequest("hello", {
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    );
    const tracker = track(
      caller.runStep(makeRequest(), new AbortController().signal, {
        ...recorder.hooks,
        onContextLength,
      }),
    );
    await advanceUntilSettled(clock, tracker, 0);

    expect(onContextLength).toHaveBeenCalledTimes(1);
    expect(provider.requests).toHaveLength(2);
    expect(recorder.attempts).toEqual([1, 2]);
    expect(recorder.errors).toEqual([
      { category: "context_length", attempt: 1, retryInMs: 0 },
      { category: "context_length", attempt: 2, retryInMs: undefined },
    ]);
    expect(failureOf(tracker).error.category).toBe("context_length");
  });

  // AGENT_HARNESS.md section 2.5: an error after content discards the partial step and
  // retries it once at once; the 1 s network backoff is for failures before any content.
  it("retries a stream cut off after content at once, as a mid-stream failure", async () => {
    const { clock, provider, caller } = setup([
      { events: [{ type: "text_delta", text: "partial" }] },
      successLine("complete", "stop"),
    ]);
    const recorder = recordHooks();
    const tracker = track(
      caller.runStep(makeRequest(), new AbortController().signal, recorder.hooks),
    );
    await advanceUntilSettled(clock, tracker, 1000);

    expect(tracker.value).toMatchObject({ text: "complete", attempts: 2 });
    expect(provider.requests).toHaveLength(2);
    expect(recorder.errors[0]).toMatchObject({ category: "network", attempt: 1, retryInMs: 0 });
  });

  it("waits the network backoff when a stream ends before any content", async () => {
    const { clock, provider, caller } = setup([{ events: [] }, successLine("complete", "stop")]);
    const recorder = recordHooks();
    const tracker = track(
      caller.runStep(makeRequest(), new AbortController().signal, recorder.hooks),
    );
    await advanceUntilSettled(clock, tracker, 1000);

    expect(tracker.value).toMatchObject({ text: "complete", attempts: 2 });
    expect(provider.requests).toHaveLength(2);
    expect(recorder.errors[0]).toMatchObject({ category: "network", attempt: 1, retryInMs: 1000 });
    expect(clock.now()).toBe(1000);
  });
});
