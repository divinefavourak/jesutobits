import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SecretRegistry } from "./secret-registry.js";

const shared = JSON.parse(
  readFileSync(new URL("../../../../fixtures/redaction/cases.json", import.meta.url), "utf8"),
) as { cases: Array<{ name: string; input: string; expected: string }> };

describe("SecretRegistry", () => {
  // The Host's redactor runs the same table (logging/redact.rs), so the two cannot drift.
  it.each(shared.cases)("pattern case: $name", ({ input, expected }) => {
    expect(new SecretRegistry().mask(input)).toBe(expected);
  });

  it("masks registered secrets by reference", () => {
    const secrets = new SecretRegistry();
    expect(secrets.register("provider:openrouter:default", "canary-value-123")).toBe(true);
    expect(secrets.mask("sent canary-value-123 twice: canary-value-123")).toBe(
      "sent [REDACTED:provider:openrouter:default] twice: [REDACTED:provider:openrouter:default]",
    );
  });

  it("masks the longer of two overlapping secrets whole", () => {
    const secrets = new SecretRegistry();
    secrets.register("short", "abcdefgh");
    secrets.register("long", "abcdefgh-and-more");
    expect(secrets.mask("abcdefgh-and-more")).toBe("[REDACTED:long]");
  });

  it("replaces a reference's value when registered again", () => {
    const secrets = new SecretRegistry();
    secrets.register("k", "old-value-1");
    secrets.register("k", "new-value-2");
    expect(secrets.mask("old-value-1 new-value-2")).toBe("old-value-1 [REDACTED:k]");
  });

  it("refuses values too short to mask", () => {
    const secrets = new SecretRegistry();
    expect(secrets.register("k", "abc")).toBe(false);
    expect(secrets.mask("abc")).toBe("abc");
  });

  it("masks every string in nested values and survives cycles", () => {
    const secrets = new SecretRegistry();
    secrets.register("k", "canary-0123456789");
    const value: Record<string, unknown> = {
      list: ["canary-0123456789", 1, null],
      nested: { header: "Bearer canary-0123456789" },
    };
    value.self = value;
    expect(secrets.maskValue(value)).toEqual({
      list: ["[REDACTED:k]", 1, null],
      nested: { header: "Bearer [REDACTED:k]" },
      self: "[circular]",
    });
  });
});
