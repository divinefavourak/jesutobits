import { describe, expect, it } from "vitest";
import { classifyMessage, MethodNameSchema } from "./envelope.js";

describe("classifyMessage", () => {
  it("recognises requests, notifications and responses", () => {
    expect(classifyMessage({ jsonrpc: "2.0", id: 1, method: "runtime.ping" }).kind).toBe("request");
    expect(classifyMessage({ jsonrpc: "2.0", method: "event", params: { seq: 0 } }).kind).toBe(
      "notification",
    );
    expect(classifyMessage({ jsonrpc: "2.0", id: "w-1", result: {} }).kind).toBe("success");
    expect(classifyMessage({ jsonrpc: "2.0", id: "w-1", result: null }).kind).toBe("success");
    expect(
      classifyMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "x" } }).kind,
    ).toBe("failure");
  });

  it("keeps the id of an invalid request so the error can be correlated", () => {
    const result = classifyMessage({ jsonrpc: "1.0", id: "w-7", method: "runtime.ping" });
    expect(result).toMatchObject({ kind: "invalid", id: "w-7" });
  });

  it.each([
    ["array", []],
    ["string", "hello"],
    ["null", null],
    ["positional params", { jsonrpc: "2.0", id: 1, method: "runtime.ping", params: [1] }],
    ["bad error data", { jsonrpc: "2.0", id: 1, error: { code: 1, message: "x", data: {} } }],
  ])("rejects %s", (_label, value) => {
    expect(classifyMessage(value).kind).toBe("invalid");
  });
});

describe("MethodNameSchema", () => {
  it.each(["runtime.ping", "fs.readFile", "host.secrets.get"])("accepts %s", (name) => {
    expect(MethodNameSchema.safeParse(name).success).toBe(true);
  });

  it.each(["ping", "Runtime.ping", "runtime.", "runtime..ping", "runtime.read-file"])(
    "rejects %s",
    (name) => {
      expect(MethodNameSchema.safeParse(name).success).toBe(false);
    },
  );
});
