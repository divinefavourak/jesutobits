/**
 * Colour values theme tokens may use (EXTENSION_SYSTEM.md section 4.2): `#rgb`, `#rgba`,
 * `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`, `hsl()`/`hsla()` and `oklch()`. Everything is
 * parsed to sRGB, so Monaco and xterm (hex only) get hex and contrast is checked one way.
 */

export interface Rgba {
  /** 0 to 1, gamma-encoded sRGB. */
  r: number;
  g: number;
  b: number;
  /** 0 to 1. */
  a: number;
}

const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)`;
const PERCENT_OR_NUMBER = String.raw`(${NUMBER})(%?)`;
const SEP = String.raw`\s*[,\s]\s*`;
const ALPHA = String.raw`(?:\s*[,/]\s*${PERCENT_OR_NUMBER})?`;

const RGB = new RegExp(
  String.raw`^rgba?\(\s*${PERCENT_OR_NUMBER}${SEP}${PERCENT_OR_NUMBER}${SEP}${PERCENT_OR_NUMBER}${ALPHA}\s*\)$`,
  "i",
);
const HSL = new RegExp(
  String.raw`^hsla?\(\s*(${NUMBER})(?:deg)?${SEP}(${NUMBER})%${SEP}(${NUMBER})%${ALPHA}\s*\)$`,
  "i",
);
const OKLCH = new RegExp(
  String.raw`^oklch\(\s*${PERCENT_OR_NUMBER}\s+(${NUMBER})\s+(${NUMBER})(?:deg)?(?:\s*/\s*${PERCENT_OR_NUMBER})?\s*\)$`,
  "i",
);

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function channel(value: string, percent: string, scale: number): number {
  return clamp01(percent ? Number(value) / 100 : Number(value) / scale);
}

function alpha(value: string | undefined, percent: string | undefined): number {
  return value === undefined ? 1 : channel(value, percent ?? "", 1);
}

/** Parses a colour, or returns undefined for anything else (including `url()`). */
export function parseColor(input: string): Rgba | undefined {
  const text = input.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    const byte = (i: number) => parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255;
    return { r: byte(0), g: byte(1), b: byte(2), a: full.length === 8 ? byte(3) : 1 };
  }
  let m = RGB.exec(text);
  if (m) {
    return {
      r: channel(m[1] as string, m[2] as string, 255),
      g: channel(m[3] as string, m[4] as string, 255),
      b: channel(m[5] as string, m[6] as string, 255),
      a: alpha(m[7], m[8]),
    };
  }
  m = HSL.exec(text);
  if (m) {
    const [r, g, b] = hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
    return { r, g, b, a: alpha(m[4], m[5]) };
  }
  m = OKLCH.exec(text);
  if (m) {
    const lightness = channel(m[1] as string, m[2] as string, 1);
    const [r, g, b] = oklchToRgb(lightness, Number(m[3]), Number(m[4]));
    return { r, g, b, a: alpha(m[5], m[6]) };
  }
  return undefined;
}

function hslToRgb(hue: number, s: number, l: number): [number, number, number] {
  const h = (((hue % 360) + 360) % 360) / 360;
  const sat = clamp01(s);
  const lig = clamp01(l);
  if (sat === 0) return [lig, lig, lig];
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  const hue2 = (t0: number) => {
    const t = ((t0 % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue2(h + 1 / 3), hue2(h), hue2(h - 1 / 3)];
}

/** OKLCH to gamma-encoded sRGB, clipped to the gamut (Björn Ottosson's matrices). */
function oklchToRgb(l: number, c: number, hueDeg: number): [number, number, number] {
  const h = (hueDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ] as const;
  const encode = (x: number) =>
    clamp01(x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  return [encode(linear[0]), encode(linear[1]), encode(linear[2])];
}

export function toHex(color: Rgba, withAlpha = color.a < 1): string {
  const byte = (x: number) =>
    Math.round(clamp01(x) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}${withAlpha ? byte(color.a) : ""}`;
}

/** `top` drawn over an opaque `bottom`. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const mix = (x: number, y: number) => x * top.a + y * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

/** WCAG 2.2 relative luminance. */
export function luminance(color: Rgba): number {
  const linear = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/** WCAG contrast ratio of `foreground` over an opaque `background` (1 to 21). */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const fg = luminance(composite(foreground, background));
  const bg = luminance(background);
  const [light, dark] = fg > bg ? [fg, bg] : [bg, fg];
  return (light + 0.05) / (dark + 0.05);
}
