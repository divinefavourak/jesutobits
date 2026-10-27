import { describe, expect, it } from "vitest";
import { BUILTIN_TOOLS, ToolRegistry } from "./registry.js";

describe("ToolRegistry", () => {
  it("keeps every built-in tool name snake_case and unique", () => {
    const names = BUILTIN_TOOLS.map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    expect(new Set(names).size).toBe(names.length);
    // The registry would have thrown otherwise; assert it holds anyway.
    expect(() => new ToolRegistry()).not.toThrow();
  });

  it("turns each tool's schema into a JSON Schema object without a $schema key", () => {
    const specs = new ToolRegistry().specs({ trusted: true });
    expect(specs.map((spec) => spec.name).sort()).toEqual(
      BUILTIN_TOOLS.map((tool) => tool.name).sort(),
    );
    for (const spec of specs) {
      expect(spec.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(spec.parameters).toMatchObject({ type: "object" });
      expect(spec.parameters).not.toHaveProperty("$schema");
      expect(typeof spec.description).toBe("string");
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  it("leaves fields with defaults out of required, so the model may omit them", () => {
    const readFile = new ToolRegistry()
      .specs({ trusted: true })
      .find((spec) => spec.name === "read_file");
    expect(readFile).toBeDefined();

    const required = (readFile?.parameters.required as string[] | undefined) ?? [];
    expect(required).toContain("path");
    expect(required).not.toContain("offset");
    expect(required).not.toContain("limit");

    const listDirectory = new ToolRegistry()
      .specs({ trusted: true })
      .find((spec) => spec.name === "list_directory");
    const listingRequired = (listDirectory?.parameters.required as string[] | undefined) ?? [];
    expect(listingRequired).not.toContain("depth");
  });
});
