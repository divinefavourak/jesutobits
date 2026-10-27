import { createContext, useContext } from "react";
import { useStore } from "zustand";
import { createAgentStore, type AgentState, type AgentStore } from "../features/agent/agent-store";
import type { HostBridge } from "../host-bridge";
import { createProjectStore, type ProjectState, type ProjectStore } from "./project-store";
import { createUiStore, type UiState, type UiStore } from "./ui-store";

/** What every panel view needs: the bridge to the extension and the stores built on it. */
export interface Workbench {
  bridge: HostBridge;
  projects: ProjectStore;
  ui: UiStore;
  agent: AgentStore;
}

/** Builds the stores once, outside React, so StrictMode's double render cannot subscribe twice. */
export function createWorkbench(bridge: HostBridge): Workbench {
  const projects = createProjectStore(bridge);
  return {
    bridge,
    projects,
    ui: createUiStore(bridge),
    agent: createAgentStore(bridge, projects),
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

export function useUi<T>(select: (state: UiState) => T): T {
  return useStore(useWorkbench().ui, select);
}

export function useAgent<T>(select: (state: AgentState) => T): T {
  return useStore(useWorkbench().agent, select);
}
