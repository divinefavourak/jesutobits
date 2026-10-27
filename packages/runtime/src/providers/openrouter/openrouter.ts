import {
  OpenRouterOptionsSchema,
  type ModelInfo,
  type OpenRouterOptions,
  type ProviderError,
} from "@jesutobits/protocol";
import { z } from "zod";
import { systemClock, type Clock } from "../../clock.js";
import { errorFromHttp, parseRetryAfter, providerError } from "../errors.js";
import type {
  ChatMessage,
  ContentPart,
  FinishReason,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
} from "../types.js";
import { SseParser } from "./sse.js";

/** RN-25. Tests point the adapter at a local mock server instead. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterProviderOptions {
  /** The key, from the CredentialClient (`host.secrets.get`); never stored here. */
  getCredential(): Promise<string>;
  baseUrl?: string;
  fetch?: typeof fetch;
  clock?: Clock;
  /** Send OpenRouter's app attribution header (`privacy.providerAttributionHeaders`). */
  attribution?: boolean;
}

/**
 * The OpenRouter adapter over Chat Completions with streaming (ADR-0005, AGENT_HARNESS.md
 * section 2.2). It maps requests and the SSE stream and categorises failures; retries,
 * timeouts and fetching the key again after a 401 belong to the ProviderCaller.
 */
export class OpenRouterProvider implements ModelProvider {
  readonly id = "openrouter";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;

