// `runtime.configure`'s params from VS Code settings (`jesutobits.*` in package.json). VS Code
// owns the settings file now (ADR-0015); the runtime gets the sections it acts on.
import { RuntimeSettingsSchema, type RuntimeSettings } from "@jesutobits/protocol";

/** Reads one `jesutobits.*` setting by its key without the prefix; undefined when unset. */
export type SettingReader = (key: string) => unknown;

export interface RuntimeConfig {
  settings: RuntimeSettings;
  appDirs: string[];
}

export interface ConfigResult {
  config: RuntimeConfig;
  /** Set when the settings were invalid and the defaults were sent instead. */
  problem?: string;
}

/**
 * The runtime's settings, validated by the protocol schema. An invalid value (VS Code only
 * warns about those) falls back to all defaults rather than half-applied settings.
 */
export function runtimeConfig(read: SettingReader, appDirs: string[]): ConfigResult {
  const candidate = {
    providers: {
      openrouter: {
        enabled: read("providers.openrouter.enabled"),
        profile: read("providers.openrouter.profile"),
        defaultModel: read("providers.openrouter.defaultModel"),
        options: {
          provider: {
            data_collection: read("providers.openrouter.dataCollection"),
            allow_fallbacks: read("providers.openrouter.allowFallbacks"),
          },
        },
      },
    },
    agent: {
      defaultPolicyPreset: read("agent.defaultPolicyPreset"),
      limits: {
        stepsPerTurn: read("agent.limits.stepsPerTurn"),
        toolCallsPerTurn: read("agent.limits.toolCallsPerTurn"),
        turnMinutes: read("agent.limits.turnMinutes"),
        costPerTurnUsd: read("agent.limits.costPerTurnUsd"),
        costPerSessionUsd: read("agent.limits.costPerSessionUsd"),
        fixAttempts: read("agent.limits.fixAttempts"),
      },
    },
    privacy: {
      logModelTraffic: read("privacy.logModelTraffic"),
      providerAttributionHeaders: read("privacy.providerAttributionHeaders"),
    },
  };
  const parsed = RuntimeSettingsSchema.safeParse(withoutUndefined(candidate));
  if (parsed.success) return { config: { settings: parsed.data, appDirs } };
  return {
    config: { settings: RuntimeSettingsSchema.parse({}), appDirs },
    problem: parsed.error.issues
      .map((issue) => `jesutobits.${issue.path.join(".")}: ${issue.message}`)
      .join("; "),
  };
}

/** Drops unset values so the schema's defaults apply to them. */
function withoutUndefined(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .map(([key, field]) => [key, withoutUndefined(field)]),
  );
}
