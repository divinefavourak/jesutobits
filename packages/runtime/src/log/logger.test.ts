import { ErrorCodes, JesutobitsError } from "@jesutobits/protocol";
import type { LogLevel } from "@jesutobits/shared";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { SecretRegistry } from "./secret-registry.js";

function setup(level: LogLevel = "info") {
  const lines: string[] = [];
  const secrets = new SecretRegistry();
  const log = createLogger({ write: (line) => lines.push(line), level, secrets });
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const first = () => {
    const line = parsed()[0];
    if (!line) throw new Error("nothing was logged");
    return line;
  };
  return { log, lines, secrets, parsed, first };
}

describe("runtime logger", () => {
  it("writes one JSON line with level, msg and fields", () => {
    const { log, lines, parsed } = setup();
    log.info("project opened", { module: "workspace", projectId: "prj_1", ms: 12 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(parsed()[0]).toEqual({
      level: "info",
      msg: "project opened",
      module: "workspace",
      projectId: "prj_1",
      ms: 12,
    });
  });

  it("filters lines below its level", () => {
    const { log, parsed } = setup("warn");
    log.info("hidden");
    log.debug("hidden");
    log.error("shown");
    expect(parsed().map((line) => line.msg)).toEqual(["shown"]);
  });

  it("children add their fields to every line", () => {
    const { log, parsed } = setup();
    const child = log.child({ module: "rpc" }).child({ turnId: "trn_1" });
    child.warn("x", { callId: "call_1" });
    expect(parsed()[0]).toMatchObject({ module: "rpc", turnId: "trn_1", callId: "call_1" });
  });

  it("never lets fields replace the level or message, or set Host-owned fields", () => {
    const { log, parsed } = setup();
    log.info("real", { level: "error", msg: "forged", ts: "forged", component: "host" });
    expect(parsed()[0]).toEqual({ level: "info", msg: "real" });
  });

  it("masks secrets in the message and in nested fields", () => {
    const { log, lines, secrets } = setup();
    secrets.register("provider:test", "canary-0123456789");
    log.info("key canary-0123456789", {
      request: { headers: ["Authorization: Bearer canary-0123456789"] },
      other: "sk-or-v1-0123456789abcdef0123",
    });
    expect(lines[0]).not.toContain("canary-0123456789");
    expect(lines[0]).not.toContain("sk-or-v1");
    expect(lines[0]).toContain("[REDACTED:provider:test]");
  });

  it("serialises errors, keeping JesutobitsError's safe form", () => {
    const { log, first } = setup();
    log.error("failed", {
      err: new JesutobitsError(ErrorCodes.rpcInternal, "Internal error"),
      cause: new TypeError("boom"),
    });
    const line = first();
    expect(line.err).toMatchObject({ code: "rpc.internal", message: "Internal error" });
    expect(line.cause).toMatchObject({ name: "TypeError", message: "boom" });
  });

  it("writes dates as ISO strings", () => {
    const { log, first } = setup();
    log.info("x", { at: new Date("2026-10-20T14:28:57.005Z") });
    expect(first().at).toBe("2026-10-20T14:28:57.005Z");
  });

  it("drops oversized fields instead of producing a line the Host would discard", () => {
    const { log, lines, parsed } = setup();
    log.info("big", { module: "x", blob: "a".repeat(100_000) });
    expect(lines[0]?.length).toBeLessThan(64 * 1024);
    expect(parsed()[0]).toEqual({ level: "info", msg: "big", module: "x", fieldsDropped: true });
  });

  it("truncates long messages", () => {
    const { log, first } = setup();
    log.info("m".repeat(20_000));
    expect(String(first().msg)).toMatch(/…\[truncated\]$/);
  });

  it("never throws into the caller", () => {
    const secrets = new SecretRegistry();
    const log = createLogger({
      write: () => {
        throw new Error("stderr closed");
      },
      level: "info",
      secrets,
    });
    const big = { toJSON: () => 1n }; // JSON.stringify throws on BigInt
    expect(() => log.info("x", { big })).not.toThrow();
  });
});
