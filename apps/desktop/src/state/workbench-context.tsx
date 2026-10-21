import { createContext, useContext } from "react";
import { useStore, type StoreApi } from "zustand";
import {
  createEditorStore,
  type EditorState,
  type EditorStore,
} from "../features/editor/editor-store";
import { MemoryBuffers, type TextBuffers } from "../features/editor/text-buffers";
import { createExplorerStore, type ExplorerStore } from "../features/explorer/explorer-store";
import type { HostBridge } from "../host-bridge";
import {
  createAppearanceStore,
  type AppearanceState,
  type AppearanceStore,
} from "./appearance-store";
import { createLayoutStore, type LayoutState, type LayoutStore } from "./layout-store";
import { createOutputStore, type OutputState } from "./output-store";
import { createProjectStore, type ProjectState, type ProjectStore } from "./project-store";

/** What every Workbench view needs: the Host and the stores built on it. */
export interface Workbench {
  bridge: HostBridge;
  projects: ProjectStore;
  layout: LayoutStore;
  output: StoreApi<OutputState>;
  explorer: ExplorerStore;
  editor: EditorStore;
  /** The open files' text; Monaco models in the app (`MonacoBuffers`). */
  buffers: TextBuffers;
  appearance: AppearanceStore;
}

/**
 * Builds the stores once, outside React, so StrictMode's double render cannot subscribe
 * twice. Tests keep the default in-memory buffers; the app passes Monaco's.
 */
export function createWorkbench(
  bridge: HostBridge,
  options: { buffers?: TextBuffers } = {},
): Workbench {
  const projects = createProjectStore(bridge);
  const buffers = options.buffers ?? new MemoryBuffers();
  const editor = createEditorStore(bridge, projects, buffers);
  return {
    bridge,
    projects,
    layout: createLayoutStore(bridge, projects),
    output: createOutputStore(bridge),
    // A click in the explorer opens a preview tab; Enter or a double click pins it.
    explorer: createExplorerStore(bridge, projects, {
      open: (path, open) => void editor.getState().open(path, open),
      removed: (path) => editor.getState().removed(path),
    }),
    editor,
    buffers,
    appearance: createAppearanceStore(),
  };
}

const WorkbenchContext = createContext<Workbench | null>(null);

export const WorkbenchProvider = WorkbenchContext.Provider;

export function useWorkbench(): Workbench {
  const workbench = useContext(WorkbenchContext);
  if (!workbench) throw new Error("useWorkbench outside WorkbenchProvider");
  return workbench;
}

/** A slice of the project store; return primitives or stable references from `select`. */
export function useProjects<T>(select: (state: ProjectState) => T): T {
  return useStore(useWorkbench().projects, select);
}

export function useLayout<T>(select: (state: LayoutState) => T): T {
  return useStore(useWorkbench().layout, select);
}

export function useOutput<T>(select: (state: OutputState) => T): T {
  return useStore(useWorkbench().output, select);
}

export function useEditor<T>(select: (state: EditorState) => T): T {
  return useStore(useWorkbench().editor, select);
}

export function useAppearance<T>(select: (state: AppearanceState) => T): T {
  return useStore(useWorkbench().appearance, select);
}
