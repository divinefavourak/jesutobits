import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRequest, ModelStreamEvent } from "../types.js";
import { OpenRouterProvider } from "./openrouter.js";

/** A believable key that no real account owns (SECURITY.md section 6.1). */
const KEY = "sk-or-v1-test-0123456789abcdef";

/** Reads a recorded SSE body from `packages/runtime/test/fixtures/openrouter/`. */
function fixture(name: string): string {
  return readFileSync(
    new URL(`../../../test/fixtures/openrouter/${name}.sse`, import.meta.url),
    "utf8",
  );
}

/** Splits a body at awkward points, so every test crosses real chunk boundaries. */
function split(text: string, size = 23): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown> | undefined;
}

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  /** Answered as JSON in one piece: `listModels`, `testConnection` and HTTP failures. */
  json?: unknown;
  /** Answered as an event stream, one chunk at a time. */
  chunks?: readonly string[];
  /** Leaves the response open after the chunks, so only cancellation can end it. */
  holdOpen?: boolean;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2));

async function writeChunks(
  response: ServerResponse,
  chunks: readonly string[],
  holdOpen: boolean,
): Promise<void> {
  for (const chunk of chunks) {
    if (response.destroyed) return;
    response.write(chunk);
    await tick();
  }
  if (!holdOpen && !response.destroyed) response.end();
}

/** A local HTTP server that records what the adapter sent and answers from a script. */
class MockServer {
  readonly requests: RecordedRequest[] = [];
  private readonly replies: Array<(response: ServerResponse) => void> = [];
  private readonly server: Server;
  private port = 0;

  private constructor() {
    this.server = createServer((request, response) => this.handle(request, response));
  }

  static async start(): Promise<MockServer> {
    const mock = new MockServer();
    await new Promise<void>((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
    mock.port = (mock.server.address() as AddressInfo).port;
    return mock;
  }

  /** The adapter's `baseUrl`, with the same `/api/v1` suffix OpenRouter uses. */
  get url(): string {
    return `http://127.0.0.1:${this.port}/api/v1`;
  }

  reply(reply: Reply): void {
    this.replies.push((response) => {
      const headers = reply.headers ?? {};
      const status = reply.status ?? 200;
      if (reply.json !== undefined) {
        const body = JSON.stringify(reply.json);
        response.writeHead(status, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          ...headers,
        });
        response.end(body);
        return;
      }
      response.writeHead(status, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        ...headers,
      });
      void writeChunks(response, reply.chunks ?? [], reply.holdOpen ?? false);
    });
  }

  async close(): Promise<void> {
    // A held-open response would keep close() waiting; the test has already cancelled it.
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      response.on("error", () => undefined);
      const raw = Buffer.concat(parts).toString("utf8");
      this.requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: raw === "" ? undefined : (JSON.parse(raw) as Record<string, unknown>),
      });
      const handler = this.replies.shift();
      if (!handler) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "the mock server has no reply left" } }));
        return;
      }
      handler(response);
    });
  }
}

let server: MockServer;

beforeEach(async () => {
  server = await MockServer.start();
});

afterEach(async () => {
  await server.close();
});

function makeProvider(options: { attribution?: boolean } = {}): OpenRouterProvider {
  return new OpenRouterProvider({
    baseUrl: server.url,
    getCredential: async () => KEY,
    ...(options.attribution === undefined ? {} : { attribution: options.attribution }),
  });
}

/** The single request the adapter made; fails the test when it made none or several. */
function onlyRequest(): RecordedRequest {
  expect(server.requests).toHaveLength(1);
  const [sent] = server.requests;
  if (!sent) throw new Error("the mock server recorded no request");
  return sent;
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function request(extra: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "anthropic/claude-sonnet-x",
    system: "You are the coding agent.",
    messages: [{ role: "user", content: [{ type: "text", text: "fix the failing test" }] }],
    tools: [],
    maxOutputTokens: 4096,
    ...extra,
  };
}

/** One of everything the request mapping has to translate. */
function fullRequest(): ModelRequest {
  return request({
    messages: [
      { role: "user", content: [{ type: "text", text: "fix the failing test" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "I will read the file." }],
        toolCalls: [{ id: "call_1", name: "read_file", argumentsJson: '{"path":"src/a.ts"}' }],
      },
      {
        role: "tool",
        toolCallId: "call_1",
        content: [{ type: "text", text: "export const a = 1;" }],
      },
    ],
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
  });
}

/** Streams one scripted reply through the adapter. */
async function answers(model: ModelRequest = request()): Promise<ModelStreamEvent[]> {
  return collect(makeProvider().stream(model, new AbortController().signal));
}

