import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, RpcErrorCode } from "@jesutobits/protocol";
import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "./runtime.js";

function setup() {
  const sent: unknown[] = [];
  let waiters: Array<() => void> = [];
  const io = {
    write: vi.fn(async (line: string) => {
      expect(line.endsWith("\n")).toBe(true);
      sent.push(JSON.parse(line));
      for (const wake of waiters) wake();
      waiters = [];
    }),
    diagnostic: vi.fn(),
    exit: vi.fn(),
    uptimeMs: () => 1234,
    startupMarks: () => ({ nodeBootstrapMs: 40, mainStartMs: 55 }),
  };
  const runtime = createRuntime(io);

  async function call(message: unknown): Promise<Record<string, unknown>> {
    const before = sent.length;
    const line = typeof message === "string" ? message : JSON.stringify(message);
    runtime.receive(Buffer.from(`${line}\n`));
    while (sent.length === before) await new Promise<void>((resolve) => waiters.push(resolve));
    return sent[sent.length - 1] as Record<string, unknown>;
  }

  const initialize = (protocolVersion = PROTOCOL_VERSION) =>
    call({
      jsonrpc: "2.0",
      id: "h-1",
      method: "runtime.initialize",
      params: { protocolVersion, client: { name: "test-host", version: "0.0.0" } },
    });

  return { io, runtime, call, initialize };
}

describe("runtime lifecycle", () => {
  it("completes the handshake", async () => {
    const { initialize } = setup();
    expect(await initialize()).toEqual({
      jsonrpc: "2.0",
      id: "h-1",
      result: {
        protocolVersion: PROTOCOL_VERSION,
        runtimeVersion: "0.0.0",
        nodeVersion: process.version,
        startup: { nodeBootstrapMs: 40, mainStartMs: 55, initializeReceivedMs: 1234 },
      },
    });
  });

  it("refuses other methods before initialize", async () => {
    const { call } = setup();
    const response = await call({ jsonrpc: "2.0", id: 1, method: "runtime.ping" });
    expect(response).toMatchObject({
      id: 1,
      error: { code: RpcErrorCode.ApplicationError, data: { code: "runtime.not_initialized" } },
    });
  });

  it("fails the handshake on a major protocol mismatch", async () => {
    const { initialize, call } = setup();
    expect(await initialize("99.0.0")).toMatchObject({
      error: { data: { code: "runtime.protocol_mismatch", userAction: "reinstall" } },
    });
    // Still uninitialised.
    expect(await call({ jsonrpc: "2.0", id: 2, method: "runtime.ping" })).toMatchObject({
      error: { data: { code: "runtime.not_initialized" } },
    });
  });

  it("rejects a second initialize", async () => {
    const { initialize } = setup();
    await initialize();
    expect(await initialize()).toMatchObject({
      error: { data: { code: "runtime.already_initialized" } },
    });
  });

  it("answers ping once ready", async () => {
    const { initialize, call } = setup();
    await initialize();
    expect(await call({ jsonrpc: "2.0", id: 2, method: "runtime.ping", params: {} })).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { uptimeMs: 1234 },
    });
  });

  it("echoes a ping payload unchanged", async () => {
    const { initialize, call } = setup();
    await initialize();
    const echo = "é✓".repeat(512);
    expect(
      await call({ jsonrpc: "2.0", id: 3, method: "runtime.ping", params: { echo } }),
    ).toMatchObject({ id: 3, result: { echo } });
  });

  it("replies to shutdown before exiting with code 0", async () => {
    const { io, initialize, call } = setup();
    await initialize();
    io.exit.mockImplementation(() => {
      expect(io.write).toHaveBeenCalledTimes(2);
    });
    expect(await call({ jsonrpc: "2.0", id: 3, method: "runtime.shutdown" })).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: {},
    });
    // Exit follows the flush of the reply, one tick after the write is observed.
    await vi.waitFor(() => expect(io.exit).toHaveBeenCalledWith(0));
  });

  it("exits when stdin ends", () => {
    const { io, runtime } = setup();
    runtime.endOfInput();
    expect(io.exit).toHaveBeenCalledWith(0);
  });
});

describe("runtime request validation", () => {
  it("returns a parse error with a null id for invalid JSON", async () => {
    const { call } = setup();
    expect(await call("{not json")).toMatchObject({
      id: null,
      error: { code: RpcErrorCode.ParseError, data: { code: "rpc.parse_error" } },
    });
  });

  it("returns invalid request for a malformed envelope", async () => {
    const { call } = setup();
    expect(await call({ jsonrpc: "2.0", id: 9, method: 42 })).toMatchObject({
      id: 9,
      error: { code: RpcErrorCode.InvalidRequest, data: { code: "rpc.invalid_request" } },
    });
  });

  it("returns method not found for unknown methods", async () => {
    const { call } = setup();
    expect(await call({ jsonrpc: "2.0", id: 4, method: "fs.deleteEverything" })).toMatchObject({
      id: 4,
      error: { code: RpcErrorCode.MethodNotFound, data: { code: "rpc.method_not_found" } },
    });
  });

  it("returns invalid params when params fail the schema", async () => {
    const { call } = setup();
    const response = await call({
      jsonrpc: "2.0",
      id: 5,
      method: "runtime.initialize",
      params: { protocolVersion: "not-semver", client: { name: "x", version: "1" } },
    });
    expect(response).toMatchObject({
      id: 5,
      error: { code: RpcErrorCode.InvalidParams, data: { code: "rpc.invalid_params" } },
    });
  });

  it("rejects a message larger than the 4 MiB limit", async () => {
    const { call } = setup();
    const huge = JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "runtime.ping",
      params: { pad: "x".repeat(MAX_MESSAGE_BYTES) },
    });
    expect(await call(huge)).toMatchObject({
      id: null,
      error: { data: { code: "rpc.message_too_large" } },
    });
  });

  it("ignores notifications without replying", async () => {
    const { io, call } = setup();
    // A notification produces no reply; the following request's reply proves it was consumed.
    const response = await call(
      `${JSON.stringify({ jsonrpc: "2.0", method: "runtime.ping" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "runtime.ping" })}`,
    );
    expect(response).toMatchObject({ id: 7 });
    expect(io.write).toHaveBeenCalledTimes(1);
  });
});
