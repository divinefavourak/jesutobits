import { describe, expect, it } from "vitest";
import { countLineChanges, unifiedDiff } from "./diff.js";

const lines = (count: number): string =>
  Array.from({ length: count }, (_, i) => `l${i + 1}`).join("\n");

describe("countLineChanges", () => {
  it("returns zero for equal texts", () => {
    expect(countLineChanges("a\nb\n", "a\nb\n")).toEqual({ added: 0, removed: 0 });
    expect(countLineChanges("", "")).toEqual({ added: 0, removed: 0 });
  });

  it("counts a pure insertion", () => {
    expect(countLineChanges("a\n", "a\nb\n")).toEqual({ added: 1, removed: 0 });
  });

  it("counts a pure deletion", () => {
    expect(countLineChanges("a\nb\n", "a\n")).toEqual({ added: 0, removed: 1 });
  });

  it("counts a replaced line as one removed and one added", () => {
    expect(countLineChanges("a\nb\nc\n", "a\nB\nc\n")).toEqual({ added: 1, removed: 1 });
  });

  it("counts several separate edits", () => {
    expect(
      countLineChanges("one\ntwo\nthree\nfour\nfive\n", "one\ntwo\nTHREE\nfour\nFIVE\nsix\n"),
    ).toEqual({
      added: 3,
      removed: 2,
    });
  });

  it("treats an empty before as all added", () => {
    expect(countLineChanges("", "x\ny\n")).toEqual({ added: 2, removed: 0 });
  });

  it("treats an empty after as all removed", () => {
    expect(countLineChanges("x\ny\n", "")).toEqual({ added: 0, removed: 2 });
  });

  it("counts a final-newline-only difference as a changed last line", () => {
    expect(countLineChanges("a\nb\n", "a\nb")).toEqual({ added: 1, removed: 1 });
    expect(countLineChanges("a\nb", "a\nb\n")).toEqual({ added: 1, removed: 1 });
  });

  it("treats a trailing carriage return as part of the line", () => {
    expect(countLineChanges("a\r\n", "a\n")).toEqual({ added: 1, removed: 1 });
  });
});

describe("unifiedDiff", () => {
  it("returns an empty string for equal texts", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n")).toBe("");
  });

  it("shows one changed line in the middle with context 3", () => {
    const after = lines(10).split("\n");
    after[4] = "L5";
    expect(unifiedDiff(lines(10), after.join("\n"))).toBe(
      [
        "--- before",
        "+++ after",
        "@@ -2,7 +2,7 @@",
        " l2",
        " l3",
        " l4",
        "-l5",
        "+L5",
        " l6",
        " l7",
        " l8",
      ].join("\n"),
    );
  });

  it("gives two hunks for changes far apart", () => {
    const after = lines(10).split("\n");
    after[1] = "X2";
    after[8] = "X9";
    expect(unifiedDiff(lines(10), after.join("\n"), { context: 2 })).toBe(
      [
        "--- before",
        "+++ after",
        "@@ -1,4 +1,4 @@",
        " l1",
        "-l2",
        "+X2",
        " l3",
        " l4",
        "@@ -7,4 +7,4 @@",
        " l7",
        " l8",
        "-l9",
        "+X9",
        " l10",
        // lines() has no final newline, and GNU diff marks the context line too.
        "\\ No newline at end of file",
      ].join("\n"),
    );
  });

  it("merges close changes into one hunk", () => {
    const after = lines(10).split("\n");
    after[2] = "X3";
    after[5] = "X6";
    expect(unifiedDiff(lines(10), after.join("\n"), { context: 2 })).toBe(
      [
        "--- before",
        "+++ after",
        "@@ -1,8 +1,8 @@",
        " l1",
        " l2",
        "-l3",
        "+X3",
        " l4",
        " l5",
        "-l6",
        "+X6",
        " l7",
        " l8",
      ].join("\n"),
    );
  });

  it("shows an insertion at the start", () => {
    expect(unifiedDiff("a\nb\n", "X\na\nb\n")).toBe(
      ["--- before", "+++ after", "@@ -1,2 +1,3 @@", "+X", " a", " b"].join("\n"),
    );
  });

  it("shows a deletion at the end", () => {
    expect(unifiedDiff("a\nb\nc\n", "a\n")).toBe(
      ["--- before", "+++ after", "@@ -1,3 +1 @@", " a", "-b", "-c"].join("\n"),
    );
  });

  it("shows every line as added when the before text is empty", () => {
    expect(unifiedDiff("", "x\ny\nz\n")).toBe(
      ["--- before", "+++ after", "@@ -0,0 +1,3 @@", "+x", "+y", "+z"].join("\n"),
    );
  });

  it("marks a missing final newline", () => {
    expect(unifiedDiff("a\nb\n", "a\nb")).toBe(
      [
        "--- before",
        "+++ after",
        "@@ -1,2 +1,2 @@",
        " a",
        "-b",
        "+b",
        "\\ No newline at end of file",
      ].join("\n"),
    );
    expect(unifiedDiff("a\nb", "a\nb\n")).toBe(
      [
        "--- before",
        "+++ after",
        "@@ -1,2 +1,2 @@",
        " a",
        "-b",
        "\\ No newline at end of file",
        "+b",
      ].join("\n"),
    );
  });

  it("uses the given header names", () => {
    expect(
      unifiedDiff("a\n", "b\n", { fromName: "a/old.txt", toName: "b/new.txt" })
        .split("\n")
        .slice(0, 2),
    ).toEqual(["--- a/old.txt", "+++ b/new.txt"]);
  });

  it("shortens the output when it would exceed maxChars", () => {
    const after = lines(10).split("\n");
    after[4] = "L5";
    const full = unifiedDiff(lines(10), after.join("\n"));
    expect(full).not.toContain("... (diff shortened)");
    const shortened = unifiedDiff(lines(10), after.join("\n"), { maxChars: 42 });
    expect(shortened).toBe("--- before\n+++ after\n@@ -2,7 +2,7 @@\n l2\n... (diff shortened)");
    expect(shortened.endsWith("... (diff shortened)")).toBe(true);
  });
});

describe("diff performance", () => {
  it("handles a 5,000-line text with a few edits", () => {
    const before = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[100] = "line 100 changed";
    after[2500] = "line 2500 changed";
    after[4999] = "line 4999 changed";
    expect(countLineChanges(before.join("\n"), after.join("\n"))).toEqual({ added: 3, removed: 3 });
    expect(unifiedDiff(before.join("\n"), after.join("\n"))).toContain("@@ -98,7 +98,7 @@");
  });
});

describe("diff limits and markers", () => {
  it("treats two large, wholly different texts as all removed and all added", () => {
    const before = Array.from({ length: 6000 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 6000 }, (_, i) => `new ${i}`).join("\n");
    const started = performance.now();
    expect(countLineChanges(before, after)).toEqual({ added: 6000, removed: 6000 });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("marks a context line that has no final newline", () => {
    expect(unifiedDiff("a\nb\nc", "A\nb\nc")).toBe(
      [
        "--- before",
        "+++ after",
        "@@ -1,3 +1,3 @@",
        "-a",
        "+A",
        " b",
        " c",
        "\\ No newline at end of file",
      ].join("\n"),
    );
  });
});
