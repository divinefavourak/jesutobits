import { describe, expect, it } from "vitest";
import { globToRegExp, matchesGlob } from "./glob.js";

describe("matchesGlob", () => {
  it("matches a pattern without a slash at any depth", () => {
    expect(matchesGlob("a.ts", "*.ts")).toBe(true);
    expect(matchesGlob("src/a.ts", "*.ts")).toBe(true);
    expect(matchesGlob("a.tsx", "*.ts")).toBe(false);
  });

  it("keeps a single star within one segment", () => {
    expect(matchesGlob("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/x/a.ts", "src/*.ts")).toBe(false);
  });

  it("matches any number of folders with **", () => {
    expect(matchesGlob("src/a.ts", "src/**/*.ts")).toBe(true);
    expect(matchesGlob("src/x/y/a.ts", "src/**/*.ts")).toBe(true);
    expect(matchesGlob("a/test/b.ts", "**/test/**")).toBe(true);
  });

  it("matches exactly one character with ?", () => {
    expect(matchesGlob("a.md", "?.md")).toBe(true);
    expect(matchesGlob("ab.md", "?.md")).toBe(false);
  });

  it("expands brace alternatives", () => {
    expect(matchesGlob("a.ts", "*.{ts,tsx}")).toBe(true);
    expect(matchesGlob("a.tsx", "*.{ts,tsx}")).toBe(true);
    expect(matchesGlob("a.js", "*.{ts,tsx}")).toBe(false);
  });

  it("expands character sets", () => {
    expect(matchesGlob("a.txt", "[ab].txt")).toBe(true);
    expect(matchesGlob("b.txt", "[ab].txt")).toBe(true);
    expect(matchesGlob("c.txt", "[ab].txt")).toBe(false);
  });

  it("expands negated character sets", () => {
    expect(matchesGlob("b.txt", "[!a].txt")).toBe(true);
    expect(matchesGlob("a.txt", "[!a].txt")).toBe(false);
  });

  it("treats dots and parentheses as literals", () => {
    const pattern = "a.b(c).ts";
    expect(matchesGlob("a.b(c).ts", pattern)).toBe(true);
    expect(matchesGlob("aXb(c).ts", pattern)).toBe(false);
    expect(matchesGlob("a.bc.ts", pattern)).toBe(false);
    expect(matchesGlob("ab(c)ts", pattern)).toBe(false);
  });

  it("matches case-insensitively when asked", () => {
    expect(matchesGlob("A.TS", "*.ts")).toBe(false);
    expect(matchesGlob("SRC/A.TS", "src/*.ts", false)).toBe(true);
    expect(globToRegExp("A.TS", { caseSensitive: false }).test("a.ts")).toBe(true);
  });

  it("ignores a leading ./ or /", () => {
    expect(globToRegExp("./a.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("/src/a.ts").test("src/a.ts")).toBe(true);
  });
});
