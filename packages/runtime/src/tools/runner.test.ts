import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EventCorrelation, EventPayload } from "@jesutobits/protocol";
import { nullLogger } from "@jesutobits/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PolicyColumn } from "../permissions/policy.js";
import { PermissionBroker } from "../permissions/broker.js";
import type { AnyTool, ToolResult } from "./common/types.js";
import { ToolRegistry } from "./registry.js";
import { CANCEL_GRACE_MS, MAX_MODEL_TEXT_BYTES, ToolRunner, truncateResult } from "./runner.js";
import { openToolTestProject, type ToolTestProject } from "../../test/tool-context.js";

type HarnessEvent =
  | {
      type: "tool.started";
      payload: EventPayload<"tool.started">;
      correlation: EventCorrelation;
    }
  | {
      type: "tool.completed";
      payload: EventPayload<"tool.completed">;
      correlation: EventCorrelation;
    }
  | {
      type: "permission.requested";
      payload: EventPayload<"permission.requested">;
      correlation: EventCorrelation;
    }
  | {
      type: "permission.resolved";
      payload: EventPayload<"permission.resolved">;
      correlation: EventCorrelation;
    };

let project: ToolTestProject;
let events: HarnessEvent[];
let broker: PermissionBroker;
let runner: ToolRunner;
let column: PolicyColumn;
let nextCall = 0;

beforeEach(async () => {
  project = await openToolTestProject({
    withTurn: true,
    seed: ({ root }) => {
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, "notes.md"), "hello\n");
      writeFileSync(
        path.join(root, "long.txt"),
        `${Array.from({ length: 2000 }, () => "x".repeat(100)).join("\n")}\n`,
      );
    },
  });

  events = [];
  nextCall = 0;
  column = "balanced";
  broker = new PermissionBroker({
    db: project.storage.db,
    emit: record,
    column: () => column,
  });
  runner = makeRunner();
});

/** Records everything, whichever channel emits. */
function record<T extends HarnessEvent["type"]>(
  type: T,
  payload: EventPayload<T>,
  correlation: EventCorrelation,
): void {
  events.push({ type, payload, correlation } as unknown as HarnessEvent);
}

/** A runner with the real registry, or a custom one for fault-injected tools. */
function makeRunner(tools?: readonly AnyTool[]): ToolRunner {
  return new ToolRunner({
    registry: tools === undefined ? new ToolRegistry() : new ToolRegistry(tools),
    broker,
    db: project.storage.db,
    emit: record,
    log: nullLogger,
    mask: (value) => value,
  });
}

/** One model tool call through the runner, with its own call ID and a live signal. */
function drive(
  name: string,
  input: unknown,
  options: { callId?: string } = {},
): Promise<{ result: ToolResult; decision: string }> {
  nextCall += 1;
  return runner.run(
    {
      callId: options.callId ?? `call_${nextCall}`,
      name,
      argumentsJson: JSON.stringify(input),
    },
    project.ctx,
    new AbortController().signal,
  );
}

function setColumn(value: PolicyColumn): void {
  column = value;
}

/** The approval card event, failing the test when there is none. */
function requestedEvent(): EventPayload<"permission.requested"> {
  const event = events.find((candidate) => candidate.type === "permission.requested");
  if (event?.type !== "permission.requested") throw new Error("no permission.requested event");
  return event.payload as EventPayload<"permission.requested">;
}

type CallRow = {
  decision: string;
  ok: number | null;
  permission_id: string | null;
};

function callRow(callId: string): CallRow | undefined {
  return project.storage.db.get<CallRow>(
    "SELECT decision, ok, permission_id FROM tool_calls WHERE id = ?",
    [callId],
  );
}

/** The failing half of a result, throwing when the call succeeded. */
function errorOf(result: ToolResult): ToolResult & { ok: false } {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unexpected success");
  return result;
}

/** A tool whose classify passes but whose execute always throws. */
const boomTool = {
  name: "kaboom_tool",
  description: "Throws as soon as it runs.",
  input: z.object({}),
  timeoutMs: 10_000,
  activity: "reading" as const,
  classify: async () => ({ classes: [] }),
  async execute(): Promise<ToolResult> {
    throw new Error("a fault inside the tool");
  },
  summarize: () => "kaboom_tool runs",
};