describe("OpenRouterProvider requests", () => {
  it("posts a mapped Chat Completions request", async () => {
    server.reply({ chunks: split(fixture("text")) });
    await answers(fullRequest());

    const sent = onlyRequest();
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("/api/v1/chat/completions");
    expect(sent.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent.headers["content-type"]).toBe("application/json");
    expect(sent.body).toEqual({
      model: "anthropic/claude-sonnet-x",
      stream: true,
      usage: { include: true },
      messages: [
        { role: "system", content: "You are the coding agent." },
        { role: "user", content: "fix the failing test" },
        {
          role: "assistant",
          content: "I will read the file.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"src/a.ts"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "export const a = 1;" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        },
      ],
      max_tokens: 4096,
      // Privacy first (AGENT_HARNESS.md section 2.2): fallbacks allowed, no data collection.
      provider: { allow_fallbacks: true, data_collection: "deny" },
    });
  });

  it("caps a reasoning model's thinking with a token budget", async () => {
    server.reply({ chunks: split(fixture("text")) });
    await answers(request({ maxOutputTokens: 16_384, reasoningBudget: 8192 }));
    expect(onlyRequest().body).toMatchObject({
      max_tokens: 16_384,
      reasoning: { max_tokens: 8192 },
    });
  });

  it("omits the attribution header unless asked", async () => {
    server.reply({ chunks: split(fixture("text")) });
    await answers();
    expect(onlyRequest().headers["x-title"]).toBeUndefined();
  });

  it("sends the attribution header when asked", async () => {
    server.reply({ chunks: split(fixture("text")) });
    await collect(
      makeProvider({ attribution: true }).stream(request(), new AbortController().signal),
    );
    expect(onlyRequest().headers["x-title"]).toBe("Jesutobits");
  });
});

describe("OpenRouterProvider stream mapping", () => {
  it("maps text deltas, comments and the usage chunk", async () => {
    server.reply({ chunks: split(fixture("text")) });
    expect(await answers()).toEqual([
      { type: "keepalive" },
      { type: "text_delta", text: "Hello" },
      { type: "keepalive" },
      { type: "text_delta", text: " world" },
      { type: "text_delta", text: "!" },
      { type: "finish", reason: "stop" },
      { type: "usage", inputTokens: 12, outputTokens: 5, cachedInputTokens: 4, costUsd: 0.000123 },
    ]);
  });

  it("maps tool-call fragments to start, argument deltas and one end per call", async () => {
    server.reply({ chunks: split(fixture("tool-calls")) });
    expect(await answers()).toEqual([
      { type: "tool_call_start", callId: "call_abc", name: "read_file" },
      { type: "tool_call_args_delta", callId: "call_abc", delta: '{"path":' },
      { type: "tool_call_start", callId: "call_def", name: "list_dir" },
      { type: "tool_call_args_delta", callId: "call_abc", delta: '"src/a.ts"}' },
      { type: "tool_call_args_delta", callId: "call_def", delta: "{}" },
      { type: "tool_call_end", callId: "call_abc" },
      { type: "tool_call_end", callId: "call_def" },
      { type: "finish", reason: "tool_calls" },
      { type: "usage", inputTokens: 20, outputTokens: 8, costUsd: 0.0002 },
    ]);
  });

  it("ends a stream that fails after content with one error (RN-27)", async () => {
    server.reply({ chunks: split(fixture("mid-stream-error")) });
    expect(await answers()).toEqual([
      { type: "text_delta", text: "Starting to answer" },
      {
        type: "error",
        error: {
          category: "provider_unavailable",
          message: "Provider returned an error",
          retryable: true,
          httpStatus: 502,
          providerErrorType: "provider_error",
        },
        afterContent: true,
      },
    ]);
  });

  it("marks an error before any content as afterContent false", async () => {
    server.reply({ chunks: split(fixture("early-error")) });
    expect(await answers()).toEqual([
      {
        type: "error",
        error: {
          category: "provider_unavailable",
          message: "Upstream provider failed",
          retryable: true,
          httpStatus: 502,
          providerErrorType: "provider_error",
        },
        afterContent: false,
      },
    ]);
  });

  it("treats a stream with no finish and no [DONE] as a network failure", async () => {
    server.reply({ chunks: split(fixture("truncated")) });
    expect(await answers()).toEqual([
      { type: "text_delta", text: "A partial answer" },
      {
        type: "error",
        error: {
          category: "network",
          message: "The stream ended before the response was complete",
          retryable: true,
        },
        afterContent: true,
      },
    ]);
  });
});

describe("OpenRouterProvider credentials", () => {
  it("reports a missing key as auth with no request sent", async () => {
    const missing = Object.assign(new Error("No OpenRouter API key is stored."), {
      name: "MissingCredentialError",
    });
    const provider = new OpenRouterProvider({
      baseUrl: server.url,
      getCredential: () => Promise.reject(missing),
    });
    expect(await collect(provider.stream(request(), new AbortController().signal))).toEqual([
      {
        type: "error",
        error: {
          category: "auth",
          message: "No OpenRouter API key is stored.",
          retryable: false,
          providerErrorType: "no_credentials",
        },
        afterContent: false,
      },
    ]);
    expect(await provider.testConnection()).toMatchObject({
      ok: false,
      error: { category: "auth", providerErrorType: "no_credentials" },
    });
    expect(server.requests).toHaveLength(0);
  });
});

describe("OpenRouterProvider HTTP failures", () => {
  it("maps 401 to auth and keeps the provider's message", async () => {
    server.reply({ status: 401, json: { error: { message: "No auth credentials found" } } });
    expect(await answers()).toEqual([
      {
        type: "error",
        error: {
          category: "auth",
          message: "No auth credentials found",
          retryable: false,
          httpStatus: 401,
        },
        afterContent: false,
      },
    ]);
  });

  it("maps 402 to insufficient credits", async () => {
    server.reply({ status: 402, json: { error: { message: "Insufficient credits" } } });
    expect(await answers()).toEqual([
      {
        type: "error",
        error: {
          category: "insufficient_credits",
          message: "Insufficient credits",
          retryable: false,
          httpStatus: 402,
        },
        afterContent: false,
      },
    ]);
  });

  it("maps 429 to rate_limited with Retry-After in milliseconds", async () => {
    server.reply({
      status: 429,
      headers: { "retry-after": "2" },
      json: { error: { message: "Rate limit exceeded" } },
    });
    expect(await answers()).toEqual([
      {
        type: "error",
        error: {
          category: "rate_limited",
          message: "Rate limit exceeded",
          retryable: true,
          httpStatus: 429,
          retryAfterMs: 2000,
        },
        afterContent: false,
      },
    ]);
  });
});

describe("OpenRouterProvider cancellation", () => {
  it("ends a cancelled stream within two seconds", async () => {
    server.reply({
      chunks: [
        'data: {"choices":[{"index":0,"delta":{"content":"Held"},"finish_reason":null}]}\n\n',
      ],
      holdOpen: true,
    });
    const controller = new AbortController();
    const events: ModelStreamEvent[] = [];
    const started = Date.now();
    for await (const event of makeProvider().stream(request(), controller.signal)) {
      events.push(event);
      if (event.type === "text_delta") controller.abort();
    }
    expect(Date.now() - started).toBeLessThan(2000);
    expect(events).toEqual([
      { type: "text_delta", text: "Held" },
      {
        type: "error",
        error: { category: "cancelled", message: "The request was cancelled", retryable: false },
        afterContent: true,
      },
    ]);
  });
});

describe("OpenRouterProvider network failures", () => {
  it("maps a refused connection to a network error", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const provider = new OpenRouterProvider({
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      getCredential: async () => KEY,
    });
    const events = await collect(provider.stream(request(), new AbortController().signal));
    expect(events).toEqual([
      {
        type: "error",
        error: {
          category: "network",
          message: expect.stringMatching(/^Could not reach OpenRouter: /),
          retryable: true,
        },
        afterContent: false,
      },
    ]);
  });
});

