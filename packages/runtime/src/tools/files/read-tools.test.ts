import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { listDirectory, readFile, searchFiles } from "./read-tools.js";
import type { ToolResult } from "../common/types.js";
import {
  classifyInput,
  openToolTestProject,
  type ToolTestProject,
} from "../../../test/tool-context.js";

let project: ToolTestProject;

beforeEach(async () => {
  project = await openToolTestProject({
    seed: ({ root }) => {
      const put = (relative: string, content: string | Buffer) => {
        const target = path.join(root, ...relative.split("/"));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
      };
      put("src/a.ts", "export const a = 1;\n");
      put("src/components/App.tsx", "export function App() {\n  return null;\n}\n");
      put("src/deep/b.ts", "export const b = 2;\n");
      put("lib/nested/c.ts", "export const c = 3;\n");
      put("three.txt", "abc");
      put("notes.md", "jo\n");
      put(
        "many-lines.txt",
        `${Array.from({ length: 500 }, (_, index) => `line ${String(index + 1).padStart(4, "0")}`).join("\n")}\n`,
      );
      put(".env", "TOKEN=s3cret-value\nNOTE=plain\n");
      put(".npmrc", "registry=https://registry.npmjs.org/\n");
      put("sub/.npmrc", "_authToken=abc123\n");
      put("internal-data/keys.txt", "kept private\n");
      put("node_modules/pkg/index.ts", "export const pkg = 1;\n");
      put("binary.bin", Buffer.from([0x00, 0x01, 0x02, 0xff]));
      put("large.txt", "a".repeat(2 * 1024 * 1024 + 17));
      mkdirSync(path.join(root, "empty-folder"));
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

const SIZE = (relative: string) =>
  readFileSync(path.join(project.root, ...relative.split("/"))).length;

describe("list_directory", () => {
  it("lists one level with folders first, files after, and sizes", async () => {
    const text = textOf(await project.run(listDirectory, { path: "src" }));
    expect(text).toBe(`components/\ndeep/\na.ts (${SIZE("src/a.ts")} bytes)`);
  });

  it("indents nested entries at depth two", async () => {
    const text = textOf(await project.run(listDirectory, { path: "src", depth: 2 }));
    expect(text).toBe(
      `components/\n  App.tsx (${SIZE("src/components/App.tsx")} bytes)` +
        `\ndeep/\n  b.ts (${SIZE("src/deep/b.ts")} bytes)` +
        `\na.ts (${SIZE("src/a.ts")} bytes)`,
    );
  });

  it("collapses ignored folders and leaves them alone unless includeIgnored", async () => {
    // Everything under node_modules matches the built-in ignore rule, so pkg is
    // flagged ignored even inside node_modules and is not entered without the flag.
    const collapsed = textOf(await project.run(listDirectory, { path: "node_modules", depth: 2 }));
    expect(collapsed).toBe("pkg/ (ignored, not listed)");

    const entered = textOf(
      await project.run(listDirectory, { path: "node_modules", depth: 2, includeIgnored: true }),
    );
    expect(entered).toBe(
      `pkg/ (ignored, not listed)\n  index.ts (${SIZE("node_modules/pkg/index.ts")} bytes)`,
    );
  });

  it("says when a folder is empty", async () => {
    expect(textOf(await project.run(listDirectory, { path: "empty-folder" }))).toBe(
      "(empty folder)",
    );
  });

  it("shows sizes from the file system", async () => {
    const text = textOf(await project.run(listDirectory, { path: "." }));
    expect(text).toContain("three.txt (3 bytes)");
  });
});

describe("read_file", () => {
  it("numbers lines", async () => {
    const result = await project.run(readFile, { path: "notes.md" });
    expect(result).toMatchObject({
      ok: true,
      modelText: "1\tjo",
      outputPreview: "1 of 1 lines",
    });
  });

  it("shows the default 400-line window and says how to continue", async () => {
    const text = textOf(await project.run(readFile, { path: "many-lines.txt" }));
    expect(text.startsWith("  1\tline 0001\n  2\tline 0002\n")).toBe(true);
    expect(text).toContain("\n400\tline 0400");
    expect(text).not.toContain("\n401\t");
    expect(text).toContain("Showing lines 1-400 of 500. Call read_file with offset 401 for more.");
  });

  it("honours offset and limit, and stays silent when it reached the end", async () => {
    const text = textOf(
      await project.run(readFile, { path: "many-lines.txt", offset: 498, limit: 400 }),
    );
    expect(text.split("\n")).toEqual(["498\tline 0498", "499\tline 0499", "500\tline 0500"]);
    expect(text).not.toContain("Call read_file");
  });

  it("does not count a file's final newline as a line", async () => {
    expect(textOf(await project.run(readFile, { path: "three.txt" }))).toBe("1\tabc");
    expect(textOf(await project.run(readFile, { path: "three.txt" }))).not.toContain("2\t");
    expect(textOf(await project.run(readFile, { path: "notes.md" }))).toBe("1\tjo");
    expect(textOf(await project.run(readFile, { path: "notes.md" }))).not.toContain("2\t");
  });

  it("returns only the size of a binary file", async () => {
    const text = textOf(await project.run(readFile, { path: "binary.bin" }));
    expect(text).toContain("binary.bin is a binary file (4 bytes)");
    expect(text).not.toContain("0x");
  });

  it("refuses files over 2 MB with too_large", async () => {
    const error = errorOf(await project.run(readFile, { path: "large.txt" }));
    expect(error.error.code).toBe("too_large");
  });

  it("says not_found for a missing file", async () => {
    const error = errorOf(await project.run(readFile, { path: "missing.txt" }));
    expect(error.error.code).toBe("not_found");
  });

  it("records the file's hash as the session's last read", async () => {
    await project.run(readFile, { path: "notes.md" });
    const expected = await project.workspace.readText("notes.md");
    expect(project.ctx.reads.get("notes.md")).toBe(expected.hash);
  });

  it("hides .env values when the user asked to share them hidden", async () => {
    project.ctx.redactValues = true;
    const text = textOf(await project.run(readFile, { path: ".env" }));
    expect(text).toContain("TOKEN=***");
    expect(text).toContain("NOTE=***");
    expect(text).toContain("Values were hidden at the user's request; keys are shown.");
    expect(text).not.toContain("s3cret");
  });

  it("returns the redact hook's hidden count as hiddenSecrets", async () => {
    project.ctx.redact = (text) => ({ text, hidden: 3 });
    const result = await project.run(readFile, { path: "notes.md" });
    expect(result).toMatchObject({ ok: true, hiddenSecrets: 3 });
  });
});

describe("read_file classification", () => {
  it("classes an ordinary source file as a plain read", async () => {
    const assessment = await classifyInput(readFile, { path: "src/a.ts" }, project.ctx);
    expect(assessment.classes).toEqual(["read"]);
    expect(assessment.action).toEqual({ kind: "file", op: "read", paths: ["src/a.ts"] });
    expect(assessment.prohibited).toBeUndefined();
  });

  it("classes .env as a sensitive read", async () => {
    const assessment = await classifyInput(readFile, { path: ".env" }, project.ctx);
    expect(assessment.classes).toEqual(["read", "sensitive_read"]);
  });

  it("classes .npmrc without a token as a plain read", async () => {
    const assessment = await classifyInput(readFile, { path: ".npmrc" }, project.ctx);
    expect(assessment.classes).toEqual(["read"]);
  });

  it("classes .npmrc with an auth token as a sensitive read", async () => {
    const assessment = await classifyInput(readFile, { path: "sub/.npmrc" }, project.ctx);
    expect(assessment.classes).toEqual(["read", "sensitive_read"]);
  });

  it("marks reading outside the project", async () => {
    const assessment = await classifyInput(readFile, { path: "../outside.txt" }, project.ctx);
    expect(assessment.classes).toContain("outside_workspace");
  });

  it("marks a path inside the app data folder as prohibited", async () => {
    project.ctx.prohibited = {
      // A symlink-free folder of the project stands in for Jesutobits' own data dir.
      appDirs: [realpathSync.native(path.join(project.root, "internal-data"))],
      home: undefined,
    };
    const assessment = await classifyInput(
      readFile,
      { path: "internal-data/keys.txt" },
      project.ctx,
    );
    expect(assessment.prohibited).toBeDefined();
    expect(assessment.classes).toContain("read");
    expect(assessment.classes).not.toContain("outside_workspace");
  });
});

describe("search_files", () => {
  it("finds files by name at any depth, sorted, without ignored folders", async () => {
    const result = await project.run(searchFiles, { pattern: "*.ts" });
    expect(result).toMatchObject({ ok: true, outputPreview: "3 files" });
    expect(textOf(result).split("\n")).toEqual(["lib/nested/c.ts", "src/a.ts", "src/deep/b.ts"]);
    expect(textOf(result)).not.toContain("node_modules");
  });

  it("honours a folder glob", async () => {
    expect(textOf(await project.run(searchFiles, { pattern: "src/**/*.tsx" }))).toBe(
      "src/components/App.tsx",
    );
  });

  it("says when matches were cut by the limit", async () => {
    const text = textOf(await project.run(searchFiles, { pattern: "*.ts", limit: 1 }));
    expect(text.split("\n")).toEqual(["lib/nested/c.ts", "... 2 more; narrow the pattern"]);
  });

  it("says when nothing matches", async () => {
    expect(textOf(await project.run(searchFiles, { pattern: "no-such-*.xyz" }))).toBe(
      "No files match.",
    );
  });
});
