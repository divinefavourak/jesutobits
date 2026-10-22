import { createStore, type StoreApi } from "zustand/vanilla";

/** The overlay on top of the Workbench: quick open or the command palette (FR-074, FR-079). */
export type Overlay = "files" | "commands";

export interface UiState {
  overlay: Overlay | null;
  /** Settings replace the start screen or the Workbench until closed (FR-011). */
  settingsOpen: boolean;
  show(overlay: Overlay): void;
  hide(): void;
  openSettings(): void;
  closeSettings(): void;
}

export type UiStore = StoreApi<UiState>;

export function createUiStore(): UiStore {
  return createStore<UiState>()((set) => ({
    overlay: null,
    settingsOpen: false,
    show: (overlay) => set({ overlay }),
    hide: () => set({ overlay: null }),
    openSettings: () => set({ settingsOpen: true, overlay: null }),
    closeSettings: () => set({ settingsOpen: false }),
  }));
}
