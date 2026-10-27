import { describe, expect, it } from "vitest";
import { runtimeConfig, type SettingReader } from "./runtime-config.js";

function reader(values: Record<string, unknown> = {}): SettingReader {
  return (key) => values[key];
}

describe("runtimeConfig", () => {
  it("gives the schema's defaults when nothing is set", () => {
    const { config, problem } = runtimeConfig(reader(), []);

    expect(problem).toBeUndefined();
    expect(config.settings.providers.openrouter.profile).toBe("default");
    expect(config.settings.providers.openrouter.defaultModel).toBeNull();
    expect(config.settings.providers.openrouter.options.provider.data_collection).toBe("deny");
    expect(config.settings.agent.defaultPolicyPreset).toBe("balanced");
    expect(config.settings.agent.limits.stepsPerTurn).toBe(40);
    expect(config.settings.privacy.logModelTraffic).toBe(false);
  });

  it("maps VS Code settings onto the runtime's", () => {
    const { config, problem } = runtimeConfig(
      reader({
        "providers.openrouter.dataCollection": "allow",
        "providers.openrouter.allowFallbacks": false,
        "providers.openrouter.defaultModel": "anthropic/claude-sonnet-5.5",
        "agent.limits.stepsPerTurn": 12,
        "agent.limits.costPerTurnUsd": 2.5,
        "privacy.logModelTraffic": true,
      }),
      [],
    );

    expect(problem).toBeUndefined();
    expect(config.settings.providers.openrouter.options.provider.data_collection).toBe("allow");
    expect(config.settings.providers.openrouter.options.provider.allow_fallbacks).toBe(false);
    expect(config.settings.providers.openrouter.defaultModel).toBe("anthropic/claude-sonnet-5.5");
    expect(config.settings.agent.limits.stepsPerTurn).toBe(12);
    expect(config.settings.agent.limits.costPerTurnUsd).toBe(2.5);
    expect(config.settings.privacy.logModelTraffic).toBe(true);
    expect(config.settings.agent.limits.toolCallsPerTurn).toBe(150);
  });

  it("falls back to all defaults when a value is out of range", () => {
    const { config, problem } = runtimeConfig(
      reader({ "agent.limits.stepsPerTurn": 0, "privacy.logModelTraffic": true }),
      [],
    );

    expect(problem).toContain("jesutobits.agent.limits.stepsPerTurn");
    expect(config.settings.agent.limits.stepsPerTurn).toBe(40);
    expect(config.settings.privacy.logModelTraffic).toBe(false);
  });

  it("falls back to all defaults when the provider profile is not a slug", () => {
    const { config, problem } = runtimeConfig(
      reader({ "providers.openrouter.profile": "Bad Name" }),
      [],
    );

    expect(problem).toContain("jesutobits.providers.openrouter.profile");
    expect(config.settings.providers.openrouter.profile).toBe("default");
  });

  it("passes the app folders through", () => {
    const appDirs = ["/home/ada/.config/jesutobits/logs"];

    expect(runtimeConfig(reader(), appDirs).config.appDirs).toBe(appDirs);
  });
});
