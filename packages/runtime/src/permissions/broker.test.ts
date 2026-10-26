import { describe, expect, it } from "vitest";
import {
  ErrorCodes,
  JesutobitsError,
  type EventCorrelation,
  type EventPayload,
} from "@jesutobits/protocol";
import { nullLogger } from "@jesutobits/shared";
import type { Database } from "../storage/database.js";
import { openStorage } from "../storage/storage.js";
import { PermissionBroker, hashInput, type AuthorizeRequest } from "./broker.js";
import type { PolicyColumn } from "./policy.js";
import type { RiskAssessment } from "../tools/common/types.js";

type BrokerEventType = "permission.requested" | "permission.resolved";

interface CollectedEvent {
  type: BrokerEventType;
  payload: EventPayload<BrokerEventType>;
  correlation: EventCorrelation;
}

type Emit = <T extends BrokerEventType>(
  type: T,
  payload: EventPayload<T>,
  correlation: EventCorrelation,
) => void;

const NOW = "2026-10-22T00:00:00.000Z";

/** A fresh in-memory database with the project, session and turn rows the broker needs. */
function makeBroker() {
  const db = openStorage({ dir: undefined, log: nullLogger }).db;
  db.run(
    "INSERT INTO projects (id, canonical_path, display_name, kind, trust) VALUES ('prj_1','/p','p','project','trusted')",
  );
  db.run(
    `INSERT INTO sessions (id, project_id, title, provider_id, model_id, created_at, updated_at)
     VALUES ('ses_1','prj_1','t','scripted','m','${NOW}','${NOW}')`,
  );
  db.run(
    `INSERT INTO turns (id, session_id, mode, model_id, state, started_at, prompt_version)
     VALUES ('trn_1','ses_1','agent','m','thinking','${NOW}','v')`,
  );

  const events: CollectedEvent[] = [];
  // Read inside the emit callback, i.e. before any listener could have answered.
  const seen = { decisionAtEmit: null as string | null | undefined };
  const emit: Emit = (type, payload) => {
    if (type === "permission.requested") {
      const { permissionId } = payload as EventPayload<"permission.requested">;
      seen.decisionAtEmit = db.get<{ decision: string | null }>(
        "SELECT decision FROM permission_requests WHERE id = ?",
        [permissionId],
      )?.decision;
    }
    events.push({ type, payload, correlation: {} });
  };

  let column: PolicyColumn = "balanced";
  const broker = new PermissionBroker({
    db,
    emit,
    column: () => column,
    now: () => new Date(NOW),
  });
  return {
    broker,
    db,
    events,
    seen,
    setColumn: (value: PolicyColumn) => {
      column = value;
    },
  };
}

