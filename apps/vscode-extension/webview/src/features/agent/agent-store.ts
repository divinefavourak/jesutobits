import {
  JesutobitsError,
  sessionUpdatedEvent,
  type MethodResult,
  type ModelInfo,
  type PermissionDecision,
  type RuntimeEventBase,
  type Session,
  type TurnMode,
} from "@jesutobits/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { HostBridge } from "../../host-bridge";
import type { ProjectStore } from "../../state/project-store";
import {
  applyEvent,
  applyEvents,
  EMPTY_TIMELINE,
  liveTurn,
  type SessionTimeline,
} from "./timeline-reducer";

export type RevertOutcome = MethodResult<"checkpoints.revertTurn">;

export interface AgentState {
  /** The active project's sessions, newest first; null until loaded. */
  sessions: Session[] | null;
  activeSessionId: string | null;
  timeline: SessionTimeline;
  /** The session's stored history is loading. */
  loadingHistory: boolean;
  mode: TurnMode;
  /** The provider's models; null until loaded. */
  models: ModelInfo[] | null;
  modelsError: string | null;
  /** A provider key is stored; null until checked. */
  hasKey: boolean | null;
  /** A request (send, cancel, answer) is on its way. */
  busy: boolean;
  /** The last action's failure, in words, shown where the user acted. */
  error: string | null;

  refreshSessions(): Promise<void>;
  selectSession(id: string | null): Promise<void>;
  newSession(): Promise<void>;
  send(text: string): Promise<boolean>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  retry(turnId: string): Promise<void>;
  answer(questionId: string, answer: string): Promise<void>;
  respond(permissionId: string, decision: PermissionDecision, message?: string): Promise<void>;
  revertTurn(turnId: string, force?: string[]): Promise<RevertOutcome | null>;
  rename(id: string, title: string): Promise<void>;
  archive(id: string, archived: boolean): Promise<void>;
  remove(id: string): Promise<void>;
  setMode(mode: TurnMode): void;
  setModel(modelId: string): Promise<void>;
  loadModels(refresh?: boolean): Promise<void>;
  checkKey(): Promise<void>;
  dismissError(): void;
}

export type AgentStore = StoreApi<AgentState>;

/** `ui-state.json` key: the active session per project (FR-008). */
const UI_KEY = "agentSessions";
export const OPENROUTER_REF = "provider:openrouter:default";

/**
 * The agent panel's state (UX_AND_INTERFACE.md section 6). The timeline is folded from
 * runtime events only; while a session's stored history loads, live events wait and are
 * applied after it, skipping any the history already held.
 */
