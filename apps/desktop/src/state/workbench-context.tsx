import { createContext, useContext } from "react";
import { useStore } from "zustand";
import type { HostBridge } from "../host-bridge";
import type { ProjectState, ProjectStore } from "./project-store";

/** What every Workbench view needs: the Host and the stores built on it. */
export interface Workbench {
  bridge: HostBridge;
  projects: ProjectStore;
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
