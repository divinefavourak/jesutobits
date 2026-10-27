import type { ProviderError } from "@jesutobits/protocol";
import { systemClock, type Clock } from "../clock.js";
import { providerError } from "./errors.js";
import type {
  FinishReason,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ToolCall,
} from "./types.js";

/** AGENT_HARNESS.md section 2.5. All in milliseconds. */
export interface CallerTimeouts {
  firstByte: number;
  /** For models with the `reasoning` capability, which think before the first byte. */
  firstByteReasoning: number;
  /** No bytes at all, keepalives included. */
  idle: number;
  /** The whole request; never retried. */
  total: number;
}

export const DEFAULT_TIMEOUTS: CallerTimeouts = {
  firstByte: 60_000,
  firstByteReasoning: 120_000,
  idle: 90_000,
  total: 10 * 60_000,
};

/** Retries per kind of failure within one step (AGENT_HARNESS.md section 2.5). */
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_UNAVAILABLE_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = [2000, 4000, 8000];
const UNAVAILABLE_BACKOFF_MS = [1000, 2000, 4000];

export interface StepResult {
  text: string;
  reasoning: string;
  /** Complete calls, in the order the model started them. */
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage:
    | { inputTokens: number; outputTokens: number; cachedInputTokens?: number; costUsd?: number }
    | undefined;
  /** 1 for the first try. */
  attempts: number;
}

export interface StepHooks {
  /** A request is about to be sent; from attempt 2 on, the previous one's output is void. */
  onAttempt?(attempt: number): void;
  /** Text, reasoning and tool-call events as they stream, for the UI. */
  onEvent?(event: ModelStreamEvent): void;
  /** A request failed; `retryInMs` is set when it will be retried after that wait. */
  onError?(error: ProviderError, attempt: number, retryInMs: number | undefined): void;
  /**
   * The prompt is too long: return a smaller request (after compaction) to try once more,
   * or undefined to fail the step.
   */
  onContextLength?(): Promise<ModelRequest | undefined>;
}

/** A step that failed for good; the loop ends the turn with `providerFailure(error)`. */
export class ProviderCallError extends Error {
  constructor(readonly error: ProviderError) {
    super(error.message);
    this.name = "ProviderCallError";
  }
}

export interface ProviderCallerOptions {
  provider: ModelProvider;
  clock?: Clock;
  timeouts?: Partial<CallerTimeouts>;
  /** Drops the cached key so the next request fetches it again (after a 401). */
  invalidateCredential?(): void;
  /** In [0, 1); jitter for rate-limit waits. */
  random?: () => number;
}

/**
 * Runs one model step with the retry and timeout policy of AGENT_HARNESS.md section 2.5.
 * Adapters never retry; this does. A step's tools run only after its stream ended well,
 * so retrying a step can never run a tool twice.
 */
export class ProviderCaller {
  private readonly clock: Clock;
  private readonly timeouts: CallerTimeouts;
  private readonly random: () => number;

  constructor(private readonly options: ProviderCallerOptions) {
    this.clock = options.clock ?? systemClock;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.random = options.random ?? Math.random;
  }

  /**
   * Resolves with the step, or rejects with ProviderCallError, or with the signal's reason
   * once `signal` aborts.
   */
  async runStep(
    initial: ModelRequest,
    signal: AbortSignal,
    hooks: StepHooks = {},
    model: { reasoning?: boolean } = {},
  ): Promise<StepResult> {
    let request = initial;
    let attempt = 0;
    const retries = { auth: 0, rateLimit: 0, unavailable: 0, midStream: 0, timeout: 0, context: 0 };

    for (;;) {
      signal.throwIfAborted();
      attempt++;
      hooks.onAttempt?.(attempt);
      const outcome = await this.attempt(request, signal, hooks, model.reasoning === true);
      if (outcome.ok) return { ...outcome.result, attempts: attempt };
      signal.throwIfAborted();

      const { error, afterContent } = outcome;
      const fail = (): never => {
        hooks.onError?.(error, attempt, undefined);
        throw new ProviderCallError(error);
      };
      const retryAfter = async (waitMs: number): Promise<void> => {
        hooks.onError?.(error, attempt, waitMs);
        await this.clock.sleep(waitMs, signal);
      };

      if (error.category === "cancelled") fail();
      if (error.category === "timeout" && outcome.total) fail();
      if (error.category === "timeout") {
        if (retries.timeout++ >= 1) fail();
        await retryAfter(0);
        continue;
      }
      // Content was already shown: discard the partial step and try it once more.
      if (afterContent) {
        if (retries.midStream++ >= 1) fail();
        await retryAfter(0);
        continue;
      }
      switch (error.category) {
        case "auth":
          if (retries.auth++ >= 1) fail();
          this.options.invalidateCredential?.();
          await retryAfter(0);
          continue;
        case "rate_limited": {
          if (retries.rateLimit >= MAX_RATE_LIMIT_RETRIES) fail();
          const base = RATE_LIMIT_BACKOFF_MS[retries.rateLimit++] ?? 8000;
          const wait = error.retryAfterMs ?? Math.round(base * (0.8 + 0.4 * this.random()));
          await retryAfter(wait);
          continue;
        }
        case "provider_unavailable":
        case "network": {
          if (retries.unavailable >= MAX_UNAVAILABLE_RETRIES) fail();
          await retryAfter(UNAVAILABLE_BACKOFF_MS[retries.unavailable++] ?? 4000);
          continue;
        }
        case "context_length": {
          if (retries.context++ >= 1 || !hooks.onContextLength) fail();
          hooks.onError?.(error, attempt, 0);
          const smaller = await hooks.onContextLength?.();
          if (!smaller) throw new ProviderCallError(error);
          request = smaller;
          continue;
        }
        default:
          fail();
      }
    }
  }

