import { createContext, useContext } from "react";
import { useStore, type StoreApi } from "zustand";
import { createExplorerStore, type ExplorerStore } from "../features/explorer/explorer-store";
import type { HostBridge } from "../host-bridge";
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
}

/** Builds the stores once, outside React, so StrictMode's double render cannot subscribe twice. */
export function createWorkbench(bridge: HostBridge): Workbench {
  const projects = createProjectStore(bridge);
  return {
    bridge,
    projects,
    layout: createLayoutStore(bridge, projects),
    output: createOutputStore(bridge),
    explorer: createExplorerStore(bridge, projects),
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
