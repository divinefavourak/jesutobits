import type { Remix, StudioTheme } from "@jesutobits/protocol";

/**
 * The Studio palettes (Figma Make "Jesutobits AI Coding Workspace", themes.ts), as data for
 * the theme picker's previews and remix. The themes themselves are generated from the same
 * values (scripts/gen-themes.mjs). Colour values live here, outside features/ and ui/, which
 * style only with theme tokens (jesutobits/no-raw-colors).
 */
export interface StudioPalette {
  name: StudioTheme;
  description: string;
  bg: string;
  panel: string;
  text: string;
  accent: string;
  light: boolean;
}

export const STUDIO_PALETTES: readonly StudioPalette[] = [
  {
    name: "Lavender dusk",
    description: "The cosy original",
    bg: "#17161c",
    panel: "#201e26",
    text: "#f2eff7",
    accent: "#c5b1f7",
    light: false,
  },
  {
    name: "Matcha",
    description: "A little room to breathe",
    bg: "#17201c",
    panel: "#202c25",
    text: "#edf4e9",
    accent: "#bad599",
    light: false,
  },
  {
    name: "Ocean after hours",
    description: "Deep focus, cool tones",
    bg: "#121d2a",
    panel: "#1c2939",
    text: "#ecf2fc",
    accent: "#91c9ee",
    light: false,
  },
  {
    name: "Peach tea",
    description: "Warm and quietly playful",
    bg: "#261c20",
    panel: "#32252b",
    text: "#fbefea",
    accent: "#efb69e",
    light: false,
  },
  {
    name: "Daydream",
    description: "Soft light for bright ideas",
    bg: "#eeebf4",
    panel: "#faf8fd",
    text: "#332b40",
    accent: "#7652af",
    light: true,
  },
  {
    name: "Paper & sage",
    description: "Fresh, light and grounded",
    bg: "#eeefe7",
    panel: "#fafbf5",
    text: "#303c2b",
    accent: "#537638",
    light: true,
  },
];

export const paletteNamed = (name: string): StudioPalette | undefined =>
  STUDIO_PALETTES.find((palette) => palette.name === name);

/** A theme's own colours as a remix, the starting point for fine-tuning. */
export const remixOf = (palette: StudioPalette): Remix => ({
  accent: palette.accent,
  canvas: palette.bg,
  surfaces: palette.panel,
  text: palette.text,
});

/** WCAG contrast ratio of two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const luminance = (hex: string) =>
    [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The lower of the text's contrast on the canvas and on the surfaces. */
export const textContrast = (remix: Remix): number =>
  Math.min(contrast(remix.text, remix.surfaces), contrast(remix.text, remix.canvas));

/** White or near-black text, whichever reads better on the surfaces. */
export const readableText = (remix: Remix): string =>
  contrast("#ffffff", remix.surfaces) > contrast("#17161c", remix.surfaces) ? "#ffffff" : "#17161c";
