import { describe, expect, it } from "vitest";
import type { SessionTimeline, TimelineItem, TurnView } from "../agent/timeline-reducer";
import { deriveCompanionState, type CompanionInputs } from "./companion-state";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function turn(overrides: Partial<TurnView> = {}): TurnView {
  return {
    turnId: "trn_1",
    mode: "agent",
    modelId: "m",
    state: "thinking",
    startedAt: ago(10_000),
    items: [],
    costUsd: 0,
    ...overrides,
  };
}

function tool(category: string, status = "running", name = "read_file"): TimelineItem {
  return {
    kind: "tool",
    callId: `c_${category}_${status}`,
    tool: name,
    category,
    summary: "",
    risk: [],
    inputPreview: {},
    status,
    startedAt: ago(100),
  } as TimelineItem;
}

function state(timeline: SessionTimeline, overrides: Partial<CompanionInputs> = {}) {
  return deriveCompanionState({
    timeline,
    runtime: "ready",
    preview: { state: "stopped", changedAt: 0 },
    now: NOW,
    ...overrides,
  });
}

describe("companion state (COMPANION_SYSTEM.md section 3)", () => {
  it("is idle with nothing happening, and never invents activity", () => {
    expect(state({ turns: [] })).toBe("idle");
    expect(state({ turns: [turn({ state: "completed", endedAt: ago(60_000) })] })).toBe("idle");
  });

  it("follows the running tool's category, with the section 3.3 priority", () => {
    expect(state({ turns: [turn({ state: "tool_running", items: [tool("reading")] })] })).toBe(
      "reading",
    );
    expect(
      state({
        turns: [turn({ state: "tool_running", items: [tool("reading"), tool("editing")] })],
      }),
    ).toBe("editing");
    expect(state({ turns: [turn({ state: "tool_running", items: [tool("installing")] })] })).toBe(
      "running",
    );
    expect(state({ turns: [turn({ items: [tool("planning", "running", "update_plan")] })] })).toBe(
      "planning",
    );
    expect(state({ turns: [turn({ items: [tool("reading", "ok")] })] })).toBe("thinking");
  });

  it("puts waiting for the user above everything", () => {
    const permission = {
      kind: "permission",
      permissionId: "p1",
      tool: "run_command",
      action: { kind: "command", argv: ["npm", "test"], cwd: ".", shell: false },
      risk: ["execute"],
      reasons: [],
      options: ["allow_once", "deny"],
      decision: null,
    } as TimelineItem;
    expect(state({ turns: [turn({ items: [tool("editing"), permission] })] })).toBe(
      "waiting_permission",
    );
    const question = {
      kind: "question",
      questionId: "q1",
      question: "Which?",
      options: [],
      source: "agent",
    } as TimelineItem;
    expect(state({ turns: [turn({ items: [question] })] })).toBe("asking");
  });

  it("shows completed, cancelled and preview ready only briefly", () => {
    expect(state({ turns: [turn({ state: "completed", endedAt: ago(1000) })] })).toBe("completed");
    expect(state({ turns: [turn({ state: "completed", endedAt: ago(5000) })] })).toBe("idle");
    expect(state({ turns: [turn({ state: "cancelled", endedAt: ago(1000) })] })).toBe("cancelled");
    expect(state({ turns: [] }, { preview: { state: "ready", changedAt: NOW - 1000 } })).toBe(
      "preview_ready",
    );
    expect(state({ turns: [] }, { preview: { state: "ready", changedAt: NOW - 3000 } })).toBe(
      "idle",
    );
  });

  it("shows errors for 20 s, and runtime trouble", () => {
    expect(state({ turns: [turn({ state: "failed", endedAt: ago(5000) })] })).toBe("error");
    expect(state({ turns: [turn({ state: "failed", endedAt: ago(25_000) })] })).toBe("idle");
    expect(state({ turns: [] }, { runtime: "failed" })).toBe("error");
    expect(state({ turns: [] }, { runtime: "restarting" })).toBe("unavailable");
    expect(state({ turns: [turn({ state: "paused" })] })).toBe("paused");
  });
});
