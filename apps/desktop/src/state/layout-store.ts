import { createStore, type StoreApi } from "zustand/vanilla";
import {
  parseLayout,
  presetLayout,
  type Layout,
  type PresetId,
} from "../features/layout/layout-model";
import type { HostBridge } from "../host-bridge";
import type { ProjectStore } from "./project-store";

/** The `ui-state.json` key holding each project's layout by `prj_` ID (FR-008, FR-071). */
export const LAYOUTS_KEY = "layouts";
/** Layout changes are written after this quiet period, so dragging a splitter writes once. */
export const SAVE_DELAY_MS = 250;

export interface LayoutState {
  /** The open project's layout; null on the start screen and while loading. */
  layout: Layout | null;
  /** Applies an edit from `layout-model.ts`; saved for this project. */
  update(edit: (layout: Layout) => Layout): void;
  /** Switches to a preset (title bar, `Alt+1` to `Alt+4`). */
  usePreset(preset: PresetId): void;
  /** Back to the unmodified preset this layout is based on ("Reset layout"). */
  reset(): void;
}

export type LayoutStore = StoreApi<LayoutState>;

/**
 * The dock layout of the open project (UX_AND_INTERFACE.md section 4.4). Loaded from
 * `ui-state.json` when a project opens and saved there per project, so each project keeps
 * its own arrangement across restarts. Phase 1 opens every project with Code; Build becomes
 * the default for new projects once the agent and preview exist (ROADMAP Phase 1 notes).
 */
export function createLayoutStore(bridge: HostBridge, projects: ProjectStore): LayoutStore {
  let projectId: string | null = null;
  /** Every project's stored layout, as last read or written; the Workbench owns this key. */
  let stored: Record<string, unknown> = {};
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: { id: string; layout: Layout } | undefined;

  const flush = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!pending) return;
    stored = { ...stored, [pending.id]: pending.layout };
    pending = undefined;
    bridge.uiState
      .update({ [LAYOUTS_KEY]: stored })
      .catch((error: unknown) => bridge.log("warn", `saving the layout failed: ${String(error)}`));
  };

  const store = createStore<LayoutState>()((set, get) => {
    const change = (layout: Layout) => {
      if (!projectId || layout === get().layout) return;
      set({ layout });
      pending = { id: projectId, layout };
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, SAVE_DELAY_MS);
    };
    return {
      layout: null,
      update: (edit) => {
        const current = get().layout;
        if (current) change(edit(current));
      },
      usePreset: (preset) => change(presetLayout(preset)),
      reset: () => {
        const current = get().layout;
        if (current) change(presetLayout(current.preset));
      },
    };
  });

  const load = async (id: string) => {
    const uiState = await bridge.uiState.get().catch(() => ({}) as Record<string, unknown>);
    const layouts = uiState[LAYOUTS_KEY];
    stored = typeof layouts === "object" && layouts !== null ? { ...layouts } : {};
    if (projectId === id) store.setState({ layout: parseLayout(stored[id], "code") });
  };

  projects.subscribe((state) => {
    const id = state.active?.id ?? null;
    if (id === projectId) return;
    flush();
    projectId = id;
    store.setState({ layout: null });
    if (id) void load(id);
  });

  return store;
}