describe("PermissionBroker", () => {
  /** The standard call: an `edit_file` in the project under `balanced`. */
  function callRequest(overrides: Partial<AuthorizeRequest> = {}): AuthorizeRequest {
    const assessment: RiskAssessment = {
      classes: ["write"],
      action: { kind: "file", op: "write", paths: ["a.ts"] },
      sessionRule: { match: { tool: "edit_file" }, description: "edit_file: change files" },
    };
    return {
      projectId: "prj_1",
      sessionId: "ses_1",
      turnId: "trn_1",
      callId: "call_1",
      tool: "edit_file",
      input: { path: "a.ts" },
      assessment,
      ...overrides,
    };
  }

  function requestRow(
    db: Database,
    id: string,
  ): {
    decision: string | null;
    scope: string | null;
    user_message: string | null;
  } {
    const row = db.get<{
      decision: string | null;
      scope: string | null;
      user_message: string | null;
    }>("SELECT decision, scope, user_message FROM permission_requests WHERE id = ?", [id]);
    if (!row) throw new Error(`no permission_requests row for ${id}`);
    return row;
  }

  function requestedEvent(
    events: CollectedEvent[],
    index: number,
  ): EventPayload<"permission.requested"> {
    const event = events[index];
    if (event?.type !== "permission.requested") {
      throw new Error(`expected a permission.requested event at position ${index}`);
    }
    return event.payload as EventPayload<"permission.requested">;
  }

  function resolvedEvent(
    events: CollectedEvent[],
    index: number,
  ): EventPayload<"permission.resolved"> {
    const event = events[index];
    if (event?.type !== "permission.resolved") {
      throw new Error(`expected a permission.resolved event at position ${index}`);
    }
    return event.payload as EventPayload<"permission.resolved">;
  }

  /** The code of the `JesutobitsError` a call throws, failing the test when it does not. */
  function errorCodeOf(run: () => void): string {
    try {
      run();
    } catch (error) {
      if (error instanceof JesutobitsError) return error.code;
      throw error;
    }
    throw new Error("expected the call to throw");
  }

  function noSignal(): AbortSignal {
    return new AbortController().signal;
  }

  it("grants by policy when every class is allowed, with no events and no row", async () => {
    const { broker, db, events } = makeBroker();
    const request = callRequest();
    const decision = await broker.authorize(request, noSignal());

    expect(decision).toMatchObject({
      kind: "grant",
      via: "policy",
      grant: { callId: "call_1", inputHash: hashInput(request.input), redactValues: false },
    });
    expect(events).toHaveLength(0);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM permission_requests")?.n).toBe(0);
  });

  it("denies a prohibited assessment under every column, session rule or not", async () => {
    const reason = "This is password manager data; the agent can never read or change it.";
    for (const premise of ["cautious", "balanced", "autonomous", "restricted"] as const) {
      const { broker, events, setColumn } = makeBroker();
      setColumn(premise);
      const decision = await broker.authorize(
        callRequest({
          assessment: {
            classes: ["write"],
            prohibited: reason,
            action: { kind: "file", op: "write", paths: ["a.ts"] },
            sessionRule: { match: { tool: "edit_file" }, description: "edit_file: change files" },
          },
        }),
        noSignal(),
      );

      expect(decision).toEqual({ kind: "deny", by: "prohibited", reason });
      expect(events).toHaveLength(0);
    }
  });

  it("denies outside_workspace by policy without a card", async () => {
    const { broker, db, events } = makeBroker();
    const decision = await broker.authorize(
      callRequest({ assessment: { classes: ["outside_workspace"] } }),
      noSignal(),
    );

    expect(decision).toMatchObject({ kind: "deny", by: "policy" });
    if (decision.kind === "deny") expect(decision.reason).toContain("outside the project");
    expect(events).toHaveLength(0);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM permission_requests")?.n).toBe(0);
  });

  it("asks under cautious, records the request before the event, and answers allow once", async () => {
    const { broker, db, events, seen, setColumn } = makeBroker();
    setColumn("cautious");
    const pending = broker.authorize(callRequest(), noSignal());

    const requested = requestedEvent(events, 0);
    expect(requested.options).toEqual(["allow_once", "allow_session", "deny"]);
    expect(requested).toMatchObject({
      tool: "edit_file",
      action: { kind: "file", op: "write", paths: ["a.ts"] },
      risk: ["write"],
      reasons: [
        "Changes files in the project. Jesutobits keeps a copy so the change can be reverted.",
      ],
    });
    expect(seen.decisionAtEmit).toBeNull();

    broker.respond(requested.permissionId, "allow_once");
    const decision = await pending;

    expect(decision).toMatchObject({
      kind: "grant",
      via: "user",
      permissionId: requested.permissionId,
      grant: { callId: "call_1", inputHash: hashInput({ path: "a.ts" }) },
    });
    expect(requestRow(db, requested.permissionId)).toEqual({
      decision: "allow_once",
      scope: "once",
      user_message: null,
    });
    expect(resolvedEvent(events, 1)).toMatchObject({
      permissionId: requested.permissionId,
      decision: "allow_once",
    });
    expect(events).toHaveLength(2);
  });

  it("accepts each answer only once, and only from the offered options", async () => {
    const { broker, events, setColumn } = makeBroker();
    setColumn("cautious");
    const pending = broker.authorize(callRequest(), noSignal());
    const requested = requestedEvent(events, 0);
    const id = requested.permissionId;

    expect(errorCodeOf(() => broker.respond(id, "allow_redacted"))).toBe(
      ErrorCodes.permissionInvalidDecision,
    );
    expect(errorCodeOf(() => broker.respond(id, "allow_once", "a message"))).toBe(
      ErrorCodes.permissionInvalidDecision,
    );

    broker.respond(id, "allow_once");
    const decision = await pending;
    expect(decision).toMatchObject({ kind: "grant", via: "user" });

    expect(errorCodeOf(() => broker.respond(id, "allow_once"))).toBe(
      ErrorCodes.permissionNotPending,
    );
    expect(errorCodeOf(() => broker.respond("perm_missing", "allow_once"))).toBe(
      ErrorCodes.permissionNotPending,
    );
  });

  it("keeps the user's message on a denial with a message", async () => {
    const { broker, db, events } = makeBroker();
    const pending = broker.authorize(
      callRequest({
        assessment: {
          classes: ["destructive"],
          action: { kind: "file", op: "delete", paths: ["a.ts"] },
        },
      }),
      noSignal(),
    );
    const requested = requestedEvent(events, 0);

    broker.respond(requested.permissionId, "deny", "Please not that file");
    const decision = await pending;

    expect(decision).toEqual({
      kind: "deny",
      by: "user",
      reason: "The user denied this action.",
      userMessage: "Please not that file",
      permissionId: requested.permissionId,
    });
    expect(requestRow(db, requested.permissionId)).toEqual({
      decision: "deny",
      scope: "once",
      user_message: "Please not that file",
    });
  });

  it("adds a session rule on allow_session and grants identical calls silently", async () => {
    const { broker, db, events, setColumn } = makeBroker();
    setColumn("balanced");
    const deleteAssessment = (paths: string[]): RiskAssessment => ({
      classes: ["destructive"],
      action: { kind: "file", op: "delete", paths },
      sessionRule: {
        match: { tool: "delete_path", paths },
        description: "delete_path: delete the listed path",
      },
    });
    const deleteRequest = (callId: string, paths: string[]): AuthorizeRequest =>
      callRequest({
        callId,
        tool: "delete_path",
        input: { path: paths[0] },
        assessment: deleteAssessment(paths),
      });

    const first = broker.authorize(deleteRequest("call_1", ["a.ts"]), noSignal());
    const requested = requestedEvent(events, 0);
    broker.respond(requested.permissionId, "allow_session");
    expect(await first).toMatchObject({
      kind: "grant",
      via: "user",
      permissionId: requested.permissionId,
    });

    const rules = broker.listRules("prj_1");
    expect(rules).toEqual([
      expect.objectContaining({
        scope: "session",
        sessionId: "ses_1",
        tool: "delete_path",
        description: "delete_path: delete the listed path",
      }),
    ]);
    const ruleId = rules[0]?.id as string;
    expect(requestRow(db, requested.permissionId).scope).toBe("session");
    expect(resolvedEvent(events, 1).decision).toBe("allow_session");

    const before = events.length;
    const second = await broker.authorize(deleteRequest("call_2", ["a.ts"]), noSignal());
    expect(second).toMatchObject({ kind: "grant", via: "rule" });
    expect(events).toHaveLength(before);

    broker.removeRule("prj_1", ruleId);
    expect(broker.listRules("prj_1")).toEqual([]);
    expect(errorCodeOf(() => broker.removeRule("prj_1", ruleId))).toBe(
      ErrorCodes.permissionRuleNotFound,
    );

    const third = broker.authorize(deleteRequest("call_3", ["a.ts"]), noSignal());
    const askedAgain = requestedEvent(events, 2);
    broker.respond(askedAgain.permissionId, "deny");
    expect(await third).toMatchObject({ kind: "deny", by: "user" });
  });

  it("covers only the paths a rule names", async () => {
    const { broker, events, setColumn } = makeBroker();
    setColumn("balanced");
    const ruleAssessment = (paths: string[]): RiskAssessment => ({
      classes: ["destructive"],
      action: { kind: "file", op: "delete", paths },
      sessionRule: {
        match: { tool: "delete_path", paths },
        description: "delete_path: delete the listed path",
      },
    });
    const deleteRequest = (callId: string, paths: string[]): AuthorizeRequest =>
      callRequest({
        callId,
        tool: "delete_path",
        input: { path: paths[0] },
        assessment: ruleAssessment(paths),
      });

    const first = broker.authorize(deleteRequest("call_1", ["a.ts"]), noSignal());
    const requested = requestedEvent(events, 0);
    broker.respond(requested.permissionId, "allow_session");
    expect(await first).toMatchObject({ kind: "grant", via: "user" });

    const before = events.length;
    const unrelated = broker.authorize(deleteRequest("call_2", ["b.ts"]), noSignal());
    const unrelatedId = requestedEvent(events, before).permissionId;
    broker.respond(unrelatedId, "deny");
    expect(await unrelated).toMatchObject({ kind: "deny", by: "user" });

    const after = events.length;
    const covered = await broker.authorize(deleteRequest("call_3", ["a.ts"]), noSignal());
    expect(covered).toMatchObject({ kind: "grant", via: "rule" });
    expect(events).toHaveLength(after);
  });

  it("asks for sensitive reads with redaction and never via a session rule", async () => {
    const { broker, db, events, setColumn } = makeBroker();
    setColumn("balanced");
    // An existing rule whose match would cover exactly this call if rules applied to secret
    // files (SECURITY.md section 6.2).
    db.run(
      `INSERT INTO permission_rules (id, project_id, session_id, scope, tool, match_json, description, created_at)
       VALUES ('rule_env','prj_1','ses_1','session','read_file',
               '${JSON.stringify({ tool: "read_file", paths: [".env"] })}','secret read','${NOW}')`,
    );

    const readRequest = (): AuthorizeRequest =>
      callRequest({
        callId: "call_env_1",
        tool: "read_file",
        input: { path: ".env" },
        assessment: {
          classes: ["read", "sensitive_read"],
          action: { kind: "file", op: "read", paths: [".env"] },
          sessionRule: {
            match: { tool: "read_file", paths: [".env"] },
            description: "read_file: read .env",
          },
        },
      });

    const pending = broker.authorize(readRequest(), noSignal());
    const requested = requestedEvent(events, 0);
    expect(requested.sessionRule).toBeUndefined();
    expect(requested.options).toEqual(["allow_once", "allow_redacted", "deny"]);

    broker.respond(requested.permissionId, "allow_redacted");
    const decision = await pending;
    expect(decision).toMatchObject({
      kind: "grant",
      via: "user",
      permissionId: requested.permissionId,
      grant: { redactValues: true },
    });

    const before = events.length;
    const again = broker.authorize(readRequest(), noSignal());
    expect(requestedEvent(events, before).options).toEqual([
      "allow_once",
      "allow_redacted",
      "deny",
    ]);
    const secondId = requestedEvent(events, before).permissionId;
    broker.respond(secondId, "deny");
    expect(await again).toMatchObject({ kind: "deny", by: "user" });
  });

  it("lets writes ask under restricted and refuses commands entirely", async () => {
    const { broker, events, setColumn } = makeBroker();
    setColumn("restricted");

    const writePending = broker.authorize(callRequest(), noSignal());
    const requested = requestedEvent(events, 0);
    expect(requested.options).toEqual(["allow_once", "allow_session", "deny"]);
    broker.respond(requested.permissionId, "deny");
    expect(await writePending).toMatchObject({ kind: "deny", by: "user" });

    const before = events.length;
    const denied = await broker.authorize(
      callRequest({ callId: "call_2", assessment: { classes: ["execute"] } }),
      noSignal(),
    );
    expect(denied).toMatchObject({ kind: "deny", by: "policy" });
    if (denied.kind === "deny") expect(denied.reason).toContain("Runs code");
    expect(events).toHaveLength(before);
  });

  it("withdraws a pending request when the signal aborts", async () => {
    const { broker, events, setColumn } = makeBroker();
    setColumn("cautious");
    const controller = new AbortController();
    const pending = broker.authorize(callRequest(), controller.signal);
    const requested = requestedEvent(events, 0);
    expect(requested.options).toEqual(["allow_once", "allow_session", "deny"]);

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    const resolved = resolvedEvent(events, 1);
    expect(resolved).toMatchObject({ permissionId: requested.permissionId, decision: "withdrawn" });
    expect(errorCodeOf(() => broker.respond(requested.permissionId, "allow_once"))).toBe(
      ErrorCodes.permissionNotPending,
    );
  });

  it("hashes object keys canonically", () => {
    expect(hashInput({ a: 1, b: 2 })).toBe(hashInput({ b: 2, a: 1 }));
    expect(hashInput({ a: 1, b: 2 })).not.toBe(hashInput({ a: 2, b: 2 }));
    expect(hashInput({ nested: { x: 1, y: [3, 4] } })).toBe(
      hashInput({ nested: { y: [3, 4], x: 1 } }),
    );
  });
});