export function createAgentStore(bridge: HostBridge, projects: ProjectStore): AgentStore {
  let pending: RuntimeEventBase[] | null = null;
  let loadGeneration = 0;

  const store = createStore<AgentState>()((set, get) => {
    const run = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
      set({ busy: true, error: null });
      try {
        return await work();
      } catch (error) {
        set({ error: message(error) });
        return undefined;
      } finally {
        set({ busy: false });
      }
    };

    const rememberSession = async (sessionId: string | null) => {
      const project = projects.getState().active;
      if (!project) return;
      try {
        const state = await bridge.uiState.get();
        const current = (state[UI_KEY] as Record<string, string> | undefined) ?? {};
        const next = { ...current };
        if (sessionId) next[project.id] = sessionId;
        else delete next[project.id];
        await bridge.uiState.update({ [UI_KEY]: next });
      } catch {
        // Convenience only.
      }
    };

    const loadHistory = async (sessionId: string) => {
      const generation = ++loadGeneration;
      pending = [];
      set({ loadingHistory: true, timeline: EMPTY_TIMELINE });
      const seen = new Set<string>();
      let timeline = EMPTY_TIMELINE;
      try {
        let after: number | undefined;
        for (;;) {
          const page = await bridge.rpc("sessions.history", {
            id: sessionId,
            ...(after !== undefined && { after }),
          });
          if (generation !== loadGeneration) return;
          for (const event of page.events) seen.add(`${event.seq}|${event.ts}|${event.type}`);
          timeline = applyEvents(timeline, page.events);
          if (page.next === null) break;
          after = page.next;
        }
      } catch (error) {
        set({ error: message(error) });
      }
      if (generation !== loadGeneration) return;
      const live = (pending ?? []).filter(
        (event) => !seen.has(`${event.seq}|${event.ts}|${event.type}`),
      );
      pending = null;
      set({ timeline: applyEvents(timeline, live), loadingHistory: false });
    };

    return {
      sessions: null,
      activeSessionId: null,
      timeline: EMPTY_TIMELINE,
      loadingHistory: false,
      mode: "agent",
      models: null,
      modelsError: null,
      hasKey: null,
      busy: false,
      error: null,

      refreshSessions: async () => {
        await run(async () => {
          const { sessions } = await bridge.rpc("sessions.list", {});
          set({ sessions });
        });
      },

      selectSession: async (id) => {
        set({ activeSessionId: id, timeline: EMPTY_TIMELINE, error: null });
        void rememberSession(id);
        if (id) await loadHistory(id);
      },

      newSession: async () => {
        const session = await run(async () => (await bridge.rpc("sessions.create", {})).session);
        if (!session) return;
        set((state) => ({ sessions: [session, ...(state.sessions ?? [])] }));
        await get().selectSession(session.id);
      },

      send: async (text) => {
        const trimmed = text.trim();
        if (trimmed === "") return false;
        if (!get().activeSessionId) await get().newSession();
        const sessionId = get().activeSessionId;
        if (!sessionId) return false;
        const result = await run(() =>
          bridge.rpc("agent.sendMessage", {
            sessionId: sessionId,
            text: trimmed,
            mode: get().mode,
          }),
        );
        return result !== undefined;
      },

      stop: async () => {
        const turn = liveTurn(get().timeline);
        if (turn) await run(() => bridge.rpc("agent.cancelTurn", { turnId: turn.turnId }));
      },

      pause: async () => {
        const turn = liveTurn(get().timeline);
        if (turn) await run(() => bridge.rpc("agent.pauseTurn", { turnId: turn.turnId }));
      },

      resume: async () => {
        const turn = liveTurn(get().timeline);
        if (turn) await run(() => bridge.rpc("agent.resumeTurn", { turnId: turn.turnId }));
      },

      retry: async (turnId) => {
        await run(() => bridge.rpc("agent.retryTurn", { turnId: turnId }));
      },

      answer: async (questionId, answer) => {
        await run(() => bridge.rpc("agent.answerQuestion", { questionId: questionId, answer }));
      },

      respond: async (permissionId, decision, text) => {
        await run(() =>
          bridge.rpc("permissions.respond", {
            permissionId: permissionId,
            decision,
            ...(text !== undefined && text.trim() !== "" && { message: text.trim() }),
          }),
        );
      },

      revertTurn: async (turnId, force = []) =>
        (await run(() => bridge.rpc("checkpoints.revertTurn", { turnId: turnId, force }))) ?? null,

      rename: async (id, title) => {
        await run(() => bridge.rpc("sessions.rename", { id: id, title }));
      },

      archive: async (id, archived) => {
        await run(() => bridge.rpc("sessions.archive", { id: id, archived }));
        if (archived && get().activeSessionId === id) await get().selectSession(null);
        await get().refreshSessions();
      },

      remove: async (id) => {
        const done = await run(() => bridge.rpc("sessions.delete", { id: id }));
        if (done === undefined) return;
        if (get().activeSessionId === id) await get().selectSession(null);
        set((state) => ({
          sessions: (state.sessions ?? []).filter((session) => session.id !== id),
        }));
      },

      setMode: (mode) => set({ mode }),

      setModel: async (modelId) => {
        const sessionId = get().activeSessionId;
        await run(async () => {
          await bridge.settings.update({ providers: { openrouter: { defaultModel: modelId } } });
          if (sessionId) await bridge.rpc("agent.setModel", { sessionId: sessionId, modelId });
        });
      },

      loadModels: async (refresh = false) => {
        try {
          const { models } = await bridge.rpc("models.list", { refresh });
          set({ models, modelsError: null });
        } catch (error) {
          set({ modelsError: message(error) });
        }
      },

      checkKey: async () => {
        try {
          set({ hasKey: await bridge.secrets.exists(OPENROUTER_REF) });
        } catch {
          set({ hasKey: false });
        }
      },

      dismissError: () => set({ error: null }),
    };
  });

  bridge.onRuntimeEvent((event) => {
    if (event.type === sessionUpdatedEvent.type) {
      const parsed = sessionUpdatedEvent.payload.safeParse(event);
      if (!parsed.success) return;
      const updated = parsed.data.session;
      store.setState((state) => {
        if (!state.sessions || updated.projectId !== projects.getState().active?.id) return state;
        const others = state.sessions.filter((session) => session.id !== updated.id);
        const sessions = updated.archived ? others : [updated, ...others];
        sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return { sessions };
      });
      return;
    }
    if (!event.sessionId || event.sessionId !== store.getState().activeSessionId) return;
    if (pending) {
      pending.push(event);
      return;
    }
    store.setState((state) => ({ timeline: applyEvent(state.timeline, event) }));
  });

  // A project opened (or reopened after a restart): its sessions, and its last session.
  let lastGeneration = -1;
  projects.subscribe((state) => {
    if (state.generation === lastGeneration) return;
    lastGeneration = state.generation;
    const project = state.active;
    store.setState({ sessions: null, activeSessionId: null, timeline: EMPTY_TIMELINE });
    if (!project) return;
    void (async () => {
      await store.getState().refreshSessions();
      let remembered: string | undefined;
      try {
        const ui = await bridge.uiState.get();
        remembered = (ui[UI_KEY] as Record<string, string> | undefined)?.[project.id];
      } catch {
        // Start without a session.
      }
      const sessions = store.getState().sessions ?? [];
      const choice = sessions.find((session) => session.id === remembered) ?? sessions[0];
      if (choice && projects.getState().active?.id === project.id) {
        await store.getState().selectSession(choice.id);
      }
    })();
  });

  return store;
}

function message(error: unknown): string {
  return error instanceof JesutobitsError || error instanceof Error ? error.message : String(error);
}
