import { describe, expect, it } from "vitest";
import { composite, contrastRatio, parseColor, toHex } from "./color.js";

const hex = (input: string) => {
  const color = parseColor(input);
  if (!color) throw new Error(`not a colour: ${input}`);
  return toHex(color);
};

describe("parseColor", () => {
  it.each([
    ["#fff", "#ffffff"],
    ["#0D1117", "#0d1117"],
    ["#11223380", "#11223380"],
    ["rgb(255, 0, 0)", "#ff0000"],
    ["rgba(0 128 255 / 50%)", "#0080ff80"],
    ["hsl(120, 100%, 25%)", "#008000"],
    ["hsl(0deg 0% 50%)", "#808080"],
    // CSS Color 4 reference values for oklch.
    ["oklch(0.628 0.2577 29.23)", "#ff0000"],
    ["oklch(100% 0 0)", "#ffffff"],
    ["oklch(0 0 0)", "#000000"],
  ])("%s is %s", (input, expected) => expect(hex(input)).toBe(expected));

  it.each(["red", "url(x.png)", "#ggg", "rgb(1,2)", "", "var(--x)", "oklch(0.5 0.1)"])(
    "rejects %j",
    (input) => expect(parseColor(input)).toBeUndefined(),
  );
});

describe("contrastRatio", () => {
  const white = parseColor("#fff")!;
  const black = parseColor("#000")!;

  it("matches the WCAG extremes", () => {
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
  });

  it("matches a known pair (#777 on white is about 4.48)", () => {
    expect(contrastRatio(parseColor("#777")!, white)).toBeCloseTo(4.48, 2);
  });

  it("composites translucent foregrounds over the background first", () => {
    const halfBlack = parseColor("#00000080")!;
    expect(toHex(composite(halfBlack, white))).toBe("#7f7f7f");
    expect(contrastRatio(halfBlack, white)).toBeLessThan(contrastRatio(black, white));
  });
});
