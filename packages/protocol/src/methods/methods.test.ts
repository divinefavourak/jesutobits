import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { MethodNameSchema } from "../envelope.js";
import { isProtocolCompatible, PROTOCOL_VERSION } from "../version.js";
import { REVERSE_METHODS } from "../reverse.js";
import { METHODS, methodsCallableBy, runtimeInitialize, type WorkbenchMethod } from "./index.js";

const generated = JSON.parse(
  readFileSync(new URL("../../generated/methods.json", import.meta.url), "utf8"),
) as { workbench: string[]; host: string[]; reverse: string[] };

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
    expect(generated.reverse).toEqual(Object.keys(REVERSE_METHODS).sort());
  });

  it("never lets the Workbench initialise or shut down the runtime", () => {
    expect(methodsCallableBy("workbench")).not.toContain("runtime.initialize");
    expect(methodsCallableBy("workbench")).not.toContain("runtime.shutdown");
  });

  // Checked by `tsc` (tsconfig.tests.json): Workbench code cannot even type a Host-only call.
  it("types WorkbenchMethod as exactly the Workbench-callable methods", () => {
    expectTypeOf<WorkbenchMethod>().toEqualTypeOf<
      | "runtime.ping"
      | "events.replay"
      | "projects.list"
      | "projects.open"
      | "projects.create"
      | "projects.close"
      | "projects.setTrust"
      | "projects.remove"
      | "projects.locate"
      | "projects.detect"
      | "projects.prepareWorkspaceFolder"
      | "toolchain.detect"
      | "fs.listDir"
      | "fs.stat"
      | "fs.readFile"
      | "fs.writeFile"
      | "fs.createFile"
      | "fs.createDirectory"
      | "fs.rename"
      | "fs.quickOpen"
      | "fs.trash"
      | "fs.reveal"
      | "sessions.list"
      | "sessions.create"
      | "sessions.get"
      | "sessions.history"
      | "sessions.rename"
      | "sessions.archive"
      | "sessions.delete"
      | "agent.sendMessage"
      | "agent.cancelTurn"
      | "agent.pauseTurn"
      | "agent.resumeTurn"
      | "agent.retryTurn"
      | "agent.answerQuestion"
      | "agent.setModel"
      | "permissions.respond"
      | "permissions.listRules"
      | "permissions.removeRule"
      | "permissions.getPolicy"
      | "permissions.setPolicy"
      | "checkpoints.listForTurn"
      | "checkpoints.revertTurn"
      | "checkpoints.revertFile"
      | "models.list"
      | "models.testConnection"
    >();
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
