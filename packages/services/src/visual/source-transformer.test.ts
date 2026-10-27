import { describe, expect, it } from "vitest";
import { applyClassEdit, parseLoc } from "./source-transformer.js";

const hero = [
  "export function Hero() {",
  "  return (",
  '    <section className="py-24 text-center">',
  '      <h1 className="text-4xl font-bold">Track habits</h1>',
  "      <p>No classes</p>",
  '      <status-badge class="text-xs">New</status-badge>',
  '      <div className={cn("p-4", active && "bg-x")} />',
  "      <span className={`mt-2 block`} />",
  "    </section>",
  "  );",
  "}",
].join("\n");

const edit = (line: number, column: number, remove: string[], add: string[], code = hero) =>
  applyClassEdit(code, { typescript: true, loc: { line, column }, edit: { remove, add } });

/** Lines that differ between two versions: the "minimal diff" acceptance check. */
const changedLines = (a: string, b: string) => {
  const before = a.split("\n");
  return b.split("\n").filter((line, i) => line !== before[i]);
};

describe("applyClassEdit", () => {
  it("swaps one class in place and changes nothing else", () => {
    const result = edit(4, 7, ["text-4xl"], ["text-6xl"]);
    expect(changedLines(hero, result.code)).toEqual([
      '      <h1 className="text-6xl font-bold">Track habits</h1>',
    ]);
    expect(result.loc).toEqual({ line: 4, column: 7 });
  });

  it("adds a className where there is none", () => {
    expect(changedLines(hero, edit(5, 7, [], ["mt-4"]).code)).toEqual([
      '      <p className="mt-4">No classes</p>',
    ]);
  });

  it("uses class on custom elements", () => {
    expect(changedLines(hero, edit(6, 7, ["text-xs"], ["text-sm"]).code)).toEqual([
      '      <status-badge class="text-sm">New</status-badge>',
    ]);
  });

  it("edits a static template literal", () => {
    expect(changedLines(hero, edit(8, 7, ["block"], ["flex"]).code)).toEqual([
      "      <span className={`mt-2 flex`} />",
    ]);
  });

  it("refuses a computed className", () => {
    expect(() => edit(7, 7, [], ["p-8"])).toThrow(
      expect.objectContaining({ code: "visual.not_editable" }),
    );
  });

  it("refuses a location where no element starts", () => {
    expect(() => edit(4, 8, [], ["x"])).toThrow(
      expect.objectContaining({ code: "visual.element_not_found" }),
    );
  });

  it("preserves CRLF line endings", () => {
    const crlf = hero.split("\n").join("\r\n");
    const result = edit(4, 7, ["text-4xl"], ["text-6xl"], crlf);
    expect(result.code.split("\r\n")).toHaveLength(crlf.split("\r\n").length);
    expect(result.code).not.toMatch(/[^\r]\n/);
  });
});

describe("parseLoc", () => {
  it("splits path, line and column, allowing colons in the path", () => {
    expect(parseLoc("C:/x/src/Hero.tsx:24:7")).toEqual({
      file: "C:/x/src/Hero.tsx",
      loc: { line: 24, column: 7 },
    });
  });

  it("rejects malformed locations", () => {
    expect(() => parseLoc("src/Hero.tsx")).toThrow(
      expect.objectContaining({ code: "visual.element_not_found" }),
    );
  });
});
