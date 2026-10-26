import { describe, expect, it } from "vitest";
import { decide, policyColumn } from "./policy.js";

/**
 * SECURITY.md section 4.2's matrix, written out here by hand so the test reads the document
 * rather than the code. Autonomous `execute` says "allow for check commands and dev servers
 * approved once in this project; otherwise ask", which is `ask`: project rules (Phase 3) do
 * the allowing.
 */
type Column = "cautious" | "balanced" | "autonomous" | "restricted";
type Outcome = "allow" | "ask" | "deny";
type Risk =
  | "read"
  | "sensitive_read"
  | "write"
  | "destructive"
  | "execute"
  | "network"
  | "vcs"
  | "external"
  | "outside_workspace";

const MATRIX: Record<Risk, Record<Column, Outcome>> = {
  read: { cautious: "allow", balanced: "allow", autonomous: "allow", restricted: "allow" },
  sensitive_read: {
    cautious: "ask",
    balanced: "ask",
    autonomous: "ask",
    restricted: "ask",
  },
  write: { cautious: "ask", balanced: "allow", autonomous: "allow", restricted: "ask" },
  destructive: { cautious: "ask", balanced: "ask", autonomous: "ask", restricted: "ask" },
  execute: { cautious: "ask", balanced: "ask", autonomous: "ask", restricted: "deny" },
  network: { cautious: "ask", balanced: "ask", autonomous: "ask", restricted: "deny" },
  vcs: { cautious: "ask", balanced: "ask", autonomous: "allow", restricted: "deny" },
  external: { cautious: "ask", balanced: "ask", autonomous: "ask", restricted: "deny" },
  outside_workspace: {
    cautious: "deny",
    balanced: "deny",
    autonomous: "deny",
    restricted: "deny",
  },
};

const COLUMNS = ["cautious", "balanced", "autonomous", "restricted"] as const;

const REASONS: Record<Risk, string> = {
  read: "Reads files in the project.",
  sensitive_read: "Reads a file that may contain secrets.",
  write: "Changes files in the project. Jesutobits keeps a copy so the change can be reverted.",
  destructive: "Deletes files.",
  execute: "Runs code on your computer with your permissions.",
  network: "Uses the network.",
  vcs: "Changes Git history.",
  external: "Uses a tool from an extension.",
  outside_workspace: "Touches files outside the project.",
};

describe("decide", () => {
  it("matches SECURITY.md section 4.2 cell for cell", () => {
    for (const column of COLUMNS) {
      for (const risk of Object.keys(MATRIX) as Risk[]) {
        expect(decide([risk], column).outcome, `${risk} under ${column}`).toBe(
          MATRIX[risk][column],
        );
      }
    }
  });

  it("allows a call with no risk classes and gives no reasons", () => {
    expect(decide([], "balanced")).toEqual({ outcome: "allow", reasons: [] });
  });

  it("takes the strictest class: read plus write asks under cautious", () => {
    expect(decide(["read", "write"], "cautious")).toEqual({
      outcome: "ask",
      reasons: [REASONS.write],
    });
  });

  it("lists the reason of every class that produced the outcome, in class order", () => {
    // Write is allowed under balanced, so only sensitive_read produced the ask.
    expect(decide(["sensitive_read", "write"], "balanced")).toEqual({
      outcome: "ask",
      reasons: [REASONS.sensitive_read],
    });
    expect(decide(["network", "vcs", "external"], "autonomous")).toEqual({
      outcome: "ask",
      reasons: [REASONS.network, REASONS.external],
    });
  });

  it("denies outside_workspace next to a write under every column", () => {
    for (const column of ["cautious", "balanced", "autonomous", "restricted"] as const) {
      expect(decide(["write", "outside_workspace"], column).outcome).toBe("deny");
    }
  });

  it("gives deny reasons only for the classes that denied", () => {
    expect(decide(["write", "outside_workspace"], "cautious")).toEqual({
      outcome: "deny",
      reasons: [REASONS.outside_workspace],
    });
    expect(decide(["read", "outside_workspace"], "balanced")).toEqual({
      outcome: "deny",
      reasons: [REASONS.outside_workspace],
    });
  });

  it("names each producing class once", () => {
    expect(decide(["read", "read", "write"], "cautious")).toEqual({
      outcome: "ask",
      reasons: [REASONS.write],
    });
  });
});

describe("policyColumn", () => {
  it("evaluates untrusted projects with the restricted column", () => {
    for (const preset of ["cautious", "balanced", "autonomous"] as const) {
      expect(policyColumn(preset, false)).toBe("restricted");
      expect(policyColumn(preset, true)).toBe(preset);
    }
  });
});
