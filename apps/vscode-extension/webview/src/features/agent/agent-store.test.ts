import {
  ErrorCodes,
  JesutobitsError,
  type Project,
  type RuntimeEventBase,
  type Session,
} from "@jesutobits/protocol";
import { describe, expect, it, vi } from "vitest";
import { MockHostBridge } from "../../host-bridge";
import { createWorkbench, type Workbench } from "../../state/workbench-context";
import { OPENROUTER_REF } from "./agent-store";
import {
  at,
  modelTextDelta,
  OTHER_TURN_ID,
  PERMISSION_ID,
  QUESTION_ID,
  runtimeWarning,
  SESSION_ID,
  sessionUpdated,
  TURN_ID,
  turnCancelled,
  turnCompleted,
  turnStarted,
  turnStateChanged,
} from "./test-events";

const PROJECT: Project = {
  id: "prj_01JABCDEFGHJKMNPQRSTVWXYZ0",
  path: "c:\\work\\habits",
  name: "habits",
  kind: "project",
  trust: "trusted",
  createdByJesutobits: false,
  lastOpenedAt: "2026-10-20T10:00:00.000Z",
  missing: false,
};

const SESSION_A = SESSION_ID;
const SESSION_B = "ses_01JAB2C3D4E5F6G7H8J9K0M1N9";
const SESSION_C = "ses_01JAB2C3D4E5F6G7H8J9K0M1N7";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_A,
    projectId: PROJECT.id,
    title: "First session",
    providerId: "openrouter",
    modelId: "openai/gpt-5",
    createdAt: at(0),
    updatedAt: at(10),
    archived: false,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

interface HistoryPage {
  events: RuntimeEventBase[];
  next: number | null;
}

interface SetupOptions {
  sessions?: Session[];
  /** The session stored under `agentSessions` for this project. */
  remembered?: string;
  pages?: HistoryPage[];
  /** Holds every history page until it resolves, so a test can inject live events. */
  gate?: Promise<void>;
}

type Call = { method: string; params: unknown };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function setup(options: SetupOptions = {}) {
  const bridge = new MockHostBridge();
  const calls: Call[] = [];
  const record = (method: string, params: unknown) => calls.push({ method, params });

  if (options.remembered) {
    await bridge.uiState.update({ agentSessions: { [PROJECT.id]: options.remembered } });
  }

  let sessions = options.sessions ?? [session()];
  let pageIndex = 0;
  const pages = options.pages ?? [{ events: [], next: null }];

  bridge.handle("sessions.list", (params) => {
    record("sessions.list", params);
    return { sessions };
  });
  bridge.handle("sessions.history", async (params) => {
    record("sessions.history", params);
    const page = pages[pageIndex] ?? { events: [], next: null };
    pageIndex += 1;
    if (options.gate) await options.gate;
    return page;
  });
  bridge.handle("sessions.create", (params) => {
    record("sessions.create", params);
    const created = session({ id: SESSION_C, title: "New session", updatedAt: at(30) });
    sessions = [created, ...sessions];
    return { session: created };
  });

  bridge.handle("agent.sendMessage", (params) => {
    record("agent.sendMessage", params);
    return { turnId: TURN_ID };
  });
  bridge.handle("agent.cancelTurn", (params) => {
    record("agent.cancelTurn", params);
    return {};
  });
  bridge.handle("agent.retryTurn", (params) => {
    record("agent.retryTurn", params);
    return { turnId: OTHER_TURN_ID };
  });
  bridge.handle("agent.answerQuestion", (params) => {
    record("agent.answerQuestion", params);
    return {};
  });
  bridge.handle("permissions.respond", (params) => {
    record("permissions.respond", params);
    return {};
  });
  bridge.handle("checkpoints.revertTurn", (params) => {
    record("checkpoints.revertTurn", params);
    return (params.force?.length ?? 0) > 0
      ? { restored: ["src/a.ts", "src/b.ts"], conflicts: [] }
      : { restored: ["src/a.ts"], conflicts: ["src/b.ts"] };
  });
  bridge.handle("models.list", () => ({ models: [], fetchedAt: null }));

  const workbench = createWorkbench(bridge);
  return { bridge, workbench, calls };
}

