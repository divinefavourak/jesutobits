import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { deletePath, editFile, movePath, writeFile } from "./write-tools.js";
import { readFile } from "./read-tools.js";
import type { RiskAssessment, ToolResult } from "../common/types.js";
import {
  TURN_ID,
  classifyInput,
  openToolTestProject,
  type ToolTestProject,
} from "../../../test/tool-context.js";

let project: ToolTestProject;

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF8 = (text: string) => Buffer.from(text, "utf8");

beforeEach(async () => {
  project = await openToolTestProject({
    seed: ({ root }) => {
      const put = (relative: string, content: string | Buffer) => {
        const target = path.join(root, ...relative.split("/"));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
      };
      put("notes.md", "first\nsecond\n");
      put("shifted.md", "original\n");
      put("sequenced.txt", "seed\n");
      put("crlf.txt", "alpha\r\nbeta\r\ngamma\r\n");
      writeFileSync(path.join(root, "bom.txt"), Buffer.concat([BOM, UTF8("title\nline\n")]));
      put("indent.txt", "  alpha\nomega\n");
      put("duplicated.txt", "again and again\n");
      put("old-name.md", "the old body\n");
      put("existing.md", "already here\n");
      put("lib/nested/deep.ts", "export const deep = true;\n");
      put("lib/read-me.txt", "kept\n");
      writeFileSync(
        path.join(root, "precious.md"),
        Buffer.concat([BOM, UTF8("precious\r\nbytes\r\n")]),
      );
      put("trashed.md", "trash me\n");
      put("kept.md", "kept content\n");
      put("folder-fresh/f1.txt", "one\n");
      put("folder-fresh/f2.txt", "two\n");
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

const bytes = Buffer.from;

describe("write_file", () => {
  it("creates a file, and the folders it needs", async () => {
    const result = await project.run(writeFile, {
      path: "brand-new/deeper/file.md",
      content: "alpha\nbeta\n",
    });
    expect(result).toMatchObject({
      ok: true,
      modelText: "Created brand-new/deeper/file.md (+2 -0).",
    });
    expect(project.readBytes("brand-new/deeper/file.md").toString()).toBe("alpha\nbeta\n");
  });

  it("refuses to overwrite a file the session has not read", async () => {
    const error = errorOf(await project.run(writeFile, { path: "notes.md", content: "gone\n" }));
    expect(error.error.code).toBe("stale_read");
    expect(error.error.message).toContain("before changing it");
  });

  it("overwrites a file it has read", async () => {
    await project.run(readFile, { path: "notes.md" });
    const result = await project.run(writeFile, { path: "notes.md", content: "second draft\n" });
    expect(result).toMatchObject({
      ok: true,
      modelText: expect.stringContaining("Replaced notes.md"),
    });
    expect(project.readBytes("notes.md").toString()).toBe("second draft\n");
  });

  it("refuses after the file changed on disk since the read", async () => {
    await project.run(readFile, { path: "shifted.md" });
    await project.write("shifted.md", "the user edited it\n");
    const error = errorOf(
      await project.run(writeFile, { path: "shifted.md", content: "over it\n" }),
    );
    expect(error.error.code).toBe("stale_read");
    expect(error.error.message).toContain("changed since you last read it");
    expect(project.readBytes("shifted.md").toString()).toBe("the user edited it\n");
  });

  it("refuses createDirs: false over a missing folder", async () => {
    const error = errorOf(
      await project.run(writeFile, { path: "absent/here.md", content: "x", createDirs: false }),
    );
    expect(error.error.code).toBe("not_found");
  });

  it("records what it did so the turn can be reverted", async () => {
    await project.run(writeFile, { path: "created-by-tool.md", content: "new\nlines\n" });
    expect(project.checkpoints.changes(TURN_ID)).toEqual([
      { path: "created-by-tool.md", change: "created", added: 2, removed: 0 },
    ]);

    await project.run(readFile, { path: "notes.md" });
    await project.run(writeFile, { path: "notes.md", content: "first\nCHANGED\n" });
    expect(project.checkpoints.changes(TURN_ID)).toEqual([
      { path: "created-by-tool.md", change: "created", added: 2, removed: 0 },
      { path: "notes.md", change: "modified", added: 1, removed: 1 },
    ]);
  });
});

describe("edit_file", () => {
  it("applies exact edits in the given order", async () => {
    await project.run(readFile, { path: "sequenced.txt" });
    const result = await project.run(editFile, {
      path: "sequenced.txt",
      edits: [
        { oldText: "seed", newText: "grown seed" },
        { oldText: "grown seed", newText: "flower" },
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      modelText: expect.stringContaining("Edited sequenced.txt"),
    });
    expect(project.readBytes("sequenced.txt").toString()).toBe("flower\n");
  });

  it("keeps a CRLF file's line endings byte for byte", async () => {
    await project.run(readFile, { path: "crlf.txt" });
    const result = await project.run(editFile, {
      path: "crlf.txt",
      edits: [{ oldText: "beta", newText: "BETA\ndelta" }],
    });
    expect(result).toMatchObject({ ok: true });
    const written = project.readBytes("crlf.txt");
    expect(written.equals(bytes("alpha\r\nBETA\r\ndelta\r\ngamma\r\n"))).toBe(true);
  });

  it("keeps a UTF-8 BOM", async () => {
    await project.run(readFile, { path: "bom.txt" });
    const result = await project.run(editFile, {
      path: "bom.txt",
      edits: [{ oldText: "line", newText: "LINE" }],
    });
    expect(result).toMatchObject({ ok: true });
    const written = project.readBytes("bom.txt");
    expect(written.equals(Buffer.concat([BOM, bytes("title\nLINE\n")]))).toBe(true);
  });

  it("refuses oldText that is not in the file, with a hint when only whitespace differs", async () => {
    await project.run(readFile, { path: "indent.txt" });
    const error = errorOf(
      await project.run(editFile, {
        path: "indent.txt",
        edits: [{ oldText: "alpha\nbeta", newText: "joined" }],
      }),
    );
    expect(error.error.code).toBe("conflict");
    expect(error.error.message).toContain("oldText was not found");
    expect(error.error.message).toContain("Line 1 has the same text with different indentation");
    expect(error.error.message).toContain('"  alpha"');
  });

  it("refuses oldText not in the file at all", async () => {
    await project.run(readFile, { path: "indent.txt" });
    const error = errorOf(
      await project.run(editFile, {
        path: "indent.txt",
        edits: [{ oldText: "nowhere at all", newText: "joined" }],
      }),
    );
    expect(error.error.code).toBe("conflict");
    expect(error.error.message).toContain("oldText was not found");
  });

  it("refuses oldText found too many times for expectedOccurrences", async () => {
    await project.run(readFile, { path: "duplicated.txt" });
    const error = errorOf(
      await project.run(editFile, {
        path: "duplicated.txt",
        edits: [{ oldText: "again", newText: "once" }],
      }),
    );
    expect(error.error.code).toBe("conflict");
    expect(error.error.message).toContain("oldText was found 2 times, not 1");
  });

  it("requires a read of the file in this session", async () => {
    const error = errorOf(
      await project.run(editFile, {
        path: "notes.md",
        edits: [{ oldText: "first", newText: "FIRST" }],
      }),
    );
    expect(error.error.code).toBe("stale_read");
  });

  it("returns a unified diff in the model text", async () => {
    await project.run(readFile, { path: "notes.md" });
    const text = textOf(
      await project.run(editFile, {
        path: "notes.md",
        edits: [{ oldText: "second", newText: "SECOND" }],
      }),
    );
    expect(text).toContain("--- a/notes.md");
    expect(text).toContain("+++ b/notes.md");
    expect(text).toContain("@@");
    expect(text).toContain("-second");
    expect(text).toContain("+SECOND");
  });

  it("shows the card a diff of the change and the rule a session allow would add", async () => {
    const assessment = await classifyInput(
      editFile,
      { path: "notes.md", edits: [{ oldText: "first", newText: "FIRST" }] },
      project.ctx,
    );
    expect(assessment.classes).toEqual(["write"]);
    expect(assessment.sessionRule?.match).toEqual({ tool: "edit_file" });
    expect(assessment.sessionRule?.description).toContain("edit_file");
    expect(assessment.diff).toContain("+FIRST");
    expect(assessment.diff).toContain("-first");
  });
});

describe("move_path", () => {
  it("moves a file and the session's read follows it", async () => {
    await project.run(readFile, { path: "old-name.md" });
    const seen = project.ctx.reads.get("old-name.md");

    const result = await project.run(movePath, { from: "old-name.md", to: "renamed.md" });
    expect(result).toMatchObject({ ok: true, modelText: "Moved old-name.md to renamed.md." });
    expect(existsSync(path.join(project.root, "old-name.md"))).toBe(false);
    expect(project.readBytes("renamed.md").toString()).toBe("the old body\n");
    expect(project.ctx.reads.get("renamed.md")).toBe(seen);
    expect(project.ctx.reads.get("old-name.md")).toBeUndefined();
  });

  it("moves a folder with its files", async () => {
    const before = await project.workspace.readText("lib/read-me.txt");
    await project.run(readFile, { path: "lib/read-me.txt" });

    const result = await project.run(movePath, { from: "lib", to: "sources" });
    expect(result).toMatchObject({ ok: true, modelText: expect.stringContaining("(2 files)") });
    expect(existsSync(path.join(project.root, "lib"))).toBe(false);
    expect(project.readBytes("sources/read-me.txt").toString()).toBe("kept\n");
    expect(project.ctx.reads.get("sources/read-me.txt")).toBe(before.hash);
  });

  it("refuses an existing target", async () => {
    const error = errorOf(await project.run(movePath, { from: "notes.md", to: "existing.md" }));
    expect(error.error.code).toBe("conflict");
    expect(project.readBytes("existing.md").toString()).toBe("already here\n");
  });

  it("leaves everything the checkpoints need to undo the move", async () => {
    await project.run(movePath, { from: "old-name.md", to: "renamed.md" });
    const outcome = await project.checkpoints.revert(project.workspace, TURN_ID);
    expect(outcome.restored.sort()).toEqual(["old-name.md", "renamed.md"]);
    expect(outcome.conflicts).toEqual([]);
    expect(project.readBytes("old-name.md").toString()).toBe("the old body\n");
    expect(existsSync(path.join(project.root, "renamed.md"))).toBe(false);
  });
});

describe("delete_path", () => {
  it("deletes a file", async () => {
    const result = await project.run(deletePath, { path: "trashed.md" });
    expect(result).toMatchObject({
      ok: true,
      modelText: expect.stringContaining("Deleted trashed.md"),
    });
    expect(existsSync(path.join(project.root, "trashed.md"))).toBe(false);
  });

  it("refuses a non-empty folder without recursive", async () => {
    const error = errorOf(await project.run(deletePath, { path: "folder-fresh" }));
    expect(error.error.code).toBe("conflict");
    expect(error.error.message).toContain("recursive");
    expect(existsSync(path.join(project.root, "folder-fresh/f1.txt"))).toBe(true);
  });

  it("deletes a folder with recursive", async () => {
    const result = await project.run(deletePath, { path: "folder-fresh", recursive: true });
    expect(result).toMatchObject({
      ok: true,
      modelText: expect.stringContaining("(2 files)"),
    });
    expect(existsSync(path.join(project.root, "folder-fresh"))).toBe(false);
  });

  it("classes a deletion destructive, with a session rule for the path", async () => {
    const assessment = await classifyInput(deletePath, { path: "notes.md" }, project.ctx);
    expect(assessment.classes).toEqual(["write", "destructive"]);
    expect(assessment.sessionRule).toEqual({
      match: { tool: "delete_path", paths: ["notes.md"] },
      description: "delete_path: delete notes.md again in this session",
    });
  });

  it("restores deleted files byte for byte on revert", async () => {
    await project.run(deletePath, { path: "precious.md" });
    const outcome = await project.checkpoints.revert(project.workspace, TURN_ID);
    expect(outcome).toEqual({ restored: ["precious.md"], conflicts: [] });
    expect(
      project.readBytes("precious.md").equals(Buffer.concat([BOM, bytes("precious\r\nbytes\r\n")])),
    ).toBe(true);
  });
});

describe("write tools refuse paths outside the project", () => {
  it("every write tool marks '../x'", async () => {
    const writes: Promise<RiskAssessment>[] = [
      classifyInput(writeFile, { path: "../x", content: "why not" }, project.ctx),
      classifyInput(
        editFile,
        { path: "../x", edits: [{ oldText: "a", newText: "b" }] },
        project.ctx,
      ),
      classifyInput(movePath, { from: "../x", to: "renamed.md" }, project.ctx),
      classifyInput(deletePath, { path: "../x" }, project.ctx),
    ];
    for (const assessment of await Promise.all(writes)) {
      expect(assessment.classes).toContain("outside_workspace");
    }
  });
});
