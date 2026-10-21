import { createStore, type StoreApi } from "zustand/vanilla";

/** The overlay on top of the Workbench: quick open or the command palette (FR-074, FR-079). */
export type Overlay = "files" | "commands";

export interface UiState {
  overlay: Overlay | null;
  show(overlay: Overlay): void;
  hide(): void;
}

export type UiStore = StoreApi<UiState>;

export function createUiStore(): UiStore {
  return createStore<UiState>()((set) => ({
    overlay: null,
    show: (overlay) => set({ overlay }),
    hide: () => set({ overlay: null }),
  }));
}
