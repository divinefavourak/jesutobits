import { runCommand as spawnCommand } from "@jesutobits/services";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "./run-command.js";
import { startPreview } from "./start-preview.js";
import {
  classifyInput,
  openToolTestProject,
  runTool,
  type ToolTestProject,
} from "../../../test/tool-context.js";

let project: ToolTestProject;

beforeEach(async () => {
  project = await openToolTestProject({ seed: ({ root }) => void root });
  project.write("sub/marker.txt", "here\n");
  project.ctx.runCommand = (argv, options) =>
    spawnCommand(argv, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
});

afterEach(() => project.dispose());

describe("run_command", () => {
  it("asks before running anything and shows the exact command", async () => {
    const assessment = await classifyInput(runCommand, { argv: ["npm", "test"] }, project.ctx);
    expect(assessment.classes).toEqual(["execute"]);
    expect(assessment.action).toEqual({
      kind: "command",
      argv: ["npm", "test"],
      cwd: ".",
      shell: false,
    });
    expect(runCommand.availability?.requiresTrust).toBe(true);
  });

  it("refuses a folder outside the project", async () => {
    const assessment = await classifyInput(
      runCommand,
      { argv: ["node", "-v"], cwd: "../elsewhere" },
      project.ctx,
    );
    expect(assessment.prohibited).toMatch(/outside the project/);
    const result = await runTool(runCommand, { argv: ["node", "-v"], cwd: ".." }, project.ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("outside_workspace");
  });

  it("returns the exit code and output, failing exits included", async () => {
    const ok = await runTool(
      runCommand,
      {
        argv: ["node", "-e", "console.log(require('fs').readFileSync('marker.txt','utf8'))"],
        cwd: "sub",
      },
      project.ctx,
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.modelText).toMatch(/^exit code 0 after/);
      expect(ok.modelText).toContain("here");
    }
    const failing = await runTool(
      runCommand,
      { argv: ["node", "-e", "console.error('broken'); process.exit(3)"] },
      project.ctx,
    );
    expect(failing.ok).toBe(true);
    if (failing.ok) {
      expect(failing.outputPreview).toBe("exit code 3");
      expect(failing.modelText).toContain("broken");
    }
  });

  it("masks secrets in the output", async () => {
    project.ctx.redact = (text) => ({
      text: text.replaceAll("sk-or-secret", "[REDACTED]"),
      hidden: 1,
    });
    const result = await runTool(
      runCommand,
      { argv: ["node", "-e", "console.log('key sk-or-secret')"] },
      project.ctx,
    );
    expect(result.ok && result.modelText).toContain("[REDACTED]");
    expect(result.ok && result.modelText).not.toContain("sk-or-secret");
    expect(result.ok && result.hiddenSecrets).toBe(1);
  });

  it("says when the program does not exist", async () => {
    const result = await runTool(runCommand, { argv: ["no-such-program-xyz"] }, project.ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("is not available without a command runner", async () => {
    delete project.ctx.runCommand;
    const result = await runTool(runCommand, { argv: ["node", "-v"] }, project.ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_supported");
  });
});

describe("start_preview", () => {
  it("returns the URL of a ready preview and mentions visual editing", async () => {
    project.ctx.startPreview = async () => ({
      state: "ready",
      strategy: "vite-react",
      url: "http://127.0.0.1:5173/",
      detail: null,
      log: [],
    });
    const result = await runTool(startPreview, {}, project.ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelText).toContain("http://127.0.0.1:5173/");
      expect(result.modelText).toContain("Visual editing is on");
    }
  });

  it("reports why the preview failed, with the last output", async () => {
    project.ctx.startPreview = async () => ({
      state: "failed",
      strategy: "generic",
      url: null,
      detail: "The dev server stopped (exit code 1).",
      log: ["Error: Cannot find module 'vite'"],
    });
    const result = await runTool(startPreview, {}, project.ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("process_failed");
      expect(result.modelText).toContain("Cannot find module 'vite'");
    }
  });
});
