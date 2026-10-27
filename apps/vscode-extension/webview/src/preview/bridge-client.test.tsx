import type { BridgeToWorkbenchMessage } from "@jesutobits/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "./bridge-client";

const URL = "http://127.0.0.1:5173/";
const ORIGIN = "http://127.0.0.1:5173";

function setup() {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const sent: unknown[] = [];
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((message: unknown) => {
    sent.push(message);
  });
  const received: BridgeToWorkbenchMessage[] = [];
  const client = new BridgeClient(frame, URL, (message) => received.push(message));
  client.setInspect(true);
  const nonce = (sent[0] as { nonce: string }).nonce;
  const deliver = (data: unknown, source: unknown = frame.contentWindow, origin = ORIGIN) =>
    window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
  const selected = (overrides: Record<string, unknown> = {}) => ({
    jesutobits: 1,
    nonce,
    type: "inspect.selected",
    loc: "src/App.tsx:4:7",
    tag: "h1",
    component: "App",
    className: "text-4xl",
    text: "Track habits",
    ...overrides,
  });
  return { client, frame, sent, received, nonce, deliver, selected };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("BridgeClient", () => {
  it("sends inspect.set with a fresh 128-bit nonce to the preview's origin only", () => {
    const { sent, nonce, frame } = setup();
    expect(sent[0]).toEqual({ jesutobits: 1, nonce, type: "inspect.set", enabled: true });
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(frame.contentWindow!.postMessage).toHaveBeenCalledWith(sent[0], ORIGIN);
  });

  it("accepts a selection from the frame with the right origin and nonce", () => {
    const { deliver, selected, received } = setup();
    deliver(selected());
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "inspect.selected", loc: "src/App.tsx:4:7" });
  });

  it("drops messages from another window, another origin, a wrong nonce or a bad shape", () => {
    const { deliver, selected, received } = setup();
    deliver(selected(), window);
    deliver(selected(), undefined, "http://evil.example");
    deliver(selected({ nonce: "0".repeat(32) }));
    deliver(selected({ type: "permissions.respond" }));
    deliver("not a message");
    expect(received).toEqual([]);
  });

  it("stops listening once disposed", () => {
    const { client, deliver, selected, received } = setup();
    client.dispose();
    deliver(selected());
    expect(received).toEqual([]);
  });
});
