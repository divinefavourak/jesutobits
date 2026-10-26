import type { EventCorrelation, EventPayload, ToolError } from "@jesutobits/protocol";
import type { Logger } from "@jesutobits/shared";
import { z } from "zod";
import { systemClock, type Clock } from "../clock.js";
import { hashInput, type BrokerDecision, type PermissionBroker } from "../permissions/broker.js";
import type { Database } from "../storage/database.js";
import type { ToolRegistry } from "./registry.js";
import {
  toolError,
  type AnyTool,
  type RiskAssessment,
  type ToolContext,
  type ToolResult,
} from "./common/types.js";

/** `modelText` limit per call (AGENT_HARNESS.md section 5.2). */
export const MAX_MODEL_TEXT_BYTES = 16 * 1024;
/** How long a tool may ignore cancellation before the harness gives up on it (NFR-025). */
export const CANCEL_GRACE_MS = 2000;
const PREVIEW_STRING_CHARS = 300;
const RESULT_PREVIEW_CHARS = 2000;

export interface ToolCallRequest {
  /** Our `call_` ID, used in events and the database. */
  callId: string;
  name: string;
  argumentsJson: string;
  /** The model's text before the call, for the approval card (FR-055). */
  agentExplanation?: string;
}

export interface ToolRunOutcome {
  result: ToolResult;
  /** How the broker decided, for the loop guard and the summary. */
  decision: "allow" | "ask_allowed" | "ask_denied" | "deny" | "prohibited" | "invalid";
  /** The input after validation (absent when it did not validate). */
  input?: unknown;
}

type Emit = <T extends "tool.started" | "tool.completed">(
  type: T,
  payload: EventPayload<T>,
  correlation: EventCorrelation,
) => void;

export interface ToolRunnerOptions {
  registry: ToolRegistry;
  broker: PermissionBroker;
  db: Database;
  emit: Emit;
  log: Logger;
  /** Masks secrets in what is stored and shown (SecretRegistry.maskValue). */
  mask(value: unknown): unknown;
  clock?: Clock;
}

/**
 * Runs one tool call (AGENT_HARNESS.md section 5): validate the input, classify it, get the
 * broker's grant, execute with a timeout and the turn's signal, then truncate. Tools never
 * throw to the loop: every failure becomes a ToolResult the model can read.
 */
export class ToolRunner {
  private readonly clock: Clock;

  constructor(private readonly options: ToolRunnerOptions) {
    this.clock = options.clock ?? systemClock;
  }

