import { createStore, type StoreApi } from "zustand/vanilla";
import type { HostBridge } from "../host-bridge";

export interface UiState {
  /** Counts requests to focus the agent composer (the "Focus the message box" command). */
  focusComposerRequest: number;
  /** Opens VS Code's Settings editor on Jesutobits' settings. */
  openSettings(section?: string): void;
  focusComposer(): void;
}

export type UiStore = StoreApi<UiState>;

export function createUiStore(bridge: HostBridge): UiStore {
  return createStore<UiState>()((set) => ({
    focusComposerRequest: 0,
    openSettings: (section) => void bridge.openSettings(section).catch(() => undefined),
    focusComposer: () => set((state) => ({ focusComposerRequest: state.focusComposerRequest + 1 })),
  }));
}
