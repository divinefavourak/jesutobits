import type { ModelInfo } from "@jesutobits/protocol";
import { systemClock, type Clock } from "../../clock.js";
import { errorFromHttp, providerError } from "../errors.js";
import {
  messageText,
  type ChatMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from "../types.js";
import type { CassetteExpect, CassetteLine } from "./cassette.js";

/** The one model a scripted provider offers unless a test gives others. */
export const SCRIPTED_MODEL: ModelInfo = {
  id: "scripted/model",
  displayName: "Scripted model",
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  capabilities: {
    tools: true,
    toolChoice: true,
    parallelToolCalls: true,
    vision: false,
    structuredOutputs: false,
    reasoning: false,
  },
  pricing: { inputPerMTok: 1, outputPerMTok: 2, currency: "USD" },
  source: "provider",
};

export interface ScriptedProviderOptions {
  /** Defaults to `scripted`. */
  id?: string;
  clock?: Clock;
  models?: ModelInfo[];
}

/**
 * Replays a cassette (TESTING_STRATEGY.md section 3.1): request N gets line N's events.
 * Deterministic and offline, so the whole loop is testable without a paid model (NFR-016).
 * A failed expectation, or a request beyond the cassette, ends that stream with an
 * `invalid_request` error and is recorded in `failures`.
 */
export class ScriptedProvider implements ModelProvider {
  readonly id: string;
  /** Every request made, in order (deep copies). */
  readonly requests: ModelRequest[] = [];
  /** Expectation failures and requests the cassette had no line for. */
  readonly failures: string[] = [];
  private readonly clock: Clock;
  private readonly models: ModelInfo[];
  private next = 0;

  constructor(
    private readonly lines: readonly CassetteLine[],
    options: ScriptedProviderOptions = {},
  ) {
    this.id = options.id ?? "scripted";
    this.clock = options.clock ?? systemClock;
    this.models = options.models ?? [SCRIPTED_MODEL];
  }

  /** Lines not yet played. */
  get remaining(): number {
    return this.lines.length - this.next;
  }

  async listModels(): Promise<ModelInfo[]> {
    return structuredClone(this.models);
  }

  async testConnection(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    this.requests.push(structuredClone(request));
    const index = this.next++;
    const line = this.lines[index];
    if (!line) {
      yield this.fail(`The cassette has no line for request ${index}`);
      return;
    }
    const mismatch = line.expect && checkExpectations(line.expect, request);
    if (mismatch) {
      yield this.fail(`Request ${index}: ${mismatch}`);
      return;
    }

    let afterContent = false;
    const cancelled = (): ModelStreamEvent => ({
      type: "error",
      error: providerError("cancelled", "The request was cancelled"),
      afterContent,
    });
    for (const event of line.events) {
      // Like a network stream: other work runs between chunks, and an abort is noticed.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal.aborted) {
        yield cancelled();
        return;
      }
      switch (event.type) {
        case "stall":
          try {
            await this.clock.sleep(event.ms, signal);
          } catch {
            yield cancelled();
            return;
          }
          break;
        case "http_error":
          yield {
            type: "error",
            error: errorFromHttp(event.status, {
              ...(event.message !== undefined && { message: event.message }),
              ...(event.retryAfterMs !== undefined && { retryAfterMs: event.retryAfterMs }),
            }),
            afterContent: false,
          };
          return;
        case "error":
          yield event;
          return;
        default:
          if (event.type !== "usage" && event.type !== "finish" && event.type !== "keepalive") {
            afterContent = true;
          }
          yield event;
      }
    }
  }

  private fail(message: string): ModelStreamEvent {
    this.failures.push(message);
    return {
      type: "error",
      error: providerError("invalid_request", message),
      afterContent: false,
    };
  }
}

/** Returns why the request does not match, or undefined when it does. */
export function checkExpectations(
  expect: CassetteExpect,
  request: ModelRequest,
): string | undefined {
  const last = (role: ChatMessage["role"]) =>
    [...request.messages].reverse().find((message) => message.role === role);
  const lastUser = last("user");
  const lastTool = last("tool");
  const everything = [request.system, ...request.messages.map(messageText)];
  const toolNames = request.tools.map((tool) => tool.name);

  const problems: string[] = [];
  const includes = (what: string, text: string | undefined, needle: string | undefined) => {
    if (needle !== undefined && !(text ?? "").includes(needle)) {
      problems.push(`${what} does not include ${JSON.stringify(needle)}`);
    }
  };
  includes("the last user message", lastUser && messageText(lastUser), expect.lastUserTextIncludes);
  includes(
    "the last tool result",
    lastTool && messageText(lastTool),
    expect.lastToolResultIncludes,
  );
  includes("the system prompt", request.system, expect.systemIncludes);
  if (
    expect.anyMessageIncludes !== undefined &&
    !everything.some((text) => text.includes(expect.anyMessageIncludes ?? ""))
  ) {
    problems.push(`no message includes ${JSON.stringify(expect.anyMessageIncludes)}`);
  }
  if (
    expect.noMessageIncludes !== undefined &&
    everything.some((text) => text.includes(expect.noMessageIncludes ?? ""))
  ) {
    problems.push(`a message includes ${JSON.stringify(expect.noMessageIncludes)}`);
  }
  if (expect.lastToolResultIsError !== undefined) {
    const isError = lastTool?.role === "tool" && lastTool.isError === true;
    if (isError !== expect.lastToolResultIsError) {
      problems.push(`the last tool result is${isError ? "" : " not"} an error`);
    }
  }
  for (const name of expect.toolsInclude ?? []) {
    if (!toolNames.includes(name)) problems.push(`the tools do not include ${name}`);
  }
  for (const name of expect.toolsExclude ?? []) {
    if (toolNames.includes(name)) problems.push(`the tools include ${name}`);
  }
  if (expect.model !== undefined && request.model !== expect.model) {
    problems.push(`the model is ${request.model}, not ${expect.model}`);
  }
  if (expect.messageCount !== undefined && request.messages.length !== expect.messageCount) {
    problems.push(`there are ${request.messages.length} messages, not ${expect.messageCount}`);
  }
  return problems.length > 0 ? problems.join("; ") : undefined;
}