describe("OpenRouterProvider model list", () => {
  it("maps pricing, capabilities and limits, skipping unusable entries", async () => {
    server.reply({
      json: {
        data: [
          {
            id: "anthropic/claude-sonnet-x",
            name: "Claude Sonnet X",
            context_length: 200_000,
            pricing: { prompt: "0.000003", completion: "0.000015" },
            top_provider: { max_completion_tokens: 8192 },
            supported_parameters: ["tools", "tool_choice", "reasoning"],
            architecture: { input_modalities: ["text", "image"] },
          },
          { id: "example/no-context-length", name: "No context length" },
          { id: "example/malformed", context_length: "lots" },
        ],
      },
    });

    expect(await makeProvider().listModels()).toEqual([
      {
        id: "anthropic/claude-sonnet-x",
        displayName: "Claude Sonnet X",
        contextWindow: 200_000,
        maxOutputTokens: 8192,
        capabilities: {
          tools: true,
          toolChoice: true,
          parallelToolCalls: false,
          vision: true,
          structuredOutputs: false,
          reasoning: true,
        },
        pricing: { inputPerMTok: 3, outputPerMTok: 15, currency: "USD" },
        source: "provider",
      },
    ]);

    const sent = onlyRequest();
    expect(sent.method).toBe("GET");
    expect(sent.url).toBe("/api/v1/models");
    expect(sent.headers.authorization).toBe(`Bearer ${KEY}`);
  });
});

describe("OpenRouterProvider connection test", () => {
  it("reports a working key", async () => {
    server.reply({ json: { data: { label: "test key", limit: null } } });
    expect(await makeProvider().testConnection()).toEqual({ ok: true });

    const sent = onlyRequest();
    expect(sent.method).toBe("GET");
    expect(sent.url).toBe("/api/v1/key");
  });

  it("reports a rejected key as an auth error", async () => {
    server.reply({ status: 401, json: { error: { message: "User not found." } } });
    expect(await makeProvider().testConnection()).toEqual({
      ok: false,
      error: {
        category: "auth",
        message: "User not found.",
        retryable: false,
        httpStatus: 401,
      },
    });
  });
});
