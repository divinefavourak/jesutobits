import type { ModelInfo, ProviderAccount, ProviderError } from "@jesutobits/protocol";

/**
 * The provider-neutral contract (ADR-0005, AGENT_HARNESS.md section 2.1). The agent loop
 * knows only these types; adapters translate to and from each provider's wire format.
 */
export interface ModelProvider {
  /** For example `openrouter`. Stored with each session. */
  readonly id: string;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  /**
   * Streams one model response. Failures, including cancellation, arrive as an `error`
   * event (the stream then ends); the iterator itself does not throw.
   */
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
  /** Checks the key; `account` is what the provider says about it, when it says. */
  testConnection(
    signal?: AbortSignal,
  ): Promise<{ ok: true; account?: ProviderAccount } | { ok: false; error: ProviderError }>;
}

export type { ModelInfo, ProviderError };

export interface ModelRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  toolChoice?: "auto" | "none" | { name: string };
  maxOutputTokens: number;
  /** Tokens a reasoning model may think for, within `maxOutputTokens`. */
  reasoningBudget?: number;
  temperature?: number;
  /** Validated by the adapter's own schema; the loop passes it through untouched. */
  providerOptions?: Record<string, unknown>;
}

/** A tool as the model sees it: JSON Schema made from the tool's Zod input. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "user"; content: ContentPart[] }
  | { role: "assistant"; content: ContentPart[]; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: ContentPart[]; isError?: boolean };

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp"; dataBase64: string };

export interface ToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error";

export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_start"; callId: string; name: string }
  | { type: "tool_call_args_delta"; callId: string; delta: string }
  | { type: "tool_call_end"; callId: string }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number | undefined;
      costUsd?: number | undefined;
    }
  | { type: "finish"; reason: FinishReason }
  /**
   * The provider sent bytes without content (an SSE comment such as OpenRouter's
   * `: OPENROUTER PROCESSING`). Resets the idle timer (AGENT_HARNESS.md section 2.5).
   */
  | { type: "keepalive" }
  /** `afterContent`: some delta was already emitted (RN-27). */
  | { type: "error"; error: ProviderError; afterContent: boolean };

/** The text of a message's text parts, joined. */
export function messageText(message: ChatMessage): string {
  return message.content
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}
