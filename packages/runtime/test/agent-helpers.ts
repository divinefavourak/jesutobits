// Shared wiring for the agent-loop integration tests (TESTING_STRATEGY.md sections 3.1
// and 5, AGENT_HARNESS.md section 3): temp projects, cassettes, and the turn flow. The
// runtime bundle under test is spawned by RuntimeHarness and must be current.
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MethodResult } from "@jesutobits/protocol";
import { RuntimeHarness, type HarnessOptions, type RpcReply } from "./harness/runtime-harness.js";

type Event = Record<string, unknown>;

/** A temp folder at its real path (CI shows 8.3 short names otherwise). */
export function tempBase(prefix: string): string {
  return realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
}

/** Removes a temp tree, tolerating Windows file handles that close late. */
export function dispose(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** Unwraps a successful RPC reply, typed with the method's result schema. */
export function result<M extends Parameters<RuntimeHarness["call"]>[0]>(
  reply: RpcReply,
): MethodResult<M> {
  if (reply.error) throw new Error(`${reply.error.data?.code ?? ""}: ${reply.error.message}`);
  return reply.result as MethodResult<M>;
}

/** Unwraps an error reply: the test wanted the failure. */
export function errorOf(reply: RpcReply): { code: string; message: string } {
  if (!reply.error) throw new Error(`Expected an error reply, got ${JSON.stringify(reply.result)}`);
  return { code: reply.error.data?.code ?? "", message: reply.error.message };
}

// Cassettes. One line per model request, in order, `step` counting from 0.

export interface CassetteStep {
  /** What the request must contain; every given field must hold. */
  expect?: Record<string, unknown>;
  events: unknown[];
}

export function writeCassette(dir: string, name: string, steps: CassetteStep[]): string {
  const file = path.join(dir, name);
  writeFileSync(
    file,
    steps
      .map((step, index) =>
        JSON.stringify({
          step: index,
          ...(step.expect && { expect: step.expect }),
          events: step.events,
        }),
      )
      .join("\n") + "\n",
  );
  return file;
}

const usage = { type: "usage", inputTokens: 100, outputTokens: 20, costUsd: 0.001 };

/** A step whose stream answers in text only. */
export function answerStep(text: string, expect?: Record<string, unknown>): CassetteStep {
  return {
    ...(expect && { expect }),
    events: [{ type: "text_delta", text }, usage, { type: "finish", reason: "stop" }],
  };
}

/** A step whose stream explains (`text` optional), calls one tool, and stops. */
export function toolStep(
  callId: string,
  name: string,
  argsJson: string,
  text?: string,
  expect?: Record<string, unknown>,
): CassetteStep {
  return {
    ...(expect && { expect }),
    events: [
      ...(text !== undefined ? [{ type: "text_delta", text }] : []),
      { type: "tool_call_start", callId, name },
      { type: "tool_call_args_delta", callId, delta: argsJson },
      { type: "tool_call_end", callId },
      usage,
      { type: "finish", reason: "tool_calls" },
    ],
  };
}

/** `JESUTOBITS_PROVIDER=scripted` against the given cassette file. */
export function scriptedEnv(cassette: string): Record<string, string> {
  return { JESUTOBITS_PROVIDER: "scripted", JESUTOBITS_CASSETTE: cassette };
}

export interface StartedTurn {
  harness: RuntimeHarness;
  projectId: string;
  sessionId: string;
}

/**
 * Handshake, active project, trust, session: everything a scripted turn needs. The
 * scripted model is `scripted/model`, so `sessions.create` needs no `modelId`.
 */
export async function setupAgent(
  harness: RuntimeHarness,
  projectDir: string,
  options: { trusted?: boolean } = {},
): Promise<{ projectId: string; sessionId: string }> {
  await harness.initialize();
  const { project } = result<"projects.open">(
    await harness.call("projects.open", { path: projectDir }),
  );
  if (options.trusted !== false) {
    result<"projects.setTrust">(
      await harness.call("projects.setTrust", { id: project.id, trust: "trusted" }),
    );
  }
  const { session } = result<"sessions.create">(await harness.call("sessions.create", {}));
  return { projectId: project.id, sessionId: session.id };
}

/** Starts a runtime, initialises it, and keeps it for the test's `afterEach`. */
export function start(cassette: string | undefined, dataDir?: string): RuntimeHarness {
  const options: HarnessOptions = {
    ...(cassette === undefined ? {} : { env: scriptedEnv(cassette) }),
    ...(dataDir === undefined ? {} : { dataDir }),
  };
  return RuntimeHarness.start(options);
}

export async function send(
  harness: RuntimeHarness,
  sessionId: string,
  text: string,
  mode: "agent" | "ask" = "agent",
): Promise<string> {
  return result<"agent.sendMessage">(
    await harness.call("agent.sendMessage", { sessionId, text, mode }),
  ).turnId;
}

/** The events of one turn, in arrival order. */
export function turnEvents(harness: RuntimeHarness, turnId: string): Event[] {
  return harness.events.filter((event) => event.turnId === turnId);
}

/** The event of one turn that ends it: completed, failed or cancelled. */
export function awaitTurnEnd(
  harness: RuntimeHarness,
  turnId: string,
  timeoutMs = 9000,
): Promise<Event> {
  return harness.waitForEvent(
    (event) =>
      (event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.cancelled") &&
      event.turnId === turnId,
    timeoutMs,
  );
}

/** The nth event matching, starting from `from`; -1 when there is none. */
export function indexOf(events: Event[], match: (event: Event) => boolean, from = 0): number {
  for (let index = from; index < events.length; index++) {
    if (match(events[index] as Event)) return index;
  }
  return -1;
}

/** Every file under `dir`, including hidden ones like `-wal` and `-shm`. */
export function filesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const full = path.join(folder, name);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(full);
    }
  };
  walk(dir);
  return found;
}
