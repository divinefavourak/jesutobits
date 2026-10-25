import { composite, contrastRatio, parseColor, toHex, type Rgba } from "./color.js";
import { COLOR_TOKENS, type ColorToken, type ThemeBase, type ThemeTokens } from "./theme-tokens.js";

/**
 * Compiles token files into what the Workbench applies (EXTENSION_SYSTEM.md section 4.1):
 * CSS custom properties (`--jesutobits-color-canvas`), a Monaco theme and an xterm theme.
 * Pure data in, data out: no DOM, no Monaco import, so it runs in tests, the Workbench and
 * the extension CLI alike.
 */

/** `monaco.editor.IStandaloneThemeData`, without importing Monaco. */
export interface MonacoThemeData {
  base: "vs" | "vs-dark" | "hc-black" | "hc-light";
  inherit: boolean;
  rules: Array<{ token: string; foreground: string; fontStyle?: string }>;
  colors: Record<string, string>;
}

/** xterm.js `ITheme`. */
export type TerminalTheme = Record<string, string>;

export interface CompiledTheme {
  base: ThemeBase;
  colorScheme: "light" | "dark";
  /** CSS custom property name to value. */
  variables: Record<string, string>;
  monaco: MonacoThemeData;
  terminal: TerminalTheme;
  /** The resolved tokens (theme over its base), for contrast checks and inspectors. */
  tokens: ResolvedTokens;
}

/** Every token present, colours as hex. */
export type ResolvedTokens = Omit<ThemeTokens, "$schema"> & Record<ColorToken, string>;

const ANSI_DEFAULTS: Record<"light" | "dark", Record<string, string>> = {
  dark: {
    black: "#1b1f24",
    red: "#ff7b72",
    green: "#3fb950",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#ffffff",
  },
  light: {
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#7d4e00",
    blue: "#0550ae",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#633c01",
    brightBlue: "#0969da",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
  },
};

