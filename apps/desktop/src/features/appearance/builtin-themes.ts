import manifest from "@jesutobits/builtin-themes/jesutobits-extension.json";
import dark from "@jesutobits/builtin-themes/themes/dark.json";
import highContrast from "@jesutobits/builtin-themes/themes/high-contrast.json";
import light from "@jesutobits/builtin-themes/themes/light.json";
import { ThemeTokensSchema, type ThemeBase, type ThemeTokens } from "@jesutobits/extension-schema";

/** A theme the user can pick: `<extension id>/<theme id>`, as stored in settings. */
export interface ThemeEntry {
  id: string;
  label: string;
  tokens: ThemeTokens;
}

const files: Record<string, unknown> = { dark, light, "high-contrast": highContrast };

/**
 * The built-in themes, read through the same schema as any extension's (EXTENSION_SYSTEM.md
 * section 4.3). Imported at build time until the Host serves extension files (Phase 6).
 */
export const BUILTIN_THEMES: readonly ThemeEntry[] = manifest.contributes.themes.map((theme) => ({
  id: `${manifest.id}/${theme.id}`,
  label: theme.label,
  tokens: ThemeTokensSchema.parse(files[theme.id]),
}));

/** The complete built-in theme for a base: every theme's fallback for missing tokens. */
export function baseTheme(base: ThemeBase): ThemeEntry {
  const id = { dark: "dark", light: "light", "high-contrast": "high-contrast" }[base];
  return BUILTIN_THEMES.find((theme) => theme.id === `${manifest.id}/${id}`) as ThemeEntry;
}
