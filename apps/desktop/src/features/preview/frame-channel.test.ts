import { describe, expect, it } from "vitest";
import { acceptBridgeMessage, createBridgeNonce } from "./frame-channel";

const frameWindow = { name: "preview" };
const nonce = "0123456789abcdef0123456789abcdef";
const expected = { window: frameWindow, origin: "http://127.0.0.1:5173", nonce };
const hello = {
  jesutobits: 1,
  type: "bridge.hello",
  nonce,
  version: "0.1.0",
  url: "http://127.0.0.1:5173/",
};

describe("acceptBridgeMessage", () => {
  it("accepts a hello from the preview frame", () => {
    const result = acceptBridgeMessage(
      { source: frameWindow, origin: expected.origin, data: hello },
      expected,
    );
    expect(result).toEqual({ accepted: true, message: hello });
  });

  it.each([
    ["source", { source: { name: "other" }, origin: expected.origin, data: hello }],
    // Same host, other port; localhost instead of 127.0.0.1; https instead of http.
    ["origin", { source: frameWindow, origin: "http://127.0.0.1:5174", data: hello }],
    ["origin", { source: frameWindow, origin: "http://localhost:5173", data: hello }],
    ["origin", { source: frameWindow, origin: "https://127.0.0.1:5173", data: hello }],
    [
      "schema",
      { source: frameWindow, origin: expected.origin, data: { ...hello, type: "bridge.approve" } },
    ],
    ["schema", { source: frameWindow, origin: expected.origin, data: "bridge.hello" }],
    [
      "nonce",
      { source: frameWindow, origin: expected.origin, data: { ...hello, nonce: "f".repeat(32) } },
    ],
  ])("rejects for %s", (reason, event) => {
    expect(acceptBridgeMessage(event, expected)).toEqual({ accepted: false, reason });
  });
});

describe("createBridgeNonce", () => {
  it("returns 32 hex characters that differ each time", () => {
    const a = createBridgeNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(createBridgeNonce()).not.toBe(a);
  });
});