  constructor(private readonly options: OpenRouterProviderOptions) {
    this.baseUrl = (options.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.clock = options.clock ?? systemClock;
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    let headers: Record<string, string>;
    try {
      headers = await this.headers();
    } catch (error) {
      yield { type: "error", error: credentialFailure(error), afterContent: false };
      return;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(toRequestBody(request)),
        signal,
      });
    } catch (error) {
      yield { type: "error", error: fetchFailure(error, signal), afterContent: false };
      return;
    }
    if (!response.ok) {
      yield { type: "error", error: await httpFailure(response, this.clock), afterContent: false };
      return;
    }
    if (!response.body) {
      yield {
        type: "error",
        error: providerError("provider_unavailable", "The response had no body"),
        afterContent: false,
      };
      return;
    }
    yield* readStream(response.body, signal);
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const response = await this.get("/models", signal);
    const parsed = ModelsResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw providerError(
        "provider_unavailable",
        "OpenRouter sent a model list Jesutobits cannot read",
      );
    }
    return parsed.data.data.flatMap((model) => {
      const info = toModelInfo(model);
      return info ? [info] : [];
    });
  }

  async testConnection(
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; error: ProviderError }> {
    try {
      // Describes the key itself; answers 401 for a key OpenRouter does not know.
      await this.get("/key", signal);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: asProviderError(error) };
    }
  }

  /** GET with the key; a failure throws a ProviderError. */
  private async get(path: string, signal: AbortSignal | undefined): Promise<Response> {
    let headers: Record<string, string>;
    try {
      headers = await this.headers();
    } catch (error) {
      throw credentialFailure(error);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers,
        ...(signal && { signal }),
      });
    } catch (error) {
      throw fetchFailure(error, signal);
    }
    if (!response.ok) throw await httpFailure(response, this.clock);
    return response;
  }

  private async headers(): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.options.getCredential()}`,
      "content-type": "application/json",
      ...(this.options.attribution && { "x-title": "Jesutobits" }),
    };
  }
}

// Request mapping.

function toRequestBody(request: ModelRequest): Record<string, unknown> {
  const options: OpenRouterOptions = OpenRouterOptionsSchema.parse(request.providerOptions ?? {});
  return {
    model: request.model,
    stream: true,
    // The final chunk carries tokens and cost (RN-26).
    usage: { include: true },
    messages: [{ role: "system", content: request.system }, ...request.messages.map(toMessage)],
    ...(request.tools.length > 0 && {
      tools: request.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
    }),
    ...(request.toolChoice !== undefined && { tool_choice: toToolChoice(request.toolChoice) }),
    max_tokens: request.maxOutputTokens,
    ...(request.temperature !== undefined && { temperature: request.temperature }),
    provider: options.provider,
    ...(options.models && { models: options.models }),
  };
}

function toMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case "user":
      return { role: "user", content: toContent(message.content) };
    case "assistant": {
      const text = textOf(message.content);
      return {
        role: "assistant",
        content: text === "" ? null : text,
        ...(message.toolCalls?.length && {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.argumentsJson },
          })),
        }),
      };
    }
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: textOf(message.content) };
  }
}

/** Plain text stays a string; images make it the parts form. */
function toContent(parts: ContentPart[]): unknown {
  if (parts.every((part) => part.type === "text")) return textOf(parts);
  return parts.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : {
          type: "image_url",
          image_url: { url: `data:${part.mediaType};base64,${part.dataBase64}` },
        },
  );
}

function textOf(parts: ContentPart[]): string {
  return parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function toToolChoice(choice: NonNullable<ModelRequest["toolChoice"]>): unknown {
  return typeof choice === "string"
    ? choice
    : { type: "function", function: { name: choice.name } };
}

// Stream mapping.

const ToolCallDeltaSchema = z.object({
  index: z.number().int().nonnegative(),
  id: z.string().optional(),
  function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional(),
});

const ChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            reasoning: z.string().nullish(),
            tool_calls: z.array(ToolCallDeltaSchema).nullish(),
          })
          .nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.number().nonnegative(),
      completion_tokens: z.number().nonnegative(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().nonnegative() }).nullish(),
      cost: z.number().nonnegative().nullish(),
    })
    .nullish(),
  error: z
    .object({
      code: z.union([z.number(), z.string()]).optional(),
      message: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).nullish(),
    })
    .optional(),
});

const FINISH_REASONS: ReadonlySet<string> = new Set([
  "stop",
  "tool_calls",
  "length",
  "content_filter",
  "error",
]);

/** Turns the SSE body into ModelStreamEvents (AGENT_HARNESS.md section 2.2). */
async function* readStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<ModelStreamEvent> {
  const queue: ModelStreamEvent[] = [];
  /** Tool calls by OpenRouter's index; `open` until the step finishes. */
  const calls = new Map<number, { callId: string; open: boolean }>();
  let afterContent = false;
  let finished = false;
  let done = false;

  const fail = (error: ProviderError) => {
    queue.push({ type: "error", error, afterContent });
    done = true;
  };
  const closeCalls = () => {
    for (const call of calls.values()) {
      if (call.open) queue.push({ type: "tool_call_end", callId: call.callId });
      call.open = false;
    }
  };

  const parser = new SseParser(
    ({ data }) => {
      if (done) return;
      if (data === "[DONE]") {
        done = true;
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        fail(providerError("provider_unavailable", "OpenRouter sent a chunk that is not JSON"));
        return;
      }
      const parsed = ChunkSchema.safeParse(json);
      if (!parsed.success) {
        fail(
          providerError("provider_unavailable", "OpenRouter sent a chunk Jesutobits cannot read"),
        );
        return;
      }
      const chunk = parsed.data;
      // A mid-stream failure (RN-27): a top-level error, with finish_reason "error".
      if (chunk.error) {
        const status = typeof chunk.error.code === "number" ? chunk.error.code : 502;
        const errorType = chunk.error.metadata?.error_type;
        fail(
          errorFromHttp(status, {
            ...(chunk.error.message !== undefined && { message: chunk.error.message }),
            ...(typeof errorType === "string" && { providerErrorType: errorType }),
          }),
        );
        return;
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta?.reasoning) {
        afterContent = true;
        queue.push({ type: "reasoning_delta", text: delta.reasoning });
      }
      if (delta?.content) {
        afterContent = true;
        queue.push({ type: "text_delta", text: delta.content });
      }
      for (const fragment of delta?.tool_calls ?? []) {
        let call = calls.get(fragment.index);
        if (!call) {
          // The first fragment of a call carries its ID and name.
          const callId = fragment.id ?? `call-${fragment.index}`;
          call = { callId, open: true };
          calls.set(fragment.index, call);
          afterContent = true;
          queue.push({ type: "tool_call_start", callId, name: fragment.function?.name ?? "" });
        }
        if (fragment.function?.arguments) {
          queue.push({
            type: "tool_call_args_delta",
            callId: call.callId,
            delta: fragment.function.arguments,
          });
        }
      }
      // The usage chunk repeats the finish reason; it counts for accounting only (RN-26).
      if (choice?.finish_reason && !finished) {
        finished = true;
        closeCalls();
        const reason = FINISH_REASONS.has(choice.finish_reason)
          ? (choice.finish_reason as FinishReason)
          : "stop";
        queue.push({ type: "finish", reason });
      }
      if (chunk.usage) {
        queue.push({
          type: "usage",
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          ...(chunk.usage.prompt_tokens_details && {
            cachedInputTokens: chunk.usage.prompt_tokens_details.cached_tokens,
          }),
          ...(chunk.usage.cost != null && { costUsd: chunk.usage.cost }),
        });
      }
    },
    () => queue.push({ type: "keepalive" }),
  );

  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (!done) {
      let read: Awaited<ReturnType<typeof reader.read>>;
      try {
        read = await reader.read();
      } catch (error) {
        fail(fetchFailure(error, signal));
        break;
      }
      if (read.done) {
        parser.feed(decoder.decode());
        parser.end();
        if (!finished && !done) {
          fail(providerError("network", "The stream ended before the response was complete"));
        }
        break;
      }
      parser.feed(decoder.decode(read.value, { stream: true }));
      while (queue.length > 0) yield queue.shift() as ModelStreamEvent;
    }
    while (queue.length > 0) yield queue.shift() as ModelStreamEvent;
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

// Failures.

/**
 * The key could not be had: none is stored, or the credential store failed. Either way the
 * user must act in Settings, so it is `auth`; the type tells the two apart.
 */
function credentialFailure(error: unknown): ProviderError {
  const missing = error instanceof Error && error.name === "MissingCredentialError";
  return providerError(
    "auth",
    error instanceof Error ? error.message : "The API key could not be read",
    { providerErrorType: missing ? "no_credentials" : "credential_store" },
  );
}

function fetchFailure(error: unknown, signal: AbortSignal | undefined): ProviderError {
  if (signal?.aborted) return providerError("cancelled", "The request was cancelled");
  const reason = error instanceof Error ? error.message : String(error);
  return providerError("network", `Could not reach OpenRouter: ${reason}`);
}

const ErrorBodySchema = z.object({
  error: z.object({
    message: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).nullish(),
  }),
});

async function httpFailure(response: Response, clock: Clock): Promise<ProviderError> {
  let message: string | undefined;
  let providerErrorType: string | undefined;
  try {
    const body = ErrorBodySchema.safeParse(await response.json());
    if (body.success) {
      message = body.data.error.message;
      const type = body.data.error.metadata?.error_type;
      if (typeof type === "string") providerErrorType = type;
    }
  } catch {
    // Not JSON: the status alone categorises it.
  }
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), clock.now());
  return errorFromHttp(response.status, {
    ...(message !== undefined && { message }),
    ...(providerErrorType !== undefined && { providerErrorType }),
    ...(retryAfterMs !== undefined && { retryAfterMs }),
  });
}

function asProviderError(error: unknown): ProviderError {
  const parsed = z
    .object({ category: z.string(), message: z.string(), retryable: z.boolean() })
    .loose()
    .safeParse(error);
  return parsed.success
    ? (parsed.data as ProviderError)
    : providerError("unknown", error instanceof Error ? error.message : String(error));
}

// Models.

const ModelEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    context_length: z.number().nullish(),
    pricing: z.object({ prompt: z.string(), completion: z.string() }).partial().nullish(),
    top_provider: z.object({ max_completion_tokens: z.number().nullish() }).nullish(),
    supported_parameters: z.array(z.string()).nullish(),
    architecture: z.object({ input_modalities: z.array(z.string()).nullish() }).nullish(),
  })
  .loose();

const ModelsResponseSchema = z.object({ data: z.array(z.unknown()) }).transform((value) => ({
  // One odd entry must not hide the rest.
  data: value.data.flatMap((entry) => {
    const parsed = ModelEntrySchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  }),
}));

function toModelInfo(model: z.infer<typeof ModelEntrySchema>): ModelInfo | undefined {
  if (!model.context_length || model.context_length <= 0) return undefined;
  const parameters = new Set(model.supported_parameters ?? []);
  const perMTok = (value: string | undefined) => {
    const perToken = Number(value);
    return Number.isFinite(perToken) && perToken >= 0 ? perToken * 1_000_000 : undefined;
  };
  const input = perMTok(model.pricing?.prompt);
  const output = perMTok(model.pricing?.completion);
  const maxOutput = model.top_provider?.max_completion_tokens;
  return {
    id: model.id,
    displayName: model.name ?? model.id,
    contextWindow: Math.round(model.context_length),
    ...(maxOutput && maxOutput > 0 && { maxOutputTokens: Math.round(maxOutput) }),
    capabilities: {
      tools: parameters.has("tools"),
      toolChoice: parameters.has("tool_choice"),
      parallelToolCalls: parameters.has("parallel_tool_calls"),
      vision: model.architecture?.input_modalities?.includes("image") ?? false,
      structuredOutputs: parameters.has("structured_outputs"),
      reasoning: parameters.has("reasoning") || parameters.has("include_reasoning"),
    },
    ...(input !== undefined &&
      output !== undefined && {
        pricing: { inputPerMTok: input, outputPerMTok: output, currency: "USD" as const },
      }),
    source: "provider",
  };
}