/** A tool that never resolves and never honours cancellation. */
const sleeperTool = {
  name: "never_stops_tool",
  description: "Ignores cancellation for good.",
  input: z.object({}),
  timeoutMs: 10_000,
  activity: "reading" as const,
  classify: async () => ({ classes: [] }),
  execute: () => new Promise<ToolResult>(() => undefined),
  summarize: () => "never_stops_tool",
};

/** A tool that waits far beyond its own timeout. */
const slowpokeTool = {
  name: "slowpoke_tool",
  description: "Snoozes into its timeout.",
  input: z.object({}),
  timeoutMs: 50,
  activity: "reading" as const,
  classify: async () => ({ classes: [] }),
  execute: () => new Promise<ToolResult>(() => undefined),
  summarize: () => "slowpoke_tool",
};

describe("ToolRunner", () => {
  it("refuses an unknown tool, listing the names that exist", async () => {
    const outcome = await drive("teleport", {});

    expect(outcome.result.ok).toBe(false);
    expect(errorOf(outcome.result).error.code).toBe("invalid_input");
    expect(outcome.result.modelText).toContain("There is no tool named teleport");
    expect(outcome.result.modelText).toContain("read_file");
    expect(outcome.decision).toBe("invalid");
    expect(events.map((event) => event.type)).toEqual(["tool.started", "tool.completed"]);
    const completed = events[events.length - 1];
    if (completed?.type !== "tool.completed") throw new Error("no tool.completed event");
    expect(completed.payload).toMatchObject({ tool: "teleport", ok: false });
    expect(callRow("call_1")?.decision).toBe("invalid");
  });

  it("refuses malformed JSON arguments", async () => {
    const outcome = await runner.run(
      { callId: "call_1", name: "read_file", argumentsJson: '{"path": nope' },
      project.ctx,
      new AbortController().signal,
    );

    expect(outcome.result.ok).toBe(false);
    expect(errorOf(outcome.result).error.code).toBe("invalid_input");
    expect(outcome.result.modelText).toContain("not valid JSON");
    expect(outcome.decision).toBe("invalid");
  });

  it("refuses arguments that fail the tool's schema", async () => {
    const outcome = await drive("read_file", { path: 42 });

    expect(outcome.result.ok).toBe(false);
    expect(errorOf(outcome.result).error.code).toBe("invalid_input");
    expect(outcome.result.modelText).toContain("Invalid arguments");
    expect(callRow("call_1")?.decision).toBe("invalid");
  });

  it("runs an allowed read and records the call", async () => {
    const outcome = await drive("read_file", { path: "notes.md" });

    expect(outcome.result.ok).toBe(true);
    expect(outcome.decision).toBe("allow");
    expect(events.map((event) => event.type)).toEqual(["tool.started", "tool.completed"]);
    const started = events[0];
    if (started?.type !== "tool.started") throw new Error("no tool.started event");
    expect(started.payload).toMatchObject({ tool: "read_file", risk: ["read"] });
    const completed = events[events.length - 1];
    if (completed?.type !== "tool.completed") throw new Error("no tool.completed event");
    expect(completed.payload).toMatchObject({ tool: "read_file", ok: true });
    expect(callRow("call_1")).toMatchObject({ decision: "allow", ok: 1 });
  });

  it("never runs a read the policy marks prohibited", async () => {
    mkdirSync(path.join(project.root, "internal"), { recursive: true });
    project.write("internal/keys.txt", "kept from the model\n");
    project.ctx.prohibited = {
      appDirs: [realpathSync.native(path.join(project.root, "internal"))],
      home: undefined,
    };

    const outcome = await drive("read_file", { path: "internal/keys.txt" });
    const error = errorOf(outcome.result);

    expect(error.modelText.startsWith("Blocked:")).toBe(true);
    expect(outcome.decision).toBe("prohibited");
    // The tool never ran: nothing was read and no card was offered.
    expect(project.ctx.reads.get("internal/keys.txt")).toBeUndefined();
    expect(events.some((event) => event.type === "permission.requested")).toBe(false);
    expect(callRow("call_1")?.decision).toBe("prohibited");
  });

  it("denies a path outside the project by policy", async () => {
    const outcome = await drive("write_file", { path: "../x.md", content: "not in the project\n" });
    const error = errorOf(outcome.result);

    expect(error.error.code).toBe("permission_denied");
    expect(error.modelText).toContain("outside the project");
    expect(outcome.decision).toBe("deny");
    expect(existsSync(path.join(project.base, "x.md"))).toBe(false);
    expect(callRow("call_1")?.decision).toBe("deny");
  });

  it("asks under cautious, and a denial with a message reaches the model", async () => {
    setColumn("cautious");
    const pending = drive("write_file", { path: "denied.md", content: "anything\n" });

    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "permission.requested")).toBe(true),
    );
    const requested = requestedEvent();
    broker.respond(requested.permissionId, "deny", "use a different name");
    const outcome = await pending;
    const error = errorOf(outcome.result);

    expect(outcome.decision).toBe("ask_denied");
    expect(error.modelText).toContain("use a different name");
    expect(existsSync(path.join(project.root, "denied.md"))).toBe(false);
    expect(callRow("call_1")).toMatchObject({ decision: "ask_denied", ok: 0 });
  });

  it("writes after allow_once and links the call to the permission", async () => {
    setColumn("cautious");
    const pending = drive("write_file", { path: "allowed.md", content: "fine on once\n" });

    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "permission.requested")).toBe(true),
    );
    const requested = requestedEvent();
    broker.respond(requested.permissionId, "allow_once");
    const outcome = await pending;

    expect(outcome.decision).toBe("ask_allowed");
    expect(outcome.result.ok).toBe(true);
    expect(project.readBytes("allowed.md").toString()).toBe("fine on once\n");
    expect(callRow("call_1")).toMatchObject({ decision: "ask_allowed", ok: 1 });
    expect(callRow("call_1")?.permission_id).toBe(requested.permissionId);
  });

  it("truncates long model text and says so", async () => {
    const outcome = await drive("read_file", { path: "long.txt", limit: 2000 });

    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.modelText).toContain("[Output truncated:");
    expect(Buffer.byteLength(outcome.result.modelText)).toBeLessThanOrEqual(
      MAX_MODEL_TEXT_BYTES + 300,
    );
  });

  it("turns a thrown error into internal", async () => {
    const outcome = await makeRunner([boomTool] as unknown as readonly AnyTool[]).run(
      { callId: "call_9", name: "kaboom_tool", argumentsJson: "{}" },
      project.ctx,
      new AbortController().signal,
    );

    expect(outcome.result.ok).toBe(false);
    expect(errorOf(outcome.result).error.code).toBe("internal");
    expect(outcome.result.modelText).toContain("internal");
  });

  it("forces a tool that ignores cancellation to stop within the grace", async () => {
    const controller = new AbortController();
    const pending = makeRunner([sleeperTool] as unknown as readonly AnyTool[]).run(
      { callId: "call_7", name: "never_stops_tool", argumentsJson: "{}" },
      project.ctx,
      controller.signal,
    );
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 30);

    const error = errorOf((await pending).result);
    expect(error.error.code).toBe("cancelled");
    expect(Date.now() - startedAt).toBeLessThan(CANCEL_GRACE_MS + 500);
  });

  it("stops a tool past its timeout", async () => {
    const outcome = await makeRunner([slowpokeTool] as unknown as readonly AnyTool[]).run(
      { callId: "call_8", name: "slowpoke_tool", argumentsJson: "{}" },
      project.ctx,
      new AbortController().signal,
    );

    expect(errorOf(outcome.result).error.code).toBe("timeout");
  });
});

describe("truncateResult", () => {
  it("leaves short text alone", () => {
    const short: ToolResult = { ok: true, modelText: "plain text" };
    expect(truncateResult(short)).toBe(short);
  });

  it("cuts and marks long text", () => {
    const long: ToolResult = { ok: true, modelText: "y".repeat(MAX_MODEL_TEXT_BYTES * 3) };
    const truncated = truncateResult(long);
    expect(truncated.ok).toBe(true);
    expect(truncated.modelText).toContain("[Output truncated:");
    expect(Buffer.byteLength(truncated.modelText)).toBeLessThanOrEqual(MAX_MODEL_TEXT_BYTES + 300);
  });
});
