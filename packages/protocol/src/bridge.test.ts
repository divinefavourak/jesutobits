import { describe, expect, it } from "vitest";
import { BridgeToWorkbenchMessageSchema, WorkbenchToBridgeMessageSchema } from "./bridge.js";

const nonce = "0123456789abcdef0123456789abcdef";

describe("bridge messages", () => {
  it("accepts a well-formed hello", () => {
    const hello = {
      jesutobits: 1,
      type: "bridge.hello",
      nonce,
      version: "0.1.0",
      url: "http://127.0.0.1:5173/",
    };
    expect(BridgeToWorkbenchMessageSchema.parse(hello)).toEqual(hello);
  });

  it.each([
    ["an unknown type", { jesutobits: 1, type: "bridge.approve", nonce }],
    [
      "a short nonce",
      { jesutobits: 1, type: "bridge.hello", nonce: "abc", version: "1", url: "/" },
    ],
    ["another protocol", { jesutobits: 2, type: "bridge.hello", nonce, version: "1", url: "/" }],
    ["missing fields", { jesutobits: 1, type: "bridge.hello", nonce }],
    ["a string", "bridge.hello"],
  ])("rejects %s", (_label, message) => {
    expect(BridgeToWorkbenchMessageSchema.safeParse(message).success).toBe(false);
  });

  it("keeps directions apart", () => {
    const inspect = { jesutobits: 1, type: "inspect.set", nonce, enabled: true };
    expect(WorkbenchToBridgeMessageSchema.safeParse(inspect).success).toBe(true);
    expect(BridgeToWorkbenchMessageSchema.safeParse(inspect).success).toBe(false);
  });
});
