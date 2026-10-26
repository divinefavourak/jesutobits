import { beforeEach, describe, expect, it } from "vitest";
import { askUser, updatePlan } from "./interaction-tools.js";
import type { ToolResult } from "../common/types.js";
import { openToolTestProject, type ToolTestProject } from "../../../test/tool-context.js";

let project: ToolTestProject;

beforeEach(async () => {
  project = await openToolTestProject();
});

function errorOf(result: ToolResult): ToolResult & { ok: false } {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unexpected success");
  return result;
}

describe("update_plan", () => {
  it("passes the items to the harness", async () => {
    const result = await project.run(updatePlan, {
      items: [
        { id: "read", text: "Read the controller", status: "done" },
        { id: "change", text: "Change the field name", status: "in_progress" },
        { id: "verify", text: "Run the tests", status: "pending" },
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      modelText: "Plan updated: 1 of 3 done.",
      outputPreview: "3 steps",
    });
    expect(project.plans).toEqual([
      [
        { id: "read", text: "Read the controller", status: "done" },
        { id: "change", text: "Change the field name", status: "in_progress" },
        { id: "verify", text: "Run the tests", status: "pending" },
      ],
    ]);
  });

  it("refuses duplicate item ids", async () => {
    const error = errorOf(
      await project.run(updatePlan, {
        items: [
          { id: "same", text: "First", status: "pending" },
          { id: "same", text: "Second", status: "done" },
        ],
      }),
    );
    expect(error.error.code).toBe("invalid_input");
    expect(error.error.message).toContain("unique");
    expect(project.plans).toEqual([]);
  });
});

describe("ask_user", () => {
  it("asks the harness and hands the question id back", async () => {
    const result = await project.run(askUser, {
      question: "Which database should the README show?",
      options: ["SQLite", "Postgres"],
    });
    expect(result).toMatchObject({
      ok: true,
      modelText: "",
      awaitUser: { questionId: "q_1" },
    });
    expect(project.questions).toEqual([
      {
        id: "q_1",
        question: "Which database should the README show?",
        options: ["SQLite", "Postgres"],
      },
    ]);
  });

  it("numbers each question", async () => {
    const first = await project.run(askUser, { question: "First?" });
    const second = await project.run(askUser, { question: "Second?" });
    expect(first).toMatchObject({ awaitUser: { questionId: "q_1" } });
    expect(second).toMatchObject({ awaitUser: { questionId: "q_2" } });
  });
});
