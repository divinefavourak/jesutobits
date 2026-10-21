import { AppSettingsSchema, type AppSettings } from "@jesutobits/protocol";
import { describe, expect, it } from "vitest";
import { baseTheme, BUILTIN_THEMES } from "./builtin-themes";
import { ThemeEngine, type MediaQueries } from "./theme-engine";

function setup(os: Record<string, boolean> = {}) {
  const variables = new Map<string, string>();
  const attributes = new Map<string, string>();
  let listener: (() => void) | undefined;
  const media: MediaQueries = {
    matches: (query) => os[query] ?? false,
    watch: (_queries, onChange) => {
      listener = onChange;
      return () => {
        listener = undefined;
      };
    },
  };
  const engine = new ThemeEngine(
    {
      setVariable: (name, value) => variables.set(name, value),
      setAttribute: (name, value) => attributes.set(name, value),
    },
    media,
  );
  const osChanged = (changes: Record<string, boolean>) => {
    Object.assign(os, changes);
    listener?.();
  };
  return { engine, variables, attributes, osChanged };
}

const appearance = (patch: Partial<AppSettings["appearance"]> = {}): AppSettings["appearance"] => ({
  ...AppSettingsSchema.parse({}).appearance,
  ...patch,
});

describe("ThemeEngine", () => {
  it("has the three built-in themes", () => {
    expect(BUILTIN_THEMES.map((theme) => theme.id)).toEqual([
      "builtin.jesutobits-themes/dark",
      "builtin.jesutobits-themes/light",
      "builtin.jesutobits-themes/high-contrast",
    ]);
  });

  it("applies a chosen theme as CSS variables and attributes", () => {
    const { engine, variables, attributes } = setup();
    const applied = engine.apply(
      appearance({ followOsTheme: false, theme: "builtin.jesutobits-themes/light" }),
    );
    expect(variables.get("--jesutobits-color-canvas")).toBe(
      baseTheme("light").tokens["color.canvas"],
    );
    expect(variables.get("color-scheme")).toBe("light");
    expect(attributes.get("data-theme")).toBe("builtin.jesutobits-themes/light");
    expect(applied.ms).toBeLessThan(200);
  });

  it("follows the OS: dark, light, and High Contrast for contrast themes", () => {
    const { engine, attributes } = setup({ "(prefers-color-scheme: dark)": true });
    engine.apply(appearance());
    expect(attributes.get("data-theme")).toBe("builtin.jesutobits-themes/dark");

    const light = setup({ "(prefers-color-scheme: dark)": false });
    light.engine.apply(appearance());
    expect(light.attributes.get("data-theme")).toBe("builtin.jesutobits-themes/light");

    const forced = setup({ "(forced-colors: active)": true });
    forced.engine.apply(appearance());
    expect(forced.attributes.get("data-theme")).toBe("builtin.jesutobits-themes/high-contrast");
  });

  it("re-applies when the OS setting changes", () => {
    const { engine, attributes, osChanged } = setup({ "(prefers-color-scheme: dark)": false });
    const seen: string[] = [];
    engine.start(appearance(), (applied) => seen.push(applied.theme.id));
    osChanged({ "(prefers-color-scheme: dark)": true });
    expect(attributes.get("data-theme")).toBe("builtin.jesutobits-themes/dark");
    expect(seen).toEqual(["builtin.jesutobits-themes/dark"]);
    engine.stop();
  });

  it("turns motion off for the OS setting or the app setting", () => {
    const os = setup({ "(prefers-reduced-motion: reduce)": true });
    os.engine.apply(appearance());
    expect(os.variables.get("--jesutobits-duration-normal")).toBe("0ms");

    const app = setup();
    app.engine.apply(appearance({ reduceMotion: true }));
    expect(app.attributes.get("data-reduce-motion")).toBe("true");
    expect(app.variables.get("--jesutobits-duration-fast")).toBe("0ms");
  });

  it("falls back to Dark for an unknown theme", () => {
    const { engine, attributes } = setup();
    engine.apply(appearance({ followOsTheme: false, theme: "someone.removed/theme" }));
    expect(attributes.get("data-theme")).toBe("builtin.jesutobits-themes/dark");
  });

  it("exposes the UI scale", () => {
    const { engine, variables } = setup();
    engine.apply(appearance({ uiScale: 1.25 }));
    expect(variables.get("--jesutobits-ui-scale")).toBe("1.25");
  });
});
