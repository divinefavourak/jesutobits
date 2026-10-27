import { ProviderErrorSchema } from "@jesutobits/protocol";
import { z } from "zod";

/**
 * Cassettes (TESTING_STRATEGY.md section 3.1): JSONL, one line per model request, in the
 * order the harness makes them. A retried step makes a new request, so it has its own line.
 * `step` is the request's position (0, 1, 2...) and must count up from 0, which keeps a
 * cassette readable. `expect` checks what the harness sent, so cassettes test context
 * building too.
 */

const NonNegative = z.number().int().nonnegative();

/** What the request must contain; every given field must hold. */
export const CassetteExpectSchema = z
  .object({
    /** The last user message contains this text. */
    lastUserTextIncludes: z.string().optional(),
    /** The last tool result contains this text. */
    lastToolResultIncludes: z.string().optional(),
    /** The last tool result is (or is not) an error. */
    lastToolResultIsError: z.boolean().optional(),
    systemIncludes: z.string().optional(),
    /** Some message, or the system prompt, contains this text. */
    anyMessageIncludes: z.string().optional(),
    /** No message and not the system prompt contains this text (canaries, elision). */
    noMessageIncludes: z.string().optional(),
    toolsInclude: z.array(z.string()).optional(),
    toolsExclude: z.array(z.string()).optional(),
    model: z.string().optional(),
    messageCount: NonNegative.optional(),
  })
  .strict();
export type CassetteExpect = z.infer<typeof CassetteExpectSchema>;

/** A ModelStreamEvent as recorded, or one of the special events that simulate failures. */
export const CassetteEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_delta"), text: z.string() }).strict(),
  z.object({ type: z.literal("reasoning_delta"), text: z.string() }).strict(),
  z.object({ type: z.literal("tool_call_start"), callId: z.string(), name: z.string() }).strict(),
  z
    .object({ type: z.literal("tool_call_args_delta"), callId: z.string(), delta: z.string() })
    .strict(),
  z.object({ type: z.literal("tool_call_end"), callId: z.string() }).strict(),
  z
    .object({
      type: z.literal("usage"),
      inputTokens: NonNegative,
      outputTokens: NonNegative,
      cachedInputTokens: NonNegative.optional(),
      costUsd: z.number().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("finish"),
      reason: z.enum(["stop", "tool_calls", "length", "content_filter", "error"]),
    })
    .strict(),
  z
    .object({ type: z.literal("error"), error: ProviderErrorSchema, afterContent: z.boolean() })
    .strict(),
  /** Bytes without content (an SSE comment); resets the idle timer. */
  z.object({ type: z.literal("keepalive") }).strict(),
  /** No bytes for `ms` (on the injected clock): first-byte and idle timeouts. */
  z.object({ type: z.literal("stall"), ms: NonNegative }).strict(),
  /** The request fails with this status before any content. */
  z
    .object({
      type: z.literal("http_error"),
      status: z.number().int().min(400).max(599),
      retryAfterMs: NonNegative.optional(),
      message: z.string().optional(),
    })
    .strict(),
]);
export type CassetteEvent = z.infer<typeof CassetteEventSchema>;

export const CassetteLineSchema = z
  .object({
    step: NonNegative,
    expect: CassetteExpectSchema.optional(),
    events: z.array(CassetteEventSchema),
  })
  .strict();
export type CassetteLine = z.infer<typeof CassetteLineSchema>;

/** Parses JSONL; blank lines are skipped. Throws with the line number on a bad line. */
export function parseCassette(text: string): CassetteLine[] {
  const lines: CassetteLine[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (raw.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`Cassette line ${index + 1} is not JSON`);
    }
    const parsed = CassetteLineSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`Cassette line ${index + 1}: ${z.prettifyError(parsed.error)}`);
    }
    if (parsed.data.step !== lines.length) {
      throw new Error(
        `Cassette line ${index + 1} is step ${parsed.data.step}; expected ${lines.length}`,
      );
    }
    lines.push(parsed.data);
  });
  return lines;
}

export function serialiseCassette(lines: readonly CassetteLine[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}
