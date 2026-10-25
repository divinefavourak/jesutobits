import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppSettingsSchema, UiStateSchema } from "./settings.js";

const cases = JSON.parse(
  readFileSync(new URL("../../../fixtures/settings/cases.json", import.meta.url), "utf8"),
) as Record<"valid" | "invalid", Array<{ name: string; settings: unknown }>>;

describe("AppSettingsSchema", () => {
  // The Host runs the same table with serde (settings_store/settings.rs).
  it.each(cases.valid)("accepts: $name", ({ settings }) => {
    expect(AppSettingsSchema.safeParse(settings).success).toBe(true);
  });

  it.each(cases.invalid)("rejects: $name", ({ settings }) => {
    expect(AppSettingsSchema.safeParse(settings).success).toBe(false);
  });

  it("matches the generated defaults the Host is tested against", () => {
    const generated = JSON.parse(
      readFileSync(new URL("../generated/settings.defaults.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    delete generated.$comment;
    expect(AppSettingsSchema.parse({})).toEqual(generated);
  });

  // DATA_AND_PERSISTENCE.md section 5: no settings field may hold a secret.
  it("has no field named like a secret", () => {
    const ALLOWED = new Set<string>([]);
    const names: string[] = [];
    const walk = (schema: z.ZodType, prefix: string) => {
      const json = z.toJSONSchema(schema, { io: "input" }) as {
        properties?: Record<string, unknown>;
      };
      for (const key of Object.keys(json.properties ?? {})) names.push(`${prefix}${key}`);
    };
    walk(AppSettingsSchema, "");
    for (const [section, schema] of Object.entries(AppSettingsSchema.shape)) {
      const inner = (schema as unknown as { unwrap?: () => z.ZodType }).unwrap?.();
      if (inner) walk(inner, `${section}.`);
    }
    expect(names.length).toBeGreaterThan(5);
    const suspicious = names.filter(
      (name) => /key|token|secret|password|credential/i.test(name) && !ALLOWED.has(name),
    );
    expect(suspicious).toEqual([]);
  });
});

describe("UiStateSchema", () => {
  it("keeps the Workbench's own keys and defaults the window", () => {
    expect(UiStateSchema.parse({ onboarding: { step: 2 } })).toEqual({
      schemaVersion: 1,
      window: null,
      onboarding: { step: 2 },
    });
  });

  it("rejects an impossible window", () => {
    expect(
      UiStateSchema.safeParse({ window: { x: 0, y: 0, width: 10, height: 10, maximized: false } })
        .success,
    ).toBe(false);
  });
});