/** `color.text.onAccent` -> `--jesutobits-color-text-on-accent`. */
export function variableName(token: string): string {
  return `--jesutobits-${token.replace(/\./g, "-").replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * `tokens` over `fallback`, which must be a complete theme of the same base (a built-in).
 * Throws if a colour cannot be parsed; validate with ThemeTokensSchema first.
 */
export function compileTheme(tokens: ThemeTokens, fallback: ThemeTokens): CompiledTheme {
  const merged = { ...fallback, ...tokens } as Record<string, unknown>;
  delete merged.$schema;
  const scheme: "light" | "dark" = tokens.base === "light" ? "light" : "dark";
  for (const [name, value] of Object.entries(ANSI_DEFAULTS[scheme])) {
    merged[`terminal.ansi.${name}`] ??= value;
  }

  const colors = {} as Record<ColorToken, string>;
  for (const token of COLOR_TOKENS) {
    const value = merged[token];
    const parsed = typeof value === "string" ? parseColor(value) : undefined;
    if (!parsed) throw new Error(`Theme token ${token} is missing or not a colour`);
    colors[token] = toHex(parsed);
  }
  const resolved = { ...merged, ...colors } as ResolvedTokens;

  const variables: Record<string, string> = {};
  for (const [token, value] of Object.entries(resolved)) {
    if (token === "tokenFormat" || token === "base" || token.startsWith("background.")) continue;
    variables[variableName(token)] = String(value);
  }
  // Derived values components use instead of raw numbers.
  const unit = (resolved.density === "compact" ? 3 : 4) * (resolved["space.scale"] ?? 1);
  for (let step = 1; step <= 8; step++) {
    variables[`--jesutobits-space-${step}`] = `${round(unit * step)}px`;
  }
  const motion = resolved["motion.scale"] ?? 1;
  variables["--jesutobits-duration-fast"] = `${round(100 * motion)}ms`;
  variables["--jesutobits-duration-normal"] = `${round(200 * motion)}ms`;

  return {
    base: tokens.base,
    colorScheme: scheme,
    variables,
    monaco: monacoTheme(tokens.base, resolved),
    terminal: terminalTheme(resolved),
    tokens: resolved,
  };
}

function monacoTheme(base: ThemeBase, t: ResolvedTokens): MonacoThemeData {
  const bare = (hex: string) => hex.replace(/^#/, "");
  const rule = (token: string, color: string, fontStyle?: string) => ({
    token,
    foreground: bare(color),
    ...(fontStyle && { fontStyle }),
  });
  return {
    base: base === "high-contrast" ? "hc-black" : base === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules: [
      rule("keyword", t["syntax.keyword"]),
      rule("string", t["syntax.string"]),
      rule("number", t["syntax.number"]),
      rule("comment", t["syntax.comment"], "italic"),
      rule("entity.name.function", t["syntax.function"]),
      rule("type", t["syntax.type"]),
      rule("type.identifier", t["syntax.type"]),
      rule("identifier", t["syntax.variable"]),
      rule("variable", t["syntax.variable"]),
      rule("delimiter", t["syntax.punctuation"]),
    ],
    colors: {
      "editor.background": t["editor.background"],
      "editor.foreground": t["editor.foreground"],
      "editor.lineHighlightBackground": t["editor.lineHighlight"],
      "editor.selectionBackground": t["editor.selection"],
      "editorCursor.foreground": t["editor.cursor"],
      "editorGutter.background": t["editor.gutter"],
      "editorLineNumber.foreground": t["color.text.subtle"],
      "editorLineNumber.activeForeground": t["color.text.muted"],
      "editorWidget.background": t["color.surface.raised"],
      "editorWidget.border": t["color.border"],
      focusBorder: t["color.focus"],
      "diffEditor.insertedTextBackground": t["color.diff.added"],
      "diffEditor.removedTextBackground": t["color.diff.removed"],
    },
  };
}

function terminalTheme(t: ResolvedTokens): TerminalTheme {
  const theme: TerminalTheme = {
    background: t["terminal.background"],
    foreground: t["terminal.foreground"],
    cursor: t["editor.cursor"],
    selectionBackground: t["editor.selection"],
  };
  for (const token of COLOR_TOKENS) {
    if (token.startsWith("terminal.ansi.")) theme[token.slice("terminal.ansi.".length)] = t[token];
  }
  return theme;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** A contrast pair from WCAG 2.2 (NFR-011): text 4.5:1, focus rings and boundaries 3:1. */
export interface ContrastRule {
  foreground: ColorToken;
  background: ColorToken;
  /** AA minimum; High Contrast themes must reach `highContrast` instead. */
  min: number;
  highContrast: number;
}

const TEXT = { min: 4.5, highContrast: 7 };
const NON_TEXT = { min: 3, highContrast: 4.5 };

export const CONTRAST_RULES: readonly ContrastRule[] = [
  ...(
    ["color.canvas", "color.surface", "color.surface.raised", "color.surface.sunken"] as const
  ).map((background) => ({ foreground: "color.text" as const, background, ...TEXT })),
  ...(["color.canvas", "color.surface"] as const).flatMap((background) => [
    { foreground: "color.text.muted" as const, background, ...TEXT },
    { foreground: "color.accent" as const, background, ...TEXT },
    { foreground: "color.focus" as const, background, ...NON_TEXT },
    { foreground: "color.text.subtle" as const, background, ...NON_TEXT },
  ]),
  { foreground: "color.text.onAccent", background: "color.accent", ...TEXT },
  { foreground: "color.border.strong", background: "color.canvas", ...NON_TEXT },
  ...(["color.success", "color.warning", "color.danger", "color.info"] as const).map(
    (foreground) => ({ foreground, background: "color.surface" as const, ...NON_TEXT }),
  ),
  { foreground: "editor.foreground", background: "editor.background", ...TEXT },
  ...(
    [
      "syntax.keyword",
      "syntax.string",
      "syntax.number",
      "syntax.comment",
      "syntax.function",
      "syntax.type",
      "syntax.variable",
      "syntax.punctuation",
    ] as const
  ).map((foreground) => ({ foreground, background: "editor.background" as const, ...TEXT })),
  { foreground: "terminal.foreground", background: "terminal.background", ...TEXT },
];

export interface ContrastFailure {
  foreground: ColorToken;
  background: ColorToken;
  ratio: number;
  required: number;
}

/** Every contrast rule the theme fails; empty when it meets WCAG 2.2 AA (AAA for HC text). */
export function checkContrast(theme: CompiledTheme): ContrastFailure[] {
  const failures: ContrastFailure[] = [];
  const colour = (token: ColorToken): Rgba => parseColor(theme.tokens[token]) as Rgba;
  for (const rule of CONTRAST_RULES) {
    const required = theme.base === "high-contrast" ? rule.highContrast : rule.min;
    // Translucent backgrounds sit on the canvas.
    const background = composite(colour(rule.background), colour("color.canvas"));
    const ratio = contrastRatio(colour(rule.foreground), background);
    if (ratio + 1e-9 < required) {
      failures.push({ ...rule, ratio: Math.round(ratio * 100) / 100, required });
    }
  }
  return failures;
}
