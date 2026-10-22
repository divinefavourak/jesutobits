import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineEvent,
  EVENTS,
  getEvent,
  RuntimeEventBaseSchema,
  TRANSIENT_EVENT_TYPES,
} from "./events.js";

const base = { seq: 0, ts: "2026-10-20T14:28:57.005Z" };

describe("event catalogue", () => {
  it.each(Object.values(EVENTS))("$type is well formed", (event) => {
    expect(RuntimeEventBaseSchema.shape.type.parse(event.type)).toBe(event.type);
    expect(() => z.toJSONSchema(event.schema)).not.toThrow();
    expect(getEvent(event.type)).toBe(event);
  });

  it("checks the type, the payload and unknown fields", () => {
    const warning = EVENTS["runtime.warning"].schema;
    expect(warning.safeParse({ ...base, type: "runtime.warning", message: "x" }).success).toBe(
      true,
    );
    expect(warning.safeParse({ ...base, type: "runtime.error", message: "x" }).success).toBe(false);
    expect(warning.safeParse({ ...base, type: "runtime.warning" }).success).toBe(false);
    expect(
      warning.safeParse({ ...base, type: "runtime.warning", message: "x", extra: 1 }).success,
    ).toBe(false);
  });

  it("rejects malformed event types", () => {
    expect(() =>
      defineEvent({ type: "Bad Type", description: "", payload: z.object({}) }),
    ).toThrow();
    expect(getEvent("toString")).toBeUndefined();
  });
});

describe("agent events", () => {
  const correlation = {
    sessionId: "ses_01JAB2C3D4E5F6G7H8J9K0M1N2",
    turnId: "trn_01JAB2C3D4E5F6G7H8J9K0M1N2",
  };

  it("starts a turn with a null previous state", () => {
    const changed = EVENTS["turn.state_changed"].schema;
    const event = {
      ...base,
      ...correlation,
      type: "turn.state_changed",
      from: null,
      to: "thinking",
    };
    expect(changed.safeParse(event).success).toBe(true);
    expect(changed.safeParse({ ...event, to: "dreaming" }).success).toBe(false);
  });

  it("requires an approval request to offer at least one answer", () => {
    const requested = EVENTS["permission.requested"].schema;
    const event = {
      ...base,
      ...correlation,
      type: "permission.requested",
      permissionId: "perm_01JAB2C3D4E5F6G7H8J9K0M1N2",
      tool: "read_file",
      action: { kind: "file", op: "read", paths: [".env"] },
      risk: ["sensitive_read"],
      reasons: ["This file may contain secrets."],
      options: ["allow_once", "allow_redacted", "deny"],
    };
    expect(requested.safeParse(event).success).toBe(true);
    expect(requested.safeParse({ ...event, options: [] }).success).toBe(false);
    expect(requested.safeParse({ ...event, permissionId: "perm_1" }).success).toBe(false);
  });

  it("stores everything except text and reasoning deltas", () => {
    expect([...TRANSIENT_EVENT_TYPES].sort()).toEqual([
      "model.reasoning_delta",
      "model.text_delta",
    ]);
    for (const type of TRANSIENT_EVENT_TYPES) expect(getEvent(type)).toBeDefined();
  });
});
