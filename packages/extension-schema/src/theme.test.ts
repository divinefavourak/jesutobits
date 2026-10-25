import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkContrast, compileTheme, variableName, type CompiledTheme } from "./theme-compiler.js";
import { REQUIRED_FOR_BUILTIN, ThemeTokensSchema, type ThemeTokens } from "./theme-tokens.js";

const builtinDir = new URL("../../../extensions/builtin/jesutobits-themes/", import.meta.url);
const builtin = (id: string): ThemeTokens =>
  ThemeTokensSchema.parse(
    JSON.parse(readFileSync(new URL(`themes/${id}.json`, builtinDir), "utf8")),
  );
const BUILTINS = ["dark", "light", "high-contrast"] as const;

describe("built-in themes (EXTENSION_SYSTEM.md section 4.3)", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("jesutobits-extension.json", builtinDir), "utf8"),
  ) as { contributes: { themes: Array<{ id: string; tokens: string }> } };

  it("lists exactly the three theme files in the manifest", () => {
    expect(manifest.contributes.themes.map((theme) => theme.id)).toEqual([...BUILTINS]);
  });

  it.each(BUILTINS)("%s defines every token, so it can be every theme's fallback", (id) => {
    const tokens = builtin(id) as Record<string, unknown>;
    expect(REQUIRED_FOR_BUILTIN.filter((key) => tokens[key] === undefined)).toEqual([]);
  });

  // WCAG 2.2 AA for Light and Dark, AAA text contrast for High Contrast (NFR-011).
  it.each(BUILTINS)("%s passes every contrast rule", (id) => {
    const theme = compileTheme(builtin(id), builtin(id));
    expect(checkContrast(theme)).toEqual([]);
  });
});

describe("ThemeTokensSchema", () => {
  const base = { tokenFormat: 1, base: "dark" };

  it("accepts a partial theme", () => {
    expect(ThemeTokensSchema.safeParse({ ...base, "color.accent": "#ff00aa" }).success).toBe(true);
  });

  it.each([
    ["an unknown token", { "color.sparkle": "#fff" }],
    ["a colour name", { "color.canvas": "black" }],
    ["url() as a colour", { "color.canvas": "url(https://x/y.png)" }],
    ["url() in a font", { "font.ui": "url(evil.woff)" }],
    ["CSS injection in a font", { "font.ui": "Inter; } body { display: none" }],
    ["url() in a shadow", { "shadow.md": "0px 1px 2px url(x)" }],
    ["a font size out of range", { "font.size.base": "30px" }],
    ["a radius out of range", { "radius.lg": "40px" }],
    ["motion out of range", { "motion.scale": 3 }],
    ["a background image outside the package", { "background.image": "../../secret.png" }],
    ["a background image with a drive letter", { "background.image": "C:/x.png" }],
  ])("rejects %s", (_name, tokens) => {
    expect(ThemeTokensSchema.safeParse({ ...base, ...tokens }).success).toBe(false);
  });

  it("requires the token format and base", () => {
    expect(ThemeTokensSchema.safeParse({ base: "dark" }).success).toBe(false);
    expect(ThemeTokensSchema.safeParse({ tokenFormat: 1, base: "sepia" }).success).toBe(false);
  });
});

describe("compileTheme", () => {
  const dark = builtin("dark");
  let compiled: CompiledTheme;

  it("fills missing tokens from the base and emits CSS variables in hex", () => {
    compiled = compileTheme(
      { tokenFormat: 1, base: "dark", "color.accent": "rgb(255, 0, 128)" },
      dark,
    );
    expect(compiled.colorScheme).toBe("dark");
    expect(compiled.variables["--jesutobits-color-accent"]).toBe("#ff0080");
    expect(compiled.variables["--jesutobits-color-canvas"]).toBe("#0d1117");
    expect(compiled.variables["--jesutobits-color-text-on-accent"]).toBe("#0d1117");
    expect(compiled.variables["--jesutobits-font-size-base"]).toBe("13px");
    expect(compiled.variables["--jesutobits-space-2"]).toBe("8px");
    expect(compiled.variables["--jesutobits-duration-fast"]).toBe("100ms");
  });

  it("derives spacing from density and scale, and durations from motion", () => {
    const tight = compileTheme(
      { tokenFormat: 1, base: "dark", density: "compact", "space.scale": 0.9, "motion.scale": 0 },
      dark,
    );
    expect(tight.variables["--jesutobits-space-2"]).toBe("5.4px");
    expect(tight.variables["--jesutobits-duration-normal"]).toBe("0ms");
  });

  it("builds a Monaco theme and an xterm theme", () => {
    compiled = compileTheme(dark, dark);
    expect(compiled.monaco.base).toBe("vs-dark");
    expect(compiled.monaco.colors["editor.background"]).toBe("#0d1117");
    expect(compiled.monaco.rules).toContainEqual({ token: "keyword", foreground: "ff7b72" });
    expect(compiled.terminal).toMatchObject({
      background: "#0a0e14",
      red: expect.stringMatching(/^#/),
    });
    expect(compileTheme(builtin("high-contrast"), builtin("high-contrast")).monaco.base).toBe(
      "hc-black",
    );
  });

  it("names variables from tokens", () => {
    expect(variableName("terminal.ansi.brightBlack")).toBe(
      "--jesutobits-terminal-ansi-bright-black",
    );
    expect(variableName("lineHeight.base")).toBe("--jesutobits-line-height-base");
  });

  it("reports contrast failures with their ratios", () => {
    const poor = compileTheme({ ...dark, "color.text.muted": "#2a3340" }, dark);
    expect(checkContrast(poor)).toContainEqual(
      expect.objectContaining({
        foreground: "color.text.muted",
        background: "color.canvas",
        required: 4.5,
      }),
    );
  });
});
