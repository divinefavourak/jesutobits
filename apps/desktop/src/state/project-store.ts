import {
  JesutobitsError,
  type MethodResult,
  type Project,
  type RuntimeStatus,
  type RuntimeStatusUpdate,
} from "@jesutobits/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { HostBridge } from "../host-bridge";

export type ProjectDetection = MethodResult<"projects.detect">;
export type ProjectTemplate = "empty" | "general";

export interface ProjectState {
  runtime: RuntimeStatusUpdate;
  /** Recent projects, most recent first; null until the first list arrives. */
  recent: Project[] | null;
  /** The open project (one per window, FR-012); null on the start screen. */
  active: Project | null;
  /** The trust prompt is open for the active project (FR-006). */
  needsTrustDecision: boolean;
  /** What kind of project the active one is (J-05); null while detecting or on failure. */
  detection: ProjectDetection | null;
  /**
   * Counts every time the active project is opened, including the reopen after a runtime
   * restart. Views that show project data (explorer, editors) reload when it changes.
   */
  generation: number;
  /** An action is running; buttons that start another one are disabled. */
  busy: boolean;
  /** Why the last action failed, from the runtime's error; cleared by the next action. */
  error: { action: ProjectAction; message: string } | null;

  refreshRecent(): Promise<void>;
  openFolder(path: string): Promise<void>;
  openRecent(id: string): Promise<void>;
  create(params: { parentDir: string; name: string; template: ProjectTemplate }): Promise<void>;
  close(): Promise<void>;
  setTrust(trust: "trusted" | "restricted"): Promise<void>;
  /** Closes the trust prompt without deciding; it is asked again next time (trust stays `unknown`). */
  deferTrust(): void;
  remove(id: string): Promise<void>;
  locate(id: string, path: string): Promise<void>;
  dismissError(): void;
}

export type ProjectAction = "open" | "create" | "close" | "trust" | "remove" | "locate" | "list";

export type ProjectStore = StoreApi<ProjectState>;

/**
 * Recent projects and the active project, backed by `projects.*` (J-05). Every state here
 * comes from a runtime reply or a Host status update (invariant 6).
 */
export function createProjectStore(bridge: HostBridge): ProjectStore {
  let everReady = false;

  const store = createStore<ProjectState>()((set, get) => {
    /** Runs one action: marks busy, records a failure as `error`, never throws. */
    const run = async (action: ProjectAction, work: () => Promise<void>): Promise<void> => {
      set({ busy: true, error: null });
      try {
        await work();
      } catch (error) {
        set({ error: { action, message: errorMessage(error) } });
      } finally {
        set({ busy: false });
      }
    };

    const listRecent = async () => {
      const { projects } = await bridge.rpc("projects.list", {});
      set({ recent: projects });
    };

    const activate = (project: Project, needsTrustDecision: boolean) => {
      set((state) => ({
        active: project,
        needsTrustDecision,
        detection: null,
        generation: state.generation + 1,
      }));
      void bridge.rpc("projects.detect", {}).then(
        (detection) => {
          if (get().active?.id === project.id) set({ detection });
        },
        // Detection is informational; the project works without it.
        (error: unknown) => bridge.log("warn", `projects.detect failed: ${errorMessage(error)}`),
      );
    };

    return {
      runtime: { status: "starting" },
      recent: null,
      active: null,
      needsTrustDecision: false,
      detection: null,
      generation: 0,
      busy: false,
      error: null,

      refreshRecent: () => run("list", listRecent),

      openFolder: (path) =>
        run("open", async () => {
          const { project, needsTrustDecision } = await bridge.rpc("projects.open", { path });
          activate(project, needsTrustDecision);
        }),

      openRecent: (id) =>
        run("open", async () => {
          try {
            const { project, needsTrustDecision } = await bridge.rpc("projects.open", { id });
            activate(project, needsTrustDecision);
          } finally {
            // A folder found missing is marked in the list (FR-004).
            await listRecent().catch(() => undefined);
          }
        }),

      create: (params) =>
        run("create", async () => {
          const { project } = await bridge.rpc("projects.create", params);
          activate(project, false);
        }),

      close: () =>
        run("close", async () => {
          await bridge.rpc("projects.close", {});
          set({ active: null, needsTrustDecision: false, detection: null });
          await listRecent();
        }),

      setTrust: (trust) =>
        run("trust", async () => {
          const active = get().active;
          if (!active) return;
          const { project } = await bridge.rpc("projects.setTrust", { id: active.id, trust });
          set({ active: project, needsTrustDecision: false });
        }),

      deferTrust: () => set({ needsTrustDecision: false }),

      remove: (id) =>
        run("remove", async () => {
          await bridge.rpc("projects.remove", { id });
          await listRecent();
        }),

      locate: (id, path) =>
        run("locate", async () => {
          await bridge.rpc("projects.locate", { id, path });
          await listRecent();
        }),

      dismissError: () => set({ error: null }),
    };
  });

  bridge.onRuntimeStatus((update) => {
    const previous = store.getState().runtime.status;
    store.setState({ runtime: update });
    if (update.status !== "ready") return;
    if (!everReady) {
      everReady = true;
      void store.getState().refreshRecent();
    } else if (wasRestart(previous)) {
      void reopenAfterRestart(bridge, store);
    }
  });

  return store;
}

/** A new runtime process: ready again after a crash restart or a manual restart. */
function wasRestart(previous: RuntimeStatus): boolean {
  return previous === "restarting" || previous === "failed" || previous === "starting";
}

/**
 * A restarted runtime has no active project, so `fs.*` would fail with `fs.no_project`
 * (ROADMAP Phase 1 decision, 2026-10-21). Open the same project again by ID; views reload
 * through `generation`.
 */
async function reopenAfterRestart(bridge: HostBridge, store: ProjectStore): Promise<void> {
  const active = store.getState().active;
  if (!active) {
    await store.getState().refreshRecent();
    return;
  }
  bridge.log("info", `reopening ${active.id} after a runtime restart`);
  await store.getState().openRecent(active.id);
  if (store.getState().error?.action === "open") {
    // The folder went away while the runtime was down: back to the start screen.
    store.setState({ active: null, needsTrustDecision: false, detection: null });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof JesutobitsError || error instanceof Error ? error.message : String(error);
}
