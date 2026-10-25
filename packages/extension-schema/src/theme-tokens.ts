import { z } from "zod";
import { parseColor } from "./color.js";

/**
 * Theme token files (EXTENSION_SYSTEM.md section 4). A theme is data: every key below has a
 * kind that decides how it is checked and compiled. Only `tokenFormat` and `base` are
 * required; missing tokens come from the built-in theme of the same base.
 */

export const THEME_BASES = ["light", "dark", "high-contrast"] as const;
export type ThemeBase = (typeof THEME_BASES)[number];

const ANSI = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

export const COLOR_TOKENS = [
  "color.canvas",
  "color.surface",
  "color.surface.raised",
  "color.surface.sunken",
  "color.text",
  "color.text.muted",
  "color.text.subtle",
  "color.text.onAccent",
  "color.border",
  "color.border.strong",
  "color.accent",
  "color.accent.hover",
  "color.accent.subtle",
  "color.focus",
  "color.selection",
  "color.item.hover",
  "color.item.active",
  "color.success",
  "color.success.subtle",
  "color.warning",
  "color.warning.subtle",
  "color.danger",
  "color.danger.subtle",
  "color.info",
  "color.info.subtle",
  "color.diff.added",
  "color.diff.removed",
  "color.preview.chrome",
  "color.preview.inspect",
  "color.preview.draft",
  "editor.background",
  "editor.foreground",
  "editor.lineHighlight",
  "editor.selection",
  "editor.cursor",
  "editor.gutter",
  "syntax.keyword",
  "syntax.string",
  "syntax.number",
  "syntax.comment",
  "syntax.function",
  "syntax.type",
  "syntax.variable",
  "syntax.punctuation",
  "terminal.background",
  "terminal.foreground",
  ...ANSI.map((name) => `terminal.ansi.${name}` as const),
] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];

/** Terminal colours are optional even in a complete theme: they derive from the base. */
export const OPTIONAL_COLOR_TOKENS: ReadonlySet<string> = new Set(
  COLOR_TOKENS.filter((token) => token.startsWith("terminal.ansi.")),
);

const color = z.string().refine((value) => parseColor(value) !== undefined, {
  message: "Expected a colour: #rgb, #rrggbb, #rrggbbaa, rgb(), hsl() or oklch()",
});

const px = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+(?:\.\d+)?px$/, "Expected a length in px, for example 8px")
    .refine((value) => {
      const n = Number.parseFloat(value);
      return n >= min && n <= max;
    }, `Expected between ${min}px and ${max}px`);

/** A font-family list. No url(), quotes balanced, nothing that could end a CSS value. */
const fontStack = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w\s,"'-]+$/, "Expected font names separated by commas");

/** One or more box-shadows; no url() or other functions besides colours. */
const shadow = z
  .string()
  .max(200)
  .regex(
    /^(?:none|(?:(?:inset\s+)?(?:-?\d+(?:\.\d+)?px\s+){2,3}(?:-?\d+(?:\.\d+)?px\s+)?(?:#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%/]+\))(?:\s*,\s*)?)+)$/,
    "Expected box-shadow values with px lengths and a colour",
  );

const range = (min: number, max: number) => z.number().min(min).max(max);

/** Paths inside the extension package (EXTENSION_SYSTEM.md section 3.3, PackagePath). */
const packagePath = z
  .string()
  .max(200)
  .regex(
    /^(?![\\/])(?!.*\.\.)(?![A-Za-z]:)[^\\\0]+$/,
    "Expected a relative path inside the package",
  );

const colorShape = Object.fromEntries(COLOR_TOKENS.map((token) => [token, color.optional()])) as {
  [K in ColorToken]: z.ZodOptional<typeof color>;
};

export const ThemeTokensSchema = z
  .object({
    $schema: z.string().optional(),
    tokenFormat: z.literal(1),
    base: z.enum(THEME_BASES),
    ...colorShape,
    "border.width": z.enum(["1px", "2px"]).optional(),
    "font.ui": fontStack.optional(),
    "font.mono": fontStack.optional(),
    "font.size.base": px(12, 16).optional(),
    "lineHeight.base": range(1.3, 1.7).optional(),
    "radius.sm": px(0, 16).optional(),
    "radius.md": px(0, 16).optional(),
    "radius.lg": px(0, 16).optional(),
    density: z.enum(["compact", "comfortable"]).optional(),
    "space.scale": range(0.85, 1.15).optional(),
    "shadow.sm": shadow.optional(),
    "shadow.md": shadow.optional(),
    "shadow.lg": shadow.optional(),
    "motion.scale": range(0, 1.5).optional(),
    "background.image": packagePath.optional(),
    "background.mode": z.enum(["cover", "tile"]).optional(),
    "background.opacity": range(0, 0.15).optional(),
  })
  .strict();

export type ThemeTokens = z.infer<typeof ThemeTokensSchema>;

/** Every key a complete theme defines (all except the optional ones). */
export const REQUIRED_FOR_BUILTIN: readonly string[] = [
  ...COLOR_TOKENS.filter((token) => !OPTIONAL_COLOR_TOKENS.has(token)),
  "border.width",
  "font.ui",
  "font.mono",
  "font.size.base",
  "lineHeight.base",
  "radius.sm",
  "radius.md",
  "radius.lg",
  "density",
  "space.scale",
  "shadow.sm",
  "shadow.md",
  "shadow.lg",
  "motion.scale",
];
