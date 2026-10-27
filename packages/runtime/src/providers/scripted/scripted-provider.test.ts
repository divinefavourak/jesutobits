import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../clock.js";
import type { ModelRequest, ModelStreamEvent } from "../types.js";
import { parseCassette, serialiseCassette } from "./cassette.js";
import { RecordingProvider } from "./recording-provider.js";
import { ScriptedProvider } from "./scripted-provider.js";

const request = (text: string, extra: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "scripted/model",
  system: "You are the coding agent.",
  messages: [{ role: "user", content: [{ type: "text", text }] }],
  tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }],
  maxOutputTokens: 1000,
  ...extra,
});

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const cassette = (...lines: object[]) =>
  parseCassette(lines.map((line, step) => JSON.stringify({ step, ...line })).join("\n"));

describe("parseCassette", () => {
  it("reads the example cassette and round-trips it", () => {
    const text = readFileSync(
      new URL("../../../test/cassettes/read-then-answer.jsonl", import.meta.url),
      "utf8",
    );
    const lines = parseCassette(text);
    expect(lines).toHaveLength(2);
    expect(parseCassette(serialiseCassette(lines))).toEqual(lines);
  });

  it("names the bad line", () => {
    expect(() => parseCassette('{"step":0,"events":[]}\n{"step":2,"events":[]}')).toThrow(
      /line 2 is step 2; expected 1/,
    );
    expect(() => parseCassette('{"step":0,"events":[{"type":"teleport"}]}')).toThrow(/line 1/);
    expect(() => parseCassette("not json")).toThrow(/line 1 is not JSON/);
  });
});

describe("ScriptedProvider", () => {
  it("plays one line per request and records the requests", async () => {
    const provider = new ScriptedProvider(
      cassette(
        {
          events: [
            { type: "text_delta", text: "Hi" },
            { type: "finish", reason: "stop" },
          ],
        },
        { events: [{ type: "finish", reason: "stop" }] },
      ),
    );
    const signal = new AbortController().signal;
    expect(await collect(provider.stream(request("one"), signal))).toEqual([
      { type: "text_delta", text: "Hi" },
      { type: "finish", reason: "stop" },
    ]);
    await collect(provider.stream(request("two"), signal));
    expect(provider.requests).toHaveLength(2);
    expect(provider.remaining).toBe(0);

    const beyond = await collect(provider.stream(request("three"), signal));
    expect(beyond).toMatchObject([{ type: "error", error: { category: "invalid_request" } }]);
    expect(provider.failures).toEqual(["The cassette has no line for request 2"]);
  });

  it("checks what the harness sent", async () => {
    const provider = new ScriptedProvider(
      cassette({
        expect: {
          lastUserTextIncludes: "date helper",
          toolsInclude: ["read_file"],
          toolsExclude: ["run_command"],
          noMessageIncludes: "sk-or-CANARY",
        },
        events: [{ type: "finish", reason: "stop" }],
      }),
    );
    const events = await collect(
      provider.stream(request("fix the week helper"), new AbortController().signal),
    );
    expect(events[0]).toMatchObject({ type: "error" });
    expect(provider.failures[0]).toMatch(/does not include "date helper"/);
  });

  it("turns http_error into a categorised error before any content", async () => {
    const provider = new ScriptedProvider(
      cassette({ events: [{ type: "http_error", status: 429, retryAfterMs: 2000 }] }),
    );
    expect(await collect(provider.stream(request("x"), new AbortController().signal))).toEqual([
      {
        type: "error",
        error: {
          category: "rate_limited",
          message: "HTTP 429",
          retryable: true,
          httpStatus: 429,
          retryAfterMs: 2000,
        },
        afterContent: false,
      },
    ]);
  });

  it("stalls on the injected clock and stops when cancelled", async () => {
    const clock = new FakeClock(0);
    const provider = new ScriptedProvider(
      cassette({
        events: [
          { type: "text_delta", text: "a" },
          { type: "stall", ms: 95_000 },
          { type: "text_delta", text: "b" },
        ],
      }),
      { clock },
    );
    const controller = new AbortController();
    const done = collect(provider.stream(request("x"), controller.signal));
    while (clock.pending === 0) await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    expect(await done).toEqual([
      { type: "text_delta", text: "a" },
      {
        type: "error",
        error: { category: "cancelled", message: "The request was cancelled", retryable: false },
        afterContent: true,
      },
    ]);
  });
});

describe("RecordingProvider", () => {
  it("records each stream as a masked cassette line", async () => {
    const inner = new ScriptedProvider(
      cassette({
        events: [
          { type: "text_delta", text: "key sk-or-v1-SECRETSECRETSECRET" },
          { type: "finish", reason: "stop" },
        ],
      }),
    );
    const written: string[] = [];
    const recorder = new RecordingProvider(inner, {
      write: (line) => written.push(line),
      mask: (text) => text.replaceAll("sk-or-v1-SECRETSECRETSECRET", "[REDACTED:key]"),
    });
    await collect(recorder.stream(request("x"), new AbortController().signal));
    expect(parseCassette(written.join("\n"))[0]?.events[0]).toEqual({
      type: "text_delta",
      text: "key [REDACTED:key]",
    });
  });
});
