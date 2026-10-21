import type { AppSettings } from "@jesutobits/protocol";
import type { CompiledTheme } from "@jesutobits/extension-schema";
import { createStore, type StoreApi } from "zustand/vanilla";

export interface AppearanceState {
  /** The theme the ThemeEngine applied last; the editor follows it (EXTENSION_SYSTEM.md 4.1). */
  compiled: CompiledTheme | null;
  appearance: AppSettings["appearance"] | null;
}

export type AppearanceStore = StoreApi<AppearanceState>;

export function createAppearanceStore(): AppearanceStore {
  return createStore<AppearanceState>()(() => ({ compiled: null, appearance: null }));
}

/** The editor font: the settings override, else the theme's base size times the UI scale. */
export function editorFont(state: AppearanceState): { family: string; size: number } {
  const tokens = state.compiled?.tokens;
  const family = tokens?.["font.mono"] ?? "monospace";
  const override = state.appearance?.editorFontSize;
  if (override) return { family, size: override };
  const base = Number.parseFloat(tokens?.["font.size.base"] ?? "13px") || 13;
  return { family, size: Math.round(base * (state.appearance?.uiScale ?? 1)) };
}
