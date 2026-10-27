// The canary (SECURITY.md 6.6, invariant 3): a fake key that must travel only inside the
// request's Authorization header. It may never reach an event, a log line or the runtime's
// own data directory; the stored record shows the value the user typed masked instead.
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  awaitTurnEnd,
  dispose,
  filesUnder,
  result,
  send,
  setupAgent,
  tempBase,
} from "./agent-helpers.js";
import { RuntimeHarness } from "./harness/runtime-harness.js";

const CANARY = "sk-or-v1-CANARY-0123456789abcdef0123456789";
const MODEL = "test/model";
/** The store that fetches the key answers under this reference. */
const KEY_REF = "provider:openrouter:default";

let base: string;
let project: string;
let harness: RuntimeHarness | undefined;
let server: Server;
/** What the fake OpenRouter saw in the Authorization header, from the last request. */
let sawAuth: string | null;
/** Whether the fake OpenRouter was asked to complete a chat at all. */
let sawChat: boolean;

const models = {
  data: [
    {
      id: MODEL,
      name: "Test model",
      context_length: 100_000,
      supported_parameters: ["tools"],
      pricing: { prompt: "0.000001", completion: "0.000002" },
    },
  ],
};

beforeEach(async () => {
  base = tempBase("jesutobits-agent-canary-");
  project = path.join(base, "my-app");
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "src", "a.ts"), "export const a = 1;\r\n");
  sawAuth = null;
  sawChat = false;
  server = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.endsWith("/api/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(models));
    } else if (request.method === "GET" && url.endsWith("/api/v1/key")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { label: "canary test" } }));
    } else if (request.method === "POST" && url.endsWith("/api/v1/chat/completions")) {
      sawAuth = request.headers.authorization ?? null;
      sawChat = true;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (body: unknown): boolean => response.write(`data: ${JSON.stringify(body)}\n\n`);
      chunk({ choices: [{ delta: { role: "assistant", content: "Canary reply." } }] });
      chunk({ choices: [{ delta: {}, finish_reason: "stop" }] });
      chunk({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.0001 },
      });
      response.end("data: [DONE]\n\n");
    } else {
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterEach(async () => {
  harness?.kill();
  await harness?.exited;
  harness = undefined;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
  dispose(base);
});

/** A runtime pointed at the fake OpenRouter, already configured with the default model. */
async function startCanaryRuntime(
  secrets: Record<string, string>,
): Promise<{ runtime: RuntimeHarness; sessionId: string }> {
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const runtime = RuntimeHarness.start({
    env: { JESUTOBITS_OPENROUTER_URL: url },
    dataDir: path.join(base, "data"),
    secrets,
  });
  harness = runtime;
  await runtime.initialize();
  result<"runtime.configure">(
    await runtime.call("runtime.configure", {
      settings: { providers: { openrouter: { defaultModel: MODEL } }, agent: {}, privacy: {} },
      appDirs: [],
    } as never),
  );
  const { sessionId } = await setupAgent(runtime, project);
  return { runtime, sessionId };
}

describe("the canary key (SECURITY.md 6.6)", () => {
  it("travels only in the request header, and the stored record shows it masked", async () => {
    const { runtime, sessionId } = await startCanaryRuntime({ [KEY_REF]: CANARY });
    const connection = result<"models.testConnection">(
      await runtime.call("models.testConnection", {}),
    );
    expect(connection).toEqual({ ok: true });

    const turnId = await send(runtime, sessionId, `remember ${CANARY} for later`);
    const end = await awaitTurnEnd(runtime, turnId);
    expect(end.type).toBe("turn.completed");

    // Sent once, in the header alone.
    expect(sawChat).toBe(true);
    expect(sawAuth).toBe(`Bearer ${CANARY}`);

    // Nowhere in an event or a log line.
    for (const event of runtime.events) {
      expect(JSON.stringify(event)).not.toContain(CANARY);
    }
    expect(runtime.stderr.join("")).not.toContain(CANARY);
    for (const line of runtime.logLines()) {
      expect(JSON.stringify(line)).not.toContain(CANARY);
    }

    // The stored start of the turn keeps the message useful but the value masked.
    const record = JSON.stringify(
      runtime.events.find((event) => event.type === "turn.started") ?? {},
    );
    expect(record).toContain(`[REDACTED:${KEY_REF}]`);
  });

  // Invariant 3: the data directory never holds the key, even when the user pastes it into a
  // message (stored messages, events and the session title are masked).
  it("leaves no canary bytes anywhere under the data directory", async () => {
    const { runtime, sessionId } = await startCanaryRuntime({ [KEY_REF]: CANARY });
    const turnId = await send(runtime, sessionId, `remember ${CANARY} for later`);
    expect((await awaitTurnEnd(runtime, turnId)).type).toBe("turn.completed");
    await new Promise((resolve) => setTimeout(resolve, 400)); // Let the storage settle.
    const holding = filesUnder(path.join(base, "data")).filter((file) =>
      readFileSync(file).includes(Buffer.from(CANARY)),
    );
    expect(holding).toEqual([]);
  });

  it("fails the turn asking for the key when none is stored", async () => {
    const { runtime, sessionId } = await startCanaryRuntime({});
    const turnId = await send(runtime, sessionId, "a plain question, no key stored");

    const end = await awaitTurnEnd(runtime, turnId);
    expect(end.type).toBe("turn.failed");
    expect((end as { error?: Record<string, unknown> }).error).toMatchObject({
      code: "provider.no_credentials",
      message: "No OpenRouter API key is stored. Add one in Settings > Models & providers.",
      userAction: "open_settings",
    });
    // Nothing was ever sent: there was nothing to authenticate with.
    expect(sawChat).toBe(false);
  });
});
