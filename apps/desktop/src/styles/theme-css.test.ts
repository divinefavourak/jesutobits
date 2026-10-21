import { COLOR_TOKENS, compileTheme, variableName } from "@jesutobits/extension-schema";
import { describe, expect, it } from "vitest";
import { baseTheme, BUILTIN_THEMES } from "../features/appearance/builtin-themes";
import css from "./theme.css?raw";

describe("Tailwind theme (styles/theme.css)", () => {
  // UI colours become utilities; editor, syntax and terminal colours go to Monaco and xterm.
  const uiColours = COLOR_TOKENS.filter((token) => token.startsWith("color."));

  it.each(uiColours)("maps %s to a utility colour", (token) => {
    const utility = variableName(token).replace("--jesutobits-color-", "--color-");
    expect(css).toContain(`${utility}: var(${variableName(token)});`);
  });

  // A misspelt variable would leave its utilities resolving to nothing, silently.
  it.each(BUILTIN_THEMES.map((theme) => [theme.id, theme] as const))(
    "only references variables the compiler sets for %s",
    (_id, theme) => {
      const { variables } = compileTheme(theme.tokens, baseTheme(theme.tokens.base).tokens);
      const referenced = [...css.matchAll(/var\((--jesutobits-[a-z0-9-]+)\)/g)].map((m) => m[1]);
      expect(referenced.length).toBeGreaterThan(0);
      expect(referenced.filter((name) => !(name! in variables))).toEqual([]);
    },
  );

  it("switches Tailwind's own palette off, so only token colours exist", () => {
    expect(css).toMatch(/--color-\*: initial;/);
  });
});
