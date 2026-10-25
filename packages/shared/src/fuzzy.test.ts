import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "./fuzzy.js";

const rank = (query: string, paths: string[]) =>
  fuzzyFilter(query, paths, (path) => path, paths.length).map((result) => result.item);

describe("fuzzyMatch", () => {
  it("matches subsequences, ignoring case", () => {
    expect(fuzzyMatch("btn", "src/components/Button.tsx")).toBeDefined();
    expect(fuzzyMatch("BUTTON", "src/components/Button.tsx")).toBeDefined();
    expect(fuzzyMatch("xyz", "src/components/Button.tsx")).toBeUndefined();
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
  });

  it("reports the matched positions for highlighting", () => {
    const match = fuzzyMatch("app", "src/App.tsx");
    expect(match?.positions).toEqual([4, 5, 6]);
  });

  it("prefers word starts over letters inside words", () => {
    // "uc" should hit UserCard's U and C, not "u" in "src".
    const match = fuzzyMatch("uc", "src/UserCard.tsx");
    expect(match?.positions).toEqual([4, 8]);
  });
});

describe("fuzzyFilter ranking", () => {
  it("puts the exact file name first", () => {
    expect(
      rank("button", [
        "src/components/ButtonGroup.tsx",
        "src/lib/but-only.ts",
        "src/components/Button.tsx",
      ])[0],
    ).toBe("src/components/Button.tsx");
  });

  it("prefers matches in the file name over matches spread across folders", () => {
    expect(rank("index", ["packages/x/in/dex.ts", "packages/x/index.ts"])).toEqual([
      "packages/x/index.ts",
      "packages/x/in/dex.ts",
    ]);
  });

  it("prefers word-start matches", () => {
    expect(rank("wsv", ["src/news/view.ts", "src/workspace-service.ts"])[0]).toBe(
      "src/workspace-service.ts",
    );
  });

  it("prefers shorter paths among equals and keeps input order for ties", () => {
    expect(rank("a", ["deep/nested/a.ts", "a.ts"])).toEqual(["a.ts", "deep/nested/a.ts"]);
    expect(rank("", ["b", "a"])).toEqual(["b", "a"]);
  });

  it("limits the results", () => {
    expect(fuzzyFilter("a", ["a1", "a2", "a3"], (x) => x, 2)).toHaveLength(2);
  });
});