/** The extension reports VS Code's folder as the active project; the panel never opens one. */
function openProject(bridge: MockHostBridge): void {
  bridge.openProject(PROJECT);
}

const agentState = (workbench: Workbench) => workbench.agent.getState();

describe("agent store", () => {
  it("loads the most recent session's history page by page and folds it", async () => {
    const pages: HistoryPage[] = [
      {
        events: [turnStarted({ seq: 1, text: "Add a date picker" })],
        next: 5,
      },
      {
        events: [
          modelTextDelta({ seq: 5, ts: at(5), step: 0, text: "Done" }),
          turnCompleted({ seq: 6, ts: at(6) }),
        ],
        next: null,
      },
    ];
    const { bridge, workbench, calls } = await setup({
      sessions: [
        session({ id: SESSION_A, title: "Newest", updatedAt: at(20) }),
        session({ id: SESSION_B, title: "Older", updatedAt: at(10) }),
      ],
      pages,
    });

    openProject(bridge);
    await vi.waitFor(() => {
      expect(agentState(workbench).loadingHistory).toBe(false);
      expect(agentState(workbench).timeline.turns).toHaveLength(1);
    });

    expect(agentState(workbench).activeSessionId).toBe(SESSION_A);
    const turn = agentState(workbench).timeline.turns[0];
    expect(turn?.userText).toBe("Add a date picker");
    expect(turn?.state).toBe("completed");

    const historyCalls = calls.filter((call) => call.method === "sessions.history");
    expect(historyCalls).toHaveLength(2);
    expect(historyCalls[0]?.params).toMatchObject({ id: SESSION_A });
    expect(historyCalls[1]?.params).toMatchObject({ id: SESSION_A, after: 5 });
  });

  it("selects the session remembered in ui-state instead of the most recent one", async () => {
    const { bridge, workbench } = await setup({
      sessions: [
        session({ id: SESSION_A, title: "Newest", updatedAt: at(20) }),
        session({ id: SESSION_B, title: "Remembered", updatedAt: at(10) }),
      ],
      remembered: SESSION_B,
      pages: [{ events: [turnStarted({ seq: 1, text: "From the older session" })], next: null }],
    });

    openProject(bridge);
    await vi.waitFor(() => {
      expect(agentState(workbench).activeSessionId).toBe(SESSION_B);
      expect(agentState(workbench).timeline.turns).toHaveLength(1);
    });

    expect(agentState(workbench).timeline.turns[0]?.userText).toBe("From the older session");
  });

  it("applies live events for the active session only", async () => {
    const { bridge, workbench } = await setup({
      pages: [{ events: [turnStarted({ seq: 1, text: "Hello" })], next: null }],
    });

    openProject(bridge);
    await vi.waitFor(() => expect(agentState(workbench).timeline.turns).toHaveLength(1));

    bridge.emitEvent(turnStateChanged({ seq: 2, ts: at(2), to: "thinking" }));
    expect(agentState(workbench).timeline.turns[0]?.state).toBe("thinking");

    bridge.emitEvent(turnStateChanged({ seq: 3, ts: at(3), to: "failed", sessionId: SESSION_B }));
    expect(agentState(workbench).timeline.turns[0]?.state).toBe("thinking");

    bridge.emitEvent(turnStateChanged({ seq: 4, ts: at(4), to: "responding", sessionId: null }));
    expect(agentState(workbench).timeline.turns[0]?.state).toBe("thinking");
  });

  it("holds live events while history loads, applies them after it and skips ones it already had", async () => {
    const gate = deferred();
    const pages: HistoryPage[] = [
      {
        events: [
          turnStarted({ seq: 1, text: "Hello" }),
          modelTextDelta({ seq: 2, ts: at(2), step: 0, text: "From history" }),
        ],
        next: 3,
      },
      {
        events: [runtimeWarning({ seq: 3, ts: at(3), message: "Careful" })],
        next: null,
      },
    ];
    const { bridge, workbench, calls } = await setup({ pages, gate: gate.promise });

    openProject(bridge);
    await vi.waitFor(() =>
      expect(calls.some((call) => call.method === "sessions.history")).toBe(true),
    );

    // One event the history already holds (same seq, ts and type), one it does not.
    bridge.emitEvent(runtimeWarning({ seq: 3, ts: at(3), message: "Careful" }));
    bridge.emitEvent(modelTextDelta({ seq: 4, ts: at(4), step: 0, text: " live" }));
    expect(agentState(workbench).timeline.turns).toHaveLength(0);

    gate.resolve();
    await vi.waitFor(() => {
      expect(agentState(workbench).loadingHistory).toBe(false);
      expect(agentState(workbench).timeline.turns).toHaveLength(1);
    });

    const turn = agentState(workbench).timeline.turns[0];
    const messages = (turn?.items ?? []).filter((item) => item.kind === "message");
    const warnings = (turn?.items ?? []).filter((item) => item.kind === "warning");
    expect(messages[0]).toMatchObject({ text: "From history live" });
    expect(warnings).toHaveLength(1);
  });

  it("creates a session before sending when none is active, and sends with the mode", async () => {
    const { bridge, workbench, calls } = await setup({ sessions: [] });

    openProject(bridge);
    await vi.waitFor(() => expect(agentState(workbench).sessions).toEqual([]));
    expect(agentState(workbench).activeSessionId).toBeNull();

    agentState(workbench).setMode("ask");
    const sent = await agentState(workbench).send("  Change the title  ");

    expect(sent).toBe(true);
    const methods = calls.map((call) => call.method);
    expect(methods).toContain("sessions.create");
    expect(methods.indexOf("sessions.create")).toBeLessThan(methods.indexOf("agent.sendMessage"));
    expect(calls.find((call) => call.method === "agent.sendMessage")?.params).toEqual({
      sessionId: SESSION_C,
      text: "Change the title",
      mode: "ask",
    });
  });

  it("sends nothing for empty text", async () => {
    const { workbench, calls } = await setup();

    expect(await agentState(workbench).send("   ")).toBe(false);
    expect(calls.map((call) => call.method)).not.toContain("sessions.create");
    expect(calls.map((call) => call.method)).not.toContain("agent.sendMessage");
  });

  it("reports a failed send in the runtime's words", async () => {
    const { bridge, workbench } = await setup({
      pages: [{ events: [turnStarted({ seq: 1, text: "Hello" })], next: null }],
    });

    openProject(bridge);
    await vi.waitFor(() => expect(agentState(workbench).timeline.turns).toHaveLength(1));

    bridge.handle("agent.sendMessage", () => {
      throw new JesutobitsError(
        ErrorCodes.providerRateLimited,
        "OpenRouter is rate limiting requests",
      );
    });
    const sent = await agentState(workbench).send("Hello again");

    expect(sent).toBe(false);
    expect(agentState(workbench).error).toBe("OpenRouter is rate limiting requests");
    expect(agentState(workbench).busy).toBe(false);
  });

  it("stops only a live turn", async () => {
    const { bridge, workbench, calls } = await setup({
      pages: [{ events: [turnStarted({ seq: 1, text: "Hello" })], next: null }],
    });

    openProject(bridge);
    await vi.waitFor(() => expect(agentState(workbench).timeline.turns).toHaveLength(1));

    await agentState(workbench).stop();
    const cancels = () => calls.filter((call) => call.method === "agent.cancelTurn");
    expect(cancels()).toHaveLength(1);
    expect(cancels()[0]?.params).toEqual({ turnId: TURN_ID });

    bridge.emitEvent(turnCompleted({ seq: 2, ts: at(2) }));
    await agentState(workbench).stop();
    expect(cancels()).toHaveLength(1);

    bridge.emitEvent(turnCancelled({ seq: 3, ts: at(3), turnId: OTHER_TURN_ID }));
    await agentState(workbench).stop();
    expect(cancels()).toHaveLength(1);
  });

  it("passes the decision and a trimmed message, answers questions and returns the revert outcome", async () => {
    const { bridge, workbench, calls } = await setup({
      pages: [{ events: [turnStarted({ seq: 1, text: "Hello" })], next: null }],
    });

    openProject(bridge);
    await vi.waitFor(() => expect(agentState(workbench).timeline.turns).toHaveLength(1));

    await agentState(workbench).respond(PERMISSION_ID, "deny", "  Please use src/b.ts  ");
    expect(calls.find((call) => call.method === "permissions.respond")?.params).toEqual({
      permissionId: PERMISSION_ID,
      decision: "deny",
      message: "Please use src/b.ts",
    });

    await agentState(workbench).respond(PERMISSION_ID, "allow_once", "   ");
    const responses = calls.filter((call) => call.method === "permissions.respond");
    expect(responses.at(-1)?.params).toEqual({
      permissionId: PERMISSION_ID,
      decision: "allow_once",
    });

    await agentState(workbench).answer(QUESTION_ID, "SQLite");
    expect(calls.find((call) => call.method === "agent.answerQuestion")?.params).toEqual({
      questionId: QUESTION_ID,
      answer: "SQLite",
    });

    expect(await agentState(workbench).revertTurn(TURN_ID)).toEqual({
      restored: ["src/a.ts"],
      conflicts: ["src/b.ts"],
    });
    expect(calls.find((call) => call.method === "checkpoints.revertTurn")?.params).toEqual({
      turnId: TURN_ID,
      force: [],
    });

    expect(await agentState(workbench).revertTurn(TURN_ID, ["src/b.ts"])).toEqual({
      restored: ["src/a.ts", "src/b.ts"],
      conflicts: [],
    });
    const reverts = calls.filter((call) => call.method === "checkpoints.revertTurn");
    expect(reverts.at(-1)?.params).toEqual({ turnId: TURN_ID, force: ["src/b.ts"] });
  });

  it("updates and re-sorts sessions from session.updated, and drops an archived one", async () => {
    const { bridge, workbench } = await setup({
      sessions: [
        session({ id: SESSION_A, title: "First", updatedAt: at(10) }),
        session({ id: SESSION_B, title: "Second", updatedAt: at(5) }),
      ],
    });

    openProject(bridge);
    await vi.waitFor(() => expect(agentState(workbench).sessions).toHaveLength(2));

    const renamed = session({ id: SESSION_B, title: "Renamed", updatedAt: at(20) });
    bridge.emitEvent(sessionUpdated({ seq: 50, session: renamed }));

    expect(agentState(workbench).sessions?.map((item) => item.id)).toEqual([SESSION_B, SESSION_A]);
    expect(agentState(workbench).sessions?.[0]?.title).toBe("Renamed");

    bridge.emitEvent(sessionUpdated({ seq: 51, session: { ...renamed, archived: true } }));
    expect(agentState(workbench).sessions?.map((item) => item.id)).toEqual([SESSION_A]);
  });

  it("checks the OpenRouter key through the write-only secret store", async () => {
    const { bridge, workbench } = await setup();

    expect(agentState(workbench).hasKey).toBeNull();
    await agentState(workbench).checkKey();
    expect(agentState(workbench).hasKey).toBe(false);

    bridge.storeSecret(OPENROUTER_REF, "sk-or-test-not-real");
    await agentState(workbench).checkKey();
    expect(agentState(workbench).hasKey).toBe(true);
  });

  it("checks the key again when it is set outside the panel", async () => {
    const { bridge, workbench } = await setup();
    await agentState(workbench).checkKey();
    expect(agentState(workbench).hasKey).toBe(false);

    bridge.storeSecretElsewhere(OPENROUTER_REF, "sk-or-test-not-real");

    await vi.waitFor(() => expect(agentState(workbench).hasKey).toBe(true));
  });
});
