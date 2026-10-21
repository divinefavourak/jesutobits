import { z } from "zod";

/**
 * `settings.json` (DATA_AND_PERSISTENCE.md section 5). The Host is its only writer and
 * validates with serde (`settings_store/settings.rs`); this schema is the Workbench's view.
 * Both run `fixtures/settings/cases.json`, and a Rust test compares its defaults with
 * `generated/settings.defaults.json`, generated from this schema.
 *
 * Phase 1 has the sections it uses. Later phases add sections with defaults (no schema
 * version bump needed); a version bump is for renames and meaning changes, with a migration.
 * No field may hold a secret (a test checks the names).
 */
export const SETTINGS_SCHEMA_VERSION = 1;

export const AppSettingsSchema = z.object({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION).default(SETTINGS_SCHEMA_VERSION),
  workspace: z
    .object({
      /** Where new projects go (FR-002); null until onboarding asks. */
      defaultFolder: z.string().min(1).nullable().default(null),
    })
    .prefault({}),
  appearance: z
    .object({
      /** `<extension id>/<theme id>`, for example a built-in theme. */
      theme: z.string().min(1).default("builtin.jesutobits-themes/dark"),
      followOsTheme: z.boolean().default(true),
      reduceMotion: z.boolean().default(false),
      uiScale: z.number().min(0.9).max(1.5).default(1),
      /** Overrides the theme's editor font size; null follows the theme. */
      editorFontSize: z.number().int().min(8).max(32).nullable().default(null),
    })
    .prefault({}),
  terminal: z
    .object({
      /** `auto` picks PowerShell 7, then Windows PowerShell (UX_AND_INTERFACE.md 5.4). */
      shell: z.string().min(1).default("auto"),
    })
    .prefault({}),
  privacy: z
    .object({
      logModelTraffic: z.boolean().default(false),
      providerAttributionHeaders: z.boolean().default(false),
    })
    .prefault({}),
  developer: z
    .object({
      extensionDeveloperMode: z.boolean().default(false),
    })
    .prefault({}),
});
export type AppSettings = z.output<typeof AppSettingsSchema>;

/** A partial update, merged into the current settings by the Host. */
export type SettingsPatch = {
  [K in Exclude<keyof AppSettings, "schemaVersion">]?: Partial<AppSettings[K]>;
};

export const WindowStateSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(200),
  height: z.number().int().min(200),
  maximized: z.boolean(),
});
export type WindowState = z.infer<typeof WindowStateSchema>;

/**
 * `ui-state.json`: high-churn UI state (DATA_AND_PERSISTENCE.md section 5). The Host owns
 * `window` and restores it; every other key belongs to the Workbench, which validates its
 * own parts (layout per project, onboarding progress) and falls back to defaults.
 */
export const UiStateSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    window: WindowStateSchema.nullable().default(null),
  })
  .catchall(z.unknown());
export type UiState = z.output<typeof UiStateSchema>;

/** Something the user should be told about settings files at startup. */
export const HostNoticeSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type HostNotice = z.infer<typeof HostNoticeSchema>;
