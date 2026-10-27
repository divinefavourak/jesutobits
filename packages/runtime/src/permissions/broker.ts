import { createHash } from "node:crypto";
import {
  ErrorCodes,
  JesutobitsError,
  type EventCorrelation,
  type EventPayload,
  type PermissionDecision,
  type PermissionRule,
} from "@jesutobits/protocol";
import { newId } from "@jesutobits/shared";
import type { Database } from "../storage/database.js";
import type { RiskAssessment, SessionRuleMatch } from "../tools/common/types.js";
import { decide, type PolicyColumn } from "./policy.js";

/**
 * Proof that the broker allowed one exact call (SECURITY.md section 4.5). Only this module
 * can make one; the ToolRunner checks it matches the call ID and input before executing.
 */
export interface Grant {
  readonly callId: string;
  /** SHA-256 of the canonical input JSON. */
  readonly inputHash: string;
  /** "Share with values hidden": the tool returns secret files with values masked. */
  readonly redactValues: boolean;
  readonly [GRANT]: true;
}
declare const GRANT: unique symbol;

export type BrokerDecision =
  | { kind: "grant"; grant: Grant; via: "policy" | "rule" | "user"; permissionId?: string }
  | {
      kind: "deny";
      /** Why, for the model and the timeline. */
      reason: string;
      /** Never allowed (SECURITY.md section 4.3), or denied by the preset without asking. */
      by: "prohibited" | "policy" | "user";
      userMessage?: string;
      permissionId?: string;
    };

export interface AuthorizeRequest {
  projectId: string;
  sessionId: string;
  turnId: string;
  callId: string;
  tool: string;
  input: unknown;
  assessment: RiskAssessment;
  /** The model's own words before the call; shown labelled as the agent's (FR-055). */
  agentExplanation?: string;
}

type Emit = <T extends "permission.requested" | "permission.resolved">(
  type: T,
  payload: EventPayload<T>,
  correlation: EventCorrelation,
) => void;

export interface BrokerOptions {
  db: Database;
  emit: Emit;
  /** The policy column for the active project: its preset, or Restricted when untrusted. */
  column(projectId: string): PolicyColumn;
  now?: () => Date;
}

interface Pending {
  turnId: string;
  options: readonly PermissionDecision[];
  resolve(answer: { decision: PermissionDecision; message?: string }): void;
}

interface RuleRow {
  id: string;
  scope: "session" | "project";
  session_id: string | null;
  tool: string;
  match_json: string;
  description: string;
  created_at: string;
}

/** Canonical JSON (sorted keys), so the same input always hashes the same. */
export function hashInput(input: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
      );
    }
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(input)))
    .digest("hex");
}

/**
 * The enforcement point for every tool call (invariant 1, SECURITY.md section 4). Decisions
 * come from the call's risk classes, the policy matrix, session rules and the user's
 * answers; nothing the model writes can change one. Answers are stored before the call they
 * allow runs, so a crash cannot turn an "ask" into a silent replay.
 */
