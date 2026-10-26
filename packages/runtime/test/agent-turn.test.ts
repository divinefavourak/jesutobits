// The agent loop over a real turn (AGENT_HARNESS.md section 3, journey J-06): what the user
// sees, what is stored, and that both survive a restart (FR-041, DATA_AND_PERSISTENCE.md 4).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answerStep,
  awaitTurnEnd,
  dispose,
  result,
  send,
  setupAgent,
  start,
  tempBase,
  toolStep,
  turnEvents,
  writeCassette,
} from "./agent-helpers.js";
import type { RuntimeHarness } from "./harness/runtime-harness.js";

let base: string;
let project: string;
let harness: RuntimeHarness | undefined;

beforeEach(() => {
  base = tempBase("jesutobits-agent-turn-");
  project = path.join(base, "my-app");
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "src", "a.ts"), "export const a = 1;\r\n");
  writeFileSync(path.join(project, "package.json"), '{ "name": "my-app" }\n');
});

afterEach(async () => {
  harness?.kill();
  await harness?.exited;
  harness = undefined;
  dispose(base);
});

/** The cassette of the standard turn: read the file, edit it, then answer. */
function editCassette(): string {
  return writeCassette(base, "edit-a.jsonl", [
    toolStep("c1", "read_file", JSON.stringify({ path: "src/a.ts" }), "Reading it.", {
      lastUserTextIncludes: "please change a to 2",
    }),
    toolStep(
      "c2",
      "edit_file",
      JSON.stringify({ path: "src/a.ts", edits: [{ oldText: "a = 1", newText: "a = 2" }] }),
      undefined,
      { lastToolResultIncludes: "export const a = 1" },
    ),
    answerStep("Done: a is now 2.", { lastToolResultIncludes: "Edited src/a.ts" }),
  ]);
}

describe("a scripted turn (J-06)", () => {
  it("reports the turn start at once, with a real edit and an honest summary", async () => {
    harness = start(editCassette());
    const sessionId = (await setupAgent(harness, project)).sessionId;

    const beforeSend = Date.now();
    const turnId = await send(harness, sessionId, "please change a to 2");
    const started = await harness.waitForEvent(
      (event) =>
        event.type === "turn.started" && event.sessionId === sessionId && event.turnId === turnId,
    );
    // The first timeline activity arrives at once (J-06 acceptance).
    expect(Date.now() - beforeSend).toBeLessThan(2000);
    expect((started as { message?: { text?: string } }).message?.text).toBe("please change a to 2");

    const end = await awaitTurnEnd(harness, turnId);
    expect(end.type).toBe("turn.completed");
    const summary = end.summary as
      { verification?: string; files?: Array<Record<string, unknown>> } | undefined;
    expect(summary?.verification).toBe("unverified");
    expect(summary?.files).toEqual([
      { path: "src/a.ts", change: "modified", added: 1, removed: 1 },
    ]);

    // The work is real: the file on disk changed.
    expect(readFileSync(path.join(project, "src", "a.ts"), "utf8")).toBe("export const a = 2;\r\n");
  });

  it("emits the turn's activity in the state machine's order", async () => {
    harness = start(editCassette());
    const sessionId = (await setupAgent(harness, project)).sessionId;
    const turnId = await send(harness, sessionId, "please change a to 2");
    await awaitTurnEnd(harness, turnId);

    const events = turnEvents(harness, turnId);
    const at = (match: (event: (typeof events)[number]) => boolean): number => {
      const index = events.findIndex(match);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    const to = (state: string) => (event: (typeof events)[number]) =>
      event.type === "turn.state_changed" && event.to === state;

    const turnStarted = at((event) => event.type === "turn.started");
    const understanding = at(to("understanding"));
    const thinking = at(to("thinking"));
    const firstRequest = at((event) => event.type === "model.request_started");
    const readStarted = at((event) => event.type === "tool.started" && event.tool === "read_file");
    const readDone = at((event) => event.type === "tool.completed" && event.tool === "read_file");
    const editStarted = at((event) => event.type === "tool.started" && event.tool === "edit_file");
    const editDone = at((event) => event.type === "tool.completed" && event.tool === "edit_file");
    const finalStep = events.filter((event) => event.type === "model.step_completed").at(-1);
    const finalStepAt = finalStep ? events.indexOf(finalStep) : -1;
    const completed = at((event) => event.type === "turn.completed");

    expect(understanding).toBeGreaterThanOrEqual(turnStarted);
    expect(thinking).toBeGreaterThan(understanding);
    expect(firstRequest).toBeGreaterThan(thinking);
    expect(readStarted).toBeGreaterThan(firstRequest);
    expect(readDone).toBeGreaterThan(readStarted);
    expect(editStarted).toBeGreaterThan(readDone);
    expect(editDone).toBeGreaterThan(editStarted);
    expect(finalStepAt).toBeGreaterThan(editDone);
    expect(completed).toBeGreaterThan(finalStepAt);

    // The full text of the final step reaches the Workbench, not only deltas.
    const stepText = (finalStep as { text?: string } | undefined)?.text;
    expect(stepText).toBe("Done: a is now 2.");
  });

  it("walks the state machine from understanding to completed", async () => {
    harness = start(editCassette());
    const sessionId = (await setupAgent(harness, project)).sessionId;
    const turnId = await send(harness, sessionId, "please change a to 2");
    await awaitTurnEnd(harness, turnId);

    const transitions = turnEvents(harness, turnId)
      .filter((event) => event.type === "turn.state_changed")
      .map((event) => `${(event.from as string | null) ?? "start"}->${String(event.to)}`);
    expect(transitions).toContain("understanding->thinking");
    expect(transitions).toContain("thinking->responding");
    expect(transitions).toContain("responding->tool_running");
    expect(transitions.at(-1)).toBe("responding->completed");
  });
});

describe("stored history (DATA_AND_PERSISTENCE.md section 4)", () => {
  it("keeps the live event types minus the deltas, and survives a restart (FR-041)", async () => {
    const dataDir = path.join(base, "data");
    harness = start(editCassette(), dataDir);
    const { sessionId } = await setupAgent(harness, project);
    const turnId = await send(harness, sessionId, "please change a to 2");
    await awaitTurnEnd(harness, turnId);

    const liveTypes = new Set(
      harness.events
        .filter((event) => event.sessionId === sessionId)
        .map((event) => String(event.type)),
    );
    liveTypes.delete("model.text_delta"); // deltas are never stored; steps keep their text

    const live = result<"sessions.history">(
      await harness.call("sessions.history", { id: sessionId }),
    );
    expect(new Set(live.events.map((event) => String(event.type)))).toEqual(liveTypes);

    harness.kill();
    await harness.exited;

    harness = start(editCassette(), dataDir);
    await harness.initialize();
    result<"projects.open">(await harness.call("projects.open", { path: project }));
    const sessions = result<"sessions.list">(await harness.call("sessions.list", {})).sessions;
    expect(sessions.map((session) => session.id)).toContain(sessionId);

    const history = result<"sessions.history">(
      await harness.call("sessions.history", { id: sessionId }),
    );
    const turnTail = history.events.filter((event) => event.turnId === turnId);
    expect(turnTail.at(-1)?.type).toBe("turn.completed");
    // The restart itself reported the recovered turn (FR-041 comes back to this suite).
    expect(history.events.filter((event) => event.type === "turn.interrupted")).toEqual([]);
  });
});
