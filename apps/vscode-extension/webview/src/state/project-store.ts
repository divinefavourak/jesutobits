import type { Project } from "@jesutobits/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { HostBridge } from "../host-bridge";

export interface ProjectState {
  /** VS Code's open folder as a Jesutobits project; null with no folder open. */
  active: Project | null;
  /**
   * Counts every time the active project is opened, including the reopen after a runtime
   * restart, so stores reload what the restarted runtime no longer has.
   */
  generation: number;
}

export type ProjectStore = StoreApi<ProjectState>;

/**
 * The active project, as the extension reports it (ADR-0015): the panel never opens or
 * closes projects itself; VS Code's folder and Workspace Trust decide.
 */
export function createProjectStore(bridge: HostBridge): ProjectStore {
  const store = createStore<ProjectState>()(() => ({ active: null, generation: 0 }));
  bridge.onProject((project) =>
    store.setState((state) => ({ active: project, generation: state.generation + 1 })),
  );
  return store;
}