export class PermissionBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly now: () => Date;

  constructor(private readonly options: BrokerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async authorize(request: AuthorizeRequest, signal: AbortSignal): Promise<BrokerDecision> {
    signal.throwIfAborted();
    const { assessment } = request;
    const correlation = {
      projectId: request.projectId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      callId: request.callId,
    };
    const grant = (redactValues = false): Grant =>
      Object.freeze({
        callId: request.callId,
        inputHash: hashInput(request.input),
        redactValues,
      }) as Grant;

    if (assessment.prohibited !== undefined) {
      return { kind: "deny", by: "prohibited", reason: assessment.prohibited };
    }
    const policy = decide(assessment.classes, this.options.column(request.projectId));
    if (policy.outcome === "deny") {
      return { kind: "deny", by: "policy", reason: policy.reasons.join(" ") };
    }
    if (policy.outcome === "allow") return { kind: "grant", grant: grant(), via: "policy" };

    // Session rules never cover secret files: each read asks (SECURITY.md section 6.2).
    const sensitive = assessment.classes.includes("sensitive_read");
    if (
      !sensitive &&
      assessment.sessionRule &&
      this.ruleMatches(request, assessment.sessionRule.match)
    ) {
      return { kind: "grant", grant: grant(), via: "rule" };
    }

    const offered: PermissionDecision[] = ["allow_once"];
    if (assessment.sessionRule && !sensitive) offered.push("allow_session");
    if (sensitive) offered.push("allow_redacted");
    offered.push("deny");

    const permissionId = newId("perm");
    const action = assessment.action ?? {
      kind: "file" as const,
      op: "read" as const,
      paths: ["(unknown)"],
    };
    // Stored before anyone can answer (SECURITY.md section 4.5).
    this.options.db.run(
      `INSERT INTO permission_requests (id, turn_id, call_id, action_json, risk_json, requested_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        permissionId,
        request.turnId,
        request.callId,
        JSON.stringify(action),
        JSON.stringify(assessment.classes),
        this.now().toISOString(),
      ],
    );

    const answer = await new Promise<{ decision: PermissionDecision; message?: string } | null>(
      (resolve) => {
        const onAbort = () => {
          this.pending.delete(permissionId);
          resolve(null);
        };
        this.pending.set(permissionId, {
          turnId: request.turnId,
          options: offered,
          resolve: (value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
        });
        signal.addEventListener("abort", onAbort, { once: true });
        this.options.emit(
          "permission.requested",
          {
            permissionId,
            tool: request.tool,
            action,
            risk: assessment.classes,
            reasons: policy.reasons,
            ...(request.agentExplanation && { agentExplanation: request.agentExplanation }),
            ...(assessment.diff !== undefined && { diff: assessment.diff }),
            ...(assessment.sessionRule &&
              !sensitive && { sessionRule: assessment.sessionRule.description }),
            options: offered,
          },
          correlation,
        );
      },
    );

    if (answer === null) {
      this.options.db.run(
        "UPDATE permission_requests SET decision = 'withdrawn', decided_at = ? WHERE id = ?",
        [this.now().toISOString(), permissionId],
      );
      this.options.emit(
        "permission.resolved",
        { permissionId, decision: "withdrawn" },
        correlation,
      );
      signal.throwIfAborted();
      throw new Error("permission wait ended without an answer");
    }

    let ruleId: string | null = null;
    if (answer.decision === "allow_session" && assessment.sessionRule) {
      ruleId = this.addSessionRule(request, assessment.sessionRule);
    }
    this.options.db.run(
      `UPDATE permission_requests SET decision = ?, scope = ?, rule_id = ?, user_message = ?, decided_at = ?
       WHERE id = ?`,
      [
        answer.decision,
        answer.decision === "allow_session" ? "session" : "once",
        ruleId,
        answer.message ?? null,
        this.now().toISOString(),
        permissionId,
      ],
    );
    this.options.emit(
      "permission.resolved",
      { permissionId, decision: answer.decision },
      correlation,
    );

    if (answer.decision === "deny") {
      return {
        kind: "deny",
        by: "user",
        reason: "The user denied this action.",
        ...(answer.message !== undefined && { userMessage: answer.message }),
        permissionId,
      };
    }
    return {
      kind: "grant",
      grant: grant(answer.decision === "allow_redacted"),
      via: "user",
      permissionId,
    };
  }

  /** `permissions.respond`: only a pending request, only with an answer it offered. */
  respond(permissionId: string, decision: PermissionDecision, message?: string): void {
    const waiting = this.pending.get(permissionId);
    if (!waiting) {
      throw new JesutobitsError(
        ErrorCodes.permissionNotPending,
        "That approval is no longer waiting for an answer",
        { details: { permissionId } },
      );
    }
    if (!waiting.options.includes(decision)) {
      throw new JesutobitsError(
        ErrorCodes.permissionInvalidDecision,
        `That approval does not offer "${decision}"`,
        { details: { permissionId, offered: [...waiting.options] } },
      );
    }
    if (message !== undefined && decision !== "deny") {
      throw new JesutobitsError(
        ErrorCodes.permissionInvalidDecision,
        "A message goes only with a denial",
        { details: { permissionId } },
      );
    }
    // Single use: removed before the waiter runs.
    this.pending.delete(permissionId);
    waiting.resolve({ decision, ...(message !== undefined && { message }) });
  }

  /** Whether a request is waiting (for tests and for the turn's state). */
  isPending(permissionId: string): boolean {
    return this.pending.has(permissionId);
  }

  listRules(projectId: string): PermissionRule[] {
    return this.options.db
      .all<RuleRow>(
        `SELECT id, scope, session_id, tool, match_json, description, created_at
         FROM permission_rules WHERE project_id = ? ORDER BY created_at`,
        [projectId],
      )
      .map((row) => ({
        id: row.id as PermissionRule["id"],
        scope: row.scope,
        sessionId: row.session_id as PermissionRule["sessionId"],
        tool: row.tool,
        description: row.description,
        createdAt: row.created_at,
      }));
  }

  removeRule(projectId: string, ruleId: string): void {
    const removed = this.options.db.run(
      "DELETE FROM permission_rules WHERE id = ? AND project_id = ?",
      [ruleId, projectId],
    );
    if (removed.changes === 0) {
      throw new JesutobitsError(ErrorCodes.permissionRuleNotFound, "That rule does not exist", {
        details: { ruleId },
      });
    }
  }

  private ruleMatches(request: AuthorizeRequest, wanted: SessionRuleMatch): boolean {
    const rows = this.options.db.all<{ match_json: string }>(
      `SELECT match_json FROM permission_rules
       WHERE project_id = ? AND scope = 'session' AND session_id = ? AND tool = ?`,
      [request.projectId, request.sessionId, request.tool],
    );
    return rows.some((row) => {
      let rule: SessionRuleMatch;
      try {
        rule = JSON.parse(row.match_json) as SessionRuleMatch;
      } catch {
        return false;
      }
      if (rule.tool !== wanted.tool) return false;
      // A rule without paths covers every path; one with paths covers only those.
      if (!rule.paths) return true;
      const covered = new Set(rule.paths);
      return (wanted.paths ?? []).length > 0 && (wanted.paths ?? []).every((p) => covered.has(p));
    });
  }

  private addSessionRule(
    request: AuthorizeRequest,
    rule: { match: SessionRuleMatch; description: string },
  ): string {
    const id = newId("rule");
    this.options.db.run(
      `INSERT INTO permission_rules (id, project_id, session_id, scope, tool, match_json, description, created_at)
       VALUES (?, ?, ?, 'session', ?, ?, ?, ?)`,
      [
        id,
        request.projectId,
        request.sessionId,
        rule.match.tool,
        JSON.stringify(rule.match),
        rule.description,
        this.now().toISOString(),
      ],
    );
    return id;
  }
}
