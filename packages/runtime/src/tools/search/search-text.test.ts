import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { searchText } from "./search-text.js";
import type { ToolResult } from "../common/types.js";
import { openToolTestProject, type ToolTestProject } from "../../../test/tool-context.js";

let project: ToolTestProject;

beforeEach(async () => {
  project = await openToolTestProject({
    seed: ({ root }) => {
      const put = (relative: string, content: string) => {
        const target = path.join(root, ...relative.split("/"));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
      };
      put(
        "src/lib/date.ts",
        "export function formatWeek(when: Date): string {\n  return 'w';\n}\n",
      );
      put("src/lib/units.ts", "export const FormatWeek = 1;\n");
      put("lib/notes.md", "Some prose about formatweek in lower case.\n");
      put("digits.txt", "ID 155 then words\n");
      put("node_modules/pkg/index.ts", "only in node_modules\n");
    },
  });
});

/** The model text of a call the test expects to succeed. */
function textOf(result: ToolResult): string {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`unexpected failure: ${result.modelText}`);
  return result.modelText;
}

/** The error of a call the test expects to fail, throwing when it succeeded. */
function errorOf(result: ToolResult): ToolResult & { ok: false } {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unexpected success");
  return result;
}

describe("search_text", () => {
  it("reports every match as path:line:column with the line", async () => {
    const result = await project.run(searchText, { query: "formatweek" });
    expect(result).toMatchObject({ ok: true, outputPreview: "3 matches" });
    expect(textOf(result).split("\n")).toEqual([
      "lib/notes.md:1:18: Some prose about formatweek in lower case.",
      "src/lib/date.ts:1:17: export function formatWeek(when: Date): string {",
      "src/lib/units.ts:1:14: export const FormatWeek = 1;",
    ]);
  });

  it("is case-sensitive only when asked", async () => {
    expect(
      textOf(await project.run(searchText, { query: "formatWeek", caseSensitive: true })),
    ).toBe("src/lib/date.ts:1:17: export function formatWeek(when: Date): string {");
  });

  it("honours a regular expression with its column", async () => {
    expect(textOf(await project.run(searchText, { query: "\\d{3}", isRegex: true }))).toBe(
      "digits.txt:1:4: ID 155 then words",
    );
  });

  it("reports an invalid regex as invalid_input", async () => {
    const error = errorOf(await project.run(searchText, { query: "([unclosed", isRegex: true }));
    expect(error.error.code).toBe("invalid_input");
  });

  it("keeps the glob's folder in and the rest out", async () => {
    const text = textOf(await project.run(searchText, { query: "formatweek", glob: "lib/**" }));
    expect(text).toBe("lib/notes.md:1:18: Some prose about formatweek in lower case.");
  });

  it("cuts the results at the limit and says so", async () => {
    const result = await project.run(searchText, { query: "formatweek", limit: 1 });
    expect(result).toMatchObject({ ok: true, outputPreview: "1+ matches" });
    const text = textOf(result);
    expect(text.startsWith("lib/notes.md:1:18:")).toBe(true);
    expect(text).toContain("More matches exist than the 1 shown; narrow the query or the glob.");
  });

  it("never looks inside ignored folders", async () => {
    expect(textOf(await project.run(searchText, { query: "only in node_modules" }))).toBe(
      "No matches.",
    );
  });

  it("says when nothing matches", async () => {
    const result = await project.run(searchText, { query: "zebra" });
    expect(result).toMatchObject({
      ok: true,
      modelText: "No matches.",
      outputPreview: "0 matches",
    });
  });
});
