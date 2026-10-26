import type { PolicyPreset, RiskClass } from "@jesutobits/protocol";

export type PolicyOutcome = "allow" | "ask" | "deny";

/** The column used for a call: the project's preset, or Restricted for untrusted projects. */
export type PolicyColumn = PolicyPreset | "restricted";

/**
 * SECURITY.md section 4.2, cell for cell. `execute` under Autonomous is "allow for check
 * commands and dev servers approved once in this project; otherwise ask": the matrix says
 * ask, and project rules (Phase 3) do the allowing.
 */
export const POLICY_MATRIX: Readonly<
  Record<PolicyColumn, Readonly<Record<RiskClass, PolicyOutcome>>>
> = {
  cautious: {
    read: "allow",
    sensitive_read: "ask",
    write: "ask",
    destructive: "ask",
    execute: "ask",
    network: "ask",
    vcs: "ask",
    external: "ask",
    outside_workspace: "deny",
  },
  balanced: {
    read: "allow",
    sensitive_read: "ask",
    write: "allow",
    destructive: "ask",
    execute: "ask",
    network: "ask",
    vcs: "ask",
    external: "ask",
    outside_workspace: "deny",
  },
  autonomous: {
    read: "allow",
    sensitive_read: "ask",
    write: "allow",
    destructive: "ask",
    execute: "ask",
    network: "ask",
    vcs: "allow",
    external: "ask",
    outside_workspace: "deny",
  },
  restricted: {
    read: "allow",
    sensitive_read: "ask",
    write: "ask",
    destructive: "ask",
    execute: "deny",
    network: "deny",
    vcs: "deny",
    external: "deny",
    outside_workspace: "deny",
  },
};

const STRICTNESS: Record<PolicyOutcome, number> = { allow: 0, ask: 1, deny: 2 };

/** Why the policy asks or denies, one plain sentence per class (shown on the card). */
const REASONS: Record<RiskClass, string> = {
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

export interface PolicyDecision {
  outcome: PolicyOutcome;
  /** The reasons of the classes that made it ask or deny. */
  reasons: string[];
}

/** The strictest outcome of the call's classes (deny > ask > allow). No classes: allow. */
export function decide(classes: readonly RiskClass[], column: PolicyColumn): PolicyDecision {
  let outcome: PolicyOutcome = "allow";
  for (const risk of classes) {
    const cell = POLICY_MATRIX[column][risk];
    if (STRICTNESS[cell] > STRICTNESS[outcome]) outcome = cell;
  }
  const reasons =
    outcome === "allow"
      ? []
      : [...new Set(classes)]
          .filter((risk) => POLICY_MATRIX[column][risk] === outcome)
          .map((risk) => REASONS[risk]);
  return { outcome, reasons };
}

export function policyColumn(preset: PolicyPreset, trusted: boolean): PolicyColumn {
  return trusted ? preset : "restricted";
}
