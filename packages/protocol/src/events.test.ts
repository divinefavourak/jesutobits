import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineEvent, EVENTS, getEvent, RuntimeEventBaseSchema } from "./events.js";

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