  /** One request with its timers. Never throws except when `signal` aborts. */
  private async attempt(
    request: ModelRequest,
    signal: AbortSignal,
    hooks: StepHooks,
    reasoning: boolean,
  ): Promise<
    | { ok: true; result: Omit<StepResult, "attempts"> }
    | { ok: false; error: ProviderError; afterContent: boolean; total?: boolean }
  > {
    const controller = new AbortController();
    const abortAttempt = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abortAttempt, { once: true });
    const stream = this.options.provider.stream(request, controller.signal);
    const iterator = stream[Symbol.asyncIterator]();

    const started = this.clock.now();
    let lastByte: number | undefined;
    let afterContent = false;
    let text = "";
    let reasoningText = "";
    let finishReason: FinishReason | undefined;
    let usage: StepResult["usage"];
    const calls = new Map<string, { name: string; args: string }>();

    try {
      for (;;) {
        const deadline = Math.min(
          lastByte === undefined
            ? started + (reasoning ? this.timeouts.firstByteReasoning : this.timeouts.firstByte)
            : lastByte + this.timeouts.idle,
          started + this.timeouts.total,
        );
        const next = await this.nextOrTimeout(iterator, deadline - this.clock.now(), signal);
        signal.throwIfAborted();
        if (next === "aborted") throw signal.reason;
        if (next === "timeout") {
          const total = this.clock.now() >= started + this.timeouts.total;
          const what = total
            ? "The model request took longer than 10 minutes"
            : lastByte === undefined
              ? "The model sent nothing in time"
              : "The model stopped sending in the middle of its answer";
          return {
            ok: false,
            error: providerError("timeout", what),
            afterContent,
            ...(total && { total: true }),
          };
        }
        if (next.done) break;
        const event = next.value;
        lastByte = this.clock.now();
        switch (event.type) {
          case "text_delta":
            afterContent = true;
            text += event.text;
            hooks.onEvent?.(event);
            break;
          case "reasoning_delta":
            afterContent = true;
            reasoningText += event.text;
            hooks.onEvent?.(event);
            break;
          case "tool_call_start":
            afterContent = true;
            calls.set(event.callId, { name: event.name, args: "" });
            hooks.onEvent?.(event);
            break;
          case "tool_call_args_delta": {
            const call = calls.get(event.callId);
            if (call) call.args += event.delta;
            break;
          }
          case "tool_call_end":
            hooks.onEvent?.(event);
            break;
          case "usage":
            usage = {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              ...(event.cachedInputTokens !== undefined && {
                cachedInputTokens: event.cachedInputTokens,
              }),
              ...(event.costUsd !== undefined && { costUsd: event.costUsd }),
            };
            break;
          case "finish":
            finishReason = event.reason;
            break;
          case "keepalive":
            break;
          case "error":
            return {
              ok: false,
              error: event.error,
              afterContent: afterContent || event.afterContent,
            };
        }
      }
    } finally {
      signal.removeEventListener("abort", abortAttempt);
      controller.abort();
      // Ask the stream to clean up, without waiting on a provider that ignores it.
      void iterator.return?.().catch(() => undefined);
    }

    if (finishReason === undefined) {
      return {
        ok: false,
        error: providerError("network", "The stream ended before the response was complete"),
        afterContent,
      };
    }
    return {
      ok: true,
      result: {
        text,
        reasoning: reasoningText,
        toolCalls: [...calls].map(([id, call]) => ({
          id,
          name: call.name,
          argumentsJson: call.args,
        })),
        finishReason,
        usage,
      },
    };
  }

  /**
   * The next event, or "timeout" after `waitMs`. Also settles when `signal` aborts, so a
   * provider that ignores its abort signal cannot hold up cancellation (NFR-025).
   */
  private async nextOrTimeout(
    iterator: AsyncIterator<ModelStreamEvent>,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<IteratorResult<ModelStreamEvent> | "timeout" | "aborted"> {
    const timer = new AbortController();
    let onAbort = () => undefined as void;
    const aborted = new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted");
      if (signal.aborted) resolve("aborted");
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([
        iterator.next(),
        // A cancelled timer rejects after the race is settled; that result is ignored.
        this.clock.sleep(Math.max(0, waitMs), timer.signal).then(
          () => "timeout" as const,
          () => "timeout" as const,
        ),
        aborted,
      ]);
    } finally {
      timer.abort();
      signal.removeEventListener("abort", onAbort);
    }
  }
}
