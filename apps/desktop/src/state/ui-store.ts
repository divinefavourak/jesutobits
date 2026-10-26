import { createStore, type StoreApi } from "zustand/vanilla";

/** The overlay on top of the Workbench: quick open or the command palette (FR-074, FR-079). */
export type Overlay = "files" | "commands" | "search";

export interface UiState {
  overlay: Overlay | null;
  /** Settings replace the start screen or the Workbench until closed (FR-011). */
  settingsOpen: boolean;
  /** The section Settings opens at; null for the first. */
  settingsSection: string | null;
  /** Counts requests to focus the agent composer (Ctrl+L). */
  focusComposerRequest: number;
  show(overlay: Overlay): void;
  hide(): void;
  openSettings(section?: string): void;
  closeSettings(): void;
  focusComposer(): void;
}

export type UiStore = StoreApi<UiState>;

export function createUiStore(): UiStore {
  return createStore<UiState>()((set) => ({
    overlay: null,
    settingsOpen: false,
    settingsSection: null,
    focusComposerRequest: 0,
    show: (overlay) => set({ overlay }),
    hide: () => set({ overlay: null }),
    openSettings: (section) =>
      set({ settingsOpen: true, overlay: null, settingsSection: section ?? null }),
    closeSettings: () => set({ settingsOpen: false }),
    focusComposer: () => set((state) => ({ focusComposerRequest: state.focusComposerRequest + 1 })),
  }));
}
