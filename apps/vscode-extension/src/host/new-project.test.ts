import { describe, expect, it } from "vitest";
import { projectFolderName, projectNameProblem } from "./new-project.js";

describe("new project names", () => {
  it("accepts ordinary names and tidies their spaces", () => {
    expect(projectNameProblem("Little habits")).toBeNull();
    expect(projectNameProblem("my-reading_list 2")).toBeNull();
    expect(projectFolderName("  Little   habits ")).toBe("Little habits");
  });

  it("refuses names that cannot be Windows folders", () => {
    for (const name of ["", "   ", "a/b", "a\\b", "what?", "C:", "con", "NUL.txt", "trailing."]) {
      expect(projectNameProblem(name), name).not.toBeNull();
    }
    expect(projectNameProblem("x".repeat(81))).not.toBeNull();
  });
});
