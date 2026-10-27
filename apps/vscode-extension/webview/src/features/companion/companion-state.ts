import type { PreviewState, RuntimeStatus } from "@jesutobits/protocol";
import { liveTurn, type SessionTimeline } from "../agent/timeline-reducer";

/** COMPANION_SYSTEM.md section 3.1. */
export type CompanionState =
  | "idle"
  | "thinking"
  | "planning"
  | "reading"
  | "editing"
  | "running"
  | "testing"
  | "waiting_permission"
  | "asking"
  | "paused"
  | "error"
  | "completed"
  | "cancelled"
  | "preview_ready"
  | "unavailable";

export type CompanionKind = "resting" | "active" | "blocking" | "sticky" | "transient";

export const COMPANION_KIND: Record<CompanionState, CompanionKind> = {
  idle: "resting",
  unavailable: "resting",
  thinking: "active",
  planning: "active",
  reading: "active",
  editing: "active",
  running: "active",
  testing: "active",
  waiting_permission: "blocking",
  asking: "blocking",
  paused: "blocking",
  error: "sticky",
  completed: "transient",
  cancelled: "transient",
  preview_ready: "transient",
};

/** How long transient and sticky states last (section 3.1), in milliseconds. */
export const EXPIRY_MS = { error: 20_000, completed: 4_000, cancelled: 2_000, previewReady: 2_500 };

export interface CompanionInputs {
  timeline: SessionTimeline;
  runtime: RuntimeStatus;
  preview: { state: PreviewState; changedAt: number };
  now: number;
}

const ACTIVE_PRIORITY = ["testing", "editing", "running", "reading", "planning"] as const;

/**
 * The companion's state from runtime facts only (invariant 6, section 3): the highest of
 * every state whose condition holds, in the order of section 3.3. Pure, so the rules are
 * tested without timers; the component re-derives when time passes an expiry.
 */
export function deriveCompanionState(input: CompanionInputs): CompanionState {
  const { timeline, runtime, preview, now } = input;
  const live = liveTurn(timeline);
  const last = timeline.turns.at(-1);
  const items = live?.items ?? [];
  const since = (iso: string | undefined) => (iso ? now - Date.parse(iso) : Infinity);

  if (items.some((item) => item.kind === "permission" && item.decision === null)) {
    return "waiting_permission";
  }
  if (items.some((item) => item.kind === "question" && item.answer === undefined)) return "asking";
  const failedRecently = !live && last?.state === "failed" && since(last.endedAt) < EXPIRY_MS.error;
  const previewCrashed = preview.state === "failed" && now - preview.changedAt < EXPIRY_MS.error;
  if (runtime === "failed" || failedRecently || previewCrashed) return "error";
  if (live?.state === "paused") return "paused";
  if (runtime === "restarting") return "unavailable";

  if (live) {
    const running = new Set<string>();
    for (const item of items) {
      if (item.kind !== "tool" || item.status !== "running") continue;
      if (item.tool === "update_plan") running.add("planning");
      else if (item.category === "testing") running.add("testing");
      else if (item.category === "editing") running.add("editing");
      else if (["running", "installing", "git", "previewing"].includes(item.category)) {
        running.add("running");
      } else if (item.category === "reading") running.add("reading");
    }
    const active = ACTIVE_PRIORITY.find((state) => running.has(state));
    if (active) return active;
    if (
      ["understanding", "thinking", "responding", "compacting", "tool_running"].includes(live.state)
    ) {
      return "thinking";
    }
  }

  if (!live && last?.state === "completed" && since(last.endedAt) < EXPIRY_MS.completed) {
    return "completed";
  }
  if (!live && last?.state === "cancelled" && since(last.endedAt) < EXPIRY_MS.cancelled) {
    return "cancelled";
  }
  if (preview.state === "ready" && now - preview.changedAt < EXPIRY_MS.previewReady) {
    return "preview_ready";
  }
  return "idle";
}
