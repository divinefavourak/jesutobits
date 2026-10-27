import { createStore, type StoreApi } from "zustand/vanilla";
import type { HostBridge } from "../host-bridge";

export interface UiState {
  /** Counts requests to focus the agent composer (the "Focus the message box" command). */
  focusComposerRequest: number;
  /** The message being written in the composer. */
  draft: string;
  /** Opens VS Code's Settings editor on Jesutobits' settings. */
  openSettings(section?: string): void;
  focusComposer(): void;
  setDraft(text: string): void;
  /**
   * Starts the draft with `text` (an element from the preview, FR-113) and focuses the box;
   * the user finishes and sends it. Whatever was typed already stays after it.
   */
  compose(text: string): void;
}

export type UiStore = StoreApi<UiState>;

export function createUiStore(bridge: HostBridge): UiStore {
  const store = createStore<UiState>()((set) => ({
    focusComposerRequest: 0,
    draft: "",
    openSettings: (section) => void bridge.openSettings(section).catch(() => undefined),
    focusComposer: () => set((state) => ({ focusComposerRequest: state.focusComposerRequest + 1 })),
    setDraft: (draft) => set({ draft }),
    compose: (text) =>
      set((state) => ({
        draft: state.draft.trim() === "" ? text : `${text}\n\n${state.draft}`,
        focusComposerRequest: state.focusComposerRequest + 1,
      })),
  }));
  bridge.onCompose((text) => store.getState().compose(text));
  return store;
}
