import { z } from "zod";
import { PolicyPresetSchema } from "./agent.js";

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

/**
 * OpenRouter's own request options (AGENT_HARNESS.md section 2.2), in OpenRouter's field
 * names. Privacy first: providers that keep or train on prompts are excluded by default.
 */
export const OpenRouterOptionsSchema = z.object({
  provider: z
    .object({
      order: z.array(z.string().min(1)).max(20).optional(),
      allow_fallbacks: z.boolean().default(true),
      data_collection: z.enum(["allow", "deny"]).default("deny"),
    })
    .prefault({}),
  /** Fallback models OpenRouter may use when the chosen one is unavailable. */
  models: z.array(z.string().min(1)).max(10).optional(),
});
export type OpenRouterOptions = z.output<typeof OpenRouterOptionsSchema>;

export const ProvidersSettingsSchema = z.object({
  openrouter: z
    .object({
      enabled: z.boolean().default(true),
      /** Which stored key to use: `provider:openrouter:<profile>` (never the key itself). */
      profile: z
        .string()
        .regex(/^[a-z0-9-]{1,32}$/)
        .default("default"),
      /** Used for new sessions; null until the user picks one (onboarding step 5). */
      defaultModel: z.string().min(1).nullable().default(null),
      options: OpenRouterOptionsSchema.prefault({}),
    })
    .prefault({}),
});

/** AGENT_HARNESS.md section 3.4; every limit is a setting (FR-033). */
export const AgentSettingsSchema = z.object({
  /** For projects without a preset of their own (SECURITY.md section 4.2). */
  defaultPolicyPreset: PolicyPresetSchema.default("balanced"),
  limits: z
    .object({
      stepsPerTurn: z.number().int().min(1).max(1000).default(40),
      toolCallsPerTurn: z.number().int().min(1).max(5000).default(150),
      turnMinutes: z.number().int().min(1).max(600).default(30),
      costPerTurnUsd: z.number().min(0.01).max(1000).default(1),
      costPerSessionUsd: z.number().min(0.01).max(10_000).default(5),
      fixAttempts: z.number().int().min(1).max(10).default(3),
    })
    .prefault({}),
});

export const PrivacySettingsSchema = z.object({
  logModelTraffic: z.boolean().default(false),
  providerAttributionHeaders: z.boolean().default(false),
});

/** Buddy (the Studio design's co-builder), the pixel "J", a status dot, or no companion. */
export const CompanionSkinSchema = z.enum(["buddy", "mark", "dot", "off"]);
export type CompanionSkin = z.infer<typeof CompanionSkinSchema>;

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
  providers: ProvidersSettingsSchema.prefault({}),
  agent: AgentSettingsSchema.prefault({}),
  privacy: PrivacySettingsSchema.prefault({}),
  /** COMPANION_SYSTEM.md section 6: the built-in skins until skin packs arrive. */
  companion: z
    .object({
      skin: CompanionSkinSchema.default("buddy"),
    })
    .prefault({}),
  developer: z
    .object({
      extensionDeveloperMode: z.boolean().default(false),
    })
    .prefault({}),
});
export type AppSettings = z.output<typeof AppSettingsSchema>;

/** The settings the runtime acts on, sent by the Host in `runtime.configure`. */
export const RuntimeSettingsSchema = AppSettingsSchema.pick({
  providers: true,
  agent: true,
  privacy: true,
});
export type RuntimeSettings = z.output<typeof RuntimeSettingsSchema>;

/** Objects become optional at every level; arrays and values are replaced whole. */
type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** A partial update, merged into the current settings by the Host at every level. */
export type SettingsPatch = {
  [K in Exclude<keyof AppSettings, "schemaVersion">]?: DeepPartial<AppSettings[K]>;
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