  async run(call: ToolCallRequest, ctx: ToolContext, signal: AbortSignal): Promise<ToolRunOutcome> {
    const started = this.clock.now();
    const correlation = {
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      callId: call.callId,
    };
    const tool = this.options.registry.get(call.name);

    const finish = (
      result: ToolResult,
      decision: ToolRunOutcome["decision"],
      input?: unknown,
    ): ToolRunOutcome => {
      const bounded = truncateResult(result);
      const ok = bounded.ok;
      const summary =
        tool && input !== undefined ? safeSummary(tool, input, bounded) : `${call.name} failed`;
      this.options.db.run(
        `UPDATE tool_calls SET ended_at = ?, ok = ?, error_code = ?, result_preview = ? WHERE id = ?`,
        [
          new Date(this.clock.now()).toISOString(),
          ok ? 1 : 0,
          ok ? null : bounded.error.code,
          String(this.options.mask(bounded.modelText.slice(0, RESULT_PREVIEW_CHARS))),
          call.callId,
        ],
      );
      this.options.emit(
        "tool.completed",
        {
          tool: call.name,
          ok,
          durationMs: Math.max(0, this.clock.now() - started),
          summary: String(this.options.mask(summary)),
          ...(bounded.ok &&
            bounded.outputPreview !== undefined && {
              outputPreview: String(this.options.mask(bounded.outputPreview)),
            }),
          ...(bounded.ok && bounded.diff && { diff: bounded.diff }),
          ...(!bounded.ok && { error: this.options.mask(bounded.error) as ToolError }),
        },
        correlation,
      );
      return { result: bounded, decision, ...(input !== undefined && { input }) };
    };
    const record = (input: unknown, risk: RiskAssessment["classes"], decision: string) => {
      this.options.db.run(
        `INSERT INTO tool_calls (id, turn_id, tool, input_json, risk_json, decision, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          call.callId,
          ctx.turnId,
          call.name,
          JSON.stringify(this.options.mask(input ?? null)),
          JSON.stringify(risk),
          decision,
          new Date(started).toISOString(),
        ],
      );
    };
    const startedEvent = (input: unknown, risk: RiskAssessment["classes"], summary: string) =>
      this.options.emit(
        "tool.started",
        {
          tool: call.name,
          category: tool?.activity ?? "reading",
          summary: String(this.options.mask(summary)),
          risk,
          inputPreview: preview(this.options.mask(input)) as Record<string, unknown>,
        },
        correlation,
      );

    // 1. Validate. Malformed calls never execute (FR-050).
    const invalid = (message: string, raw: unknown) => {
      startedEvent(raw ?? {}, [], `Invalid call to ${call.name}`);
      record(raw, [], "invalid");
      return finish(toolError("invalid_input", message, { retryable: true }), "invalid");
    };
    if (!tool) {
      return invalid(
        `There is no tool named ${call.name}. Available: ${this.options.registry.names().join(", ")}`,
        {},
      );
    }
    let raw: unknown;
    try {
      raw = call.argumentsJson.trim() === "" ? {} : JSON.parse(call.argumentsJson);
    } catch {
      return invalid("The arguments are not valid JSON", {
        arguments: call.argumentsJson.slice(0, 200),
      });
    }
    const parsed = tool.input.safeParse(raw);
    if (!parsed.success) {
      return invalid(`Invalid arguments: ${z.prettifyError(parsed.error)}`, raw);
    }
    const input = parsed.data as never;

    // 2. Classify, then 3. authorise.
    let assessment: RiskAssessment;
    try {
      assessment = await tool.classify(input, ctx);
    } catch (error) {
      this.options.log.error("a tool's classify failed", { tool: call.name, err: error });
      startedEvent(input, [], safeSummary(tool, input));
      record(input, [], "deny");
      return finish(toolError("internal", "The tool could not check this call"), "deny", input);
    }
    startedEvent(input, assessment.classes, safeSummary(tool, input));

    let decision: BrokerDecision;
    try {
      decision = await this.options.broker.authorize(
        {
          projectId: ctx.projectId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          callId: call.callId,
          tool: call.name,
          input,
          assessment,
          ...(call.agentExplanation && { agentExplanation: call.agentExplanation }),
        },
        signal,
      );
    } catch (error) {
      record(input, assessment.classes, "ask_denied");
      if (signal.aborted) {
        // The approval was withdrawn with the turn; the loop handles the cancellation.
        finish(toolError("cancelled", "The turn was stopped"), "ask_denied", input);
        throw error;
      }
      this.options.log.error("the permission broker failed", { tool: call.name, err: error });
      return finish(toolError("internal", "The approval could not be recorded"), "deny", input);
    }

    if (decision.kind === "deny") {
      const kind =
        decision.by === "prohibited"
          ? "prohibited"
          : decision.by === "user"
            ? "ask_denied"
            : "deny";
      record(input, assessment.classes, kind);
      const guidance = decision.userMessage ? ` The user said: ${decision.userMessage}` : "";
      const text =
        decision.by === "prohibited"
          ? `Blocked: ${decision.reason}`
          : decision.by === "user"
            ? `The user denied this action.${guidance} Do not try to do the same thing another way; ask the user or propose an alternative.`
            : `Not allowed in this project: ${decision.reason}`;
      return finish(
        {
          ok: false,
          error: {
            code: "permission_denied",
            message: text,
            retryable: false,
            ...(decision.permissionId && { details: { permissionId: decision.permissionId } }),
          },
          modelText: text,
        },
        kind,
        input,
      );
    }

    // The grant must be for this exact call (SECURITY.md section 4.5).
    if (decision.grant.callId !== call.callId || decision.grant.inputHash !== hashInput(input)) {
      this.options.log.error("a grant did not match its call", { tool: call.name });
      record(input, assessment.classes, "deny");
      return finish(
        toolError("permission_denied", "The approval did not match this call"),
        "deny",
        input,
      );
    }
    const allowed = decision.via === "user" ? "ask_allowed" : "allow";
    // Stored before execution, so a crash cannot replay it silently.
    record(input, assessment.classes, allowed);
    if (decision.permissionId) {
      this.options.db.run("UPDATE tool_calls SET permission_id = ? WHERE id = ?", [
        decision.permissionId,
        call.callId,
      ]);
    }

    // 4. Execute.
    const result = await this.execute(
      tool,
      input,
      { ...ctx, redactValues: decision.grant.redactValues },
      signal,
    );
    return finish(result, allowed, input);
  }

  private async execute(
    tool: AnyTool,
    input: never,
    ctx: ToolContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const controller = new AbortController();
    const forward = () => controller.abort(signal.reason);
    signal.addEventListener("abort", forward, { once: true });
    const timers = new AbortController();
    let timedOut = false;
    let leaked = false;
    try {
      const running = tool
        .execute(input, ctx, controller.signal)
        .catch((error: unknown): ToolResult => {
          if (controller.signal.aborted) {
            return toolError(
              timedOut ? "timeout" : "cancelled",
              timedOut ? `${tool.name} timed out` : "The turn was stopped",
            );
          }
          this.options.log.error("a tool threw", { tool: tool.name, err: error });
          return toolError("internal", "The tool failed unexpectedly");
        });
      const timeout = this.clock.sleep(tool.timeoutMs, timers.signal).then(
        (): ToolResult => {
          timedOut = true;
          controller.abort(new Error("timeout"));
          return toolError(
            "timeout",
            `${tool.name} took longer than ${Math.round(tool.timeoutMs / 1000)} s and was stopped`,
            {
              retryable: true,
            },
          );
        },
        () => new Promise<never>(() => undefined),
      );
      // After a cancel, a tool gets CANCEL_GRACE_MS to stop before it is abandoned.
      const cancelled = new Promise<ToolResult>((resolve) => {
        const giveUp = () => {
          void this.clock.sleep(CANCEL_GRACE_MS, timers.signal).then(
            () => {
              leaked = true;
              resolve(toolError("cancelled", "The turn was stopped"));
            },
            () => undefined,
          );
        };
        if (signal.aborted) giveUp();
        else signal.addEventListener("abort", giveUp, { once: true });
      });
      const result = await Promise.race([running, timeout, cancelled]);
      if (leaked) {
        this.options.log.warn("a tool ignored cancellation", {
          tool: tool.name,
          graceMs: CANCEL_GRACE_MS,
        });
      }
      return result;
    } finally {
      timers.abort();
      signal.removeEventListener("abort", forward);
    }
  }
}

/** Keeps `modelText` within MAX_MODEL_TEXT_BYTES, saying so (AGENT_HARNESS.md 5.2). */
export function truncateResult(result: ToolResult): ToolResult {
  const bytes = Buffer.byteLength(result.modelText, "utf8");
  if (bytes <= MAX_MODEL_TEXT_BYTES) return result;
  let cut = result.modelText.slice(0, MAX_MODEL_TEXT_BYTES);
  while (Buffer.byteLength(cut, "utf8") > MAX_MODEL_TEXT_BYTES - 200) cut = cut.slice(0, -256);
  return {
    ...result,
    modelText: `${cut}\n[Output truncated: ${bytes} bytes in total, ${Buffer.byteLength(cut, "utf8")} shown. Narrow the request, for example with offset and limit.]`,
  };
}

function safeSummary(tool: AnyTool, input: unknown, result?: ToolResult): string {
  try {
    return tool.summarize(input as never, result);
  } catch {
    return tool.name;
  }
}

/** The input for the timeline: long strings shortened (AGENT_HARNESS.md section 8). */
function preview(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > PREVIEW_STRING_CHARS
      ? `${value.slice(0, PREVIEW_STRING_CHARS)}… (${value.length} characters)`
      : value;
  }
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => preview(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, preview(item, depth + 1)]),
  );
}
