import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MethodNameSchema } from "../envelope.js";
import { isProtocolCompatible, PROTOCOL_VERSION } from "../version.js";
import { METHODS, methodsCallableBy, runtimeInitialize } from "./index.js";

const generated = JSON.parse(
  readFileSync(new URL("../../generated/methods.json", import.meta.url), "utf8"),
) as { workbench: string[]; host: string[] };

describe("method registry", () => {
  it.each(Object.values(METHODS))("$name is well formed", (method) => {
    expect(MethodNameSchema.parse(method.name)).toBe(method.name);
    expect(method.callers.length).toBeGreaterThan(0);
    expect(() => z.toJSONSchema(method.params)).not.toThrow();
    expect(() => z.toJSONSchema(method.result)).not.toThrow();
  });

  // The Host allowlist is generated from this file; drift means `pnpm gen` was not run.
  it("matches generated/methods.json", () => {
    expect(generated.workbench).toEqual(methodsCallableBy("workbench"));
    expect(generated.host).toEqual(methodsCallableBy("host"));
  });

  it("never lets the Workbench initialise or shut down the runtime", () => {
    expect(methodsCallableBy("workbench")).not.toContain("runtime.initialize");
    expect(methodsCallableBy("workbench")).not.toContain("runtime.shutdown");
  });
});

describe("runtime.initialize", () => {
  it("accepts the current protocol version", () => {
    const params = {
      protocolVersion: PROTOCOL_VERSION,
      client: { name: "host", version: "0.0.0" },
    };
    expect(runtimeInitialize.params.parse(params)).toEqual(params);
  });

  it("rejects a non-semver protocol version", () => {
    const params = { protocolVersion: "1", client: { name: "host", version: "0.0.0" } };
    expect(runtimeInitialize.params.safeParse(params).success).toBe(false);
  });
});

describe("isProtocolCompatible", () => {
  it.each([
    ["0.1.0", "0.9.3", true],
    ["1.0.0", "1.4.0-beta.1", true],
    ["1.0.0", "2.0.0", false],
    ["1.0.0", "one", false],
  ])("%s vs %s -> %s", (a, b, expected) => {
    expect(isProtocolCompatible(a, b)).toBe(expected);
  });
});
