import { getMethod, type MethodResult } from "@jesutobits/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeHarness } from "./harness/runtime-harness.js";

let harness: RuntimeHarness | undefined;

afterEach(() => {
  harness?.kill();
  harness = undefined;
});

describe("runtime over stdio", () => {
  it("answers initialize within 2 s of spawn (NFR-002)", async () => {
    const started = performance.now();
    harness = RuntimeHarness.start();
    const reply = await harness.initialize();
    const elapsed = performance.now() - started;

    expect(reply.error).toBeUndefined();
    expect(reply.result).toMatchObject({ nodeVersion: process.version });
    expect(elapsed).toBeLessThan(2000);
  });

  it("reports its startup stages in order", async () => {
    harness = RuntimeHarness.start();
    const reply = await harness.initialize();
    const result = getMethod("runtime.initialize")?.result.parse(reply.result) as
      MethodResult<"runtime.initialize"> | undefined;
    const startup = result?.startup;

    if (!startup) throw new Error("initialize reported no startup marks");
    expect(startup.nodeBootstrapMs).toBeGreaterThan(0);
    expect(startup.mainStartMs).toBeGreaterThanOrEqual(startup.nodeBootstrapMs);
    expect(startup.initializeReceivedMs).toBeGreaterThanOrEqual(startup.mainStartMs);
  });

  it("answers ping and exits with code 0 after shutdown", async () => {
    harness = RuntimeHarness.start();
    await harness.initialize();

    expect((await harness.call("runtime.ping", {})).result).toMatchObject({
      uptimeMs: expect.any(Number),
    });
    expect((await harness.call("runtime.shutdown", {})).result).toEqual({});
    expect(await harness.exited).toBe(0);
  });

  it("writes structured JSON log lines to stderr, never stdout", async () => {
    harness = RuntimeHarness.start();
    await harness.initialize();
    harness.sendRaw(JSON.stringify({ jsonrpc: "2.0", method: "runtime.ping" }));
    // The next reply proves the notification was handled.
    await harness.call("runtime.ping", {});

    expect(harness.logLines()).toContainEqual({
      level: "warn",
      msg: "ignoring a notification",
      module: "rpc",
      method: "runtime.ping",
    });
  });

  it("answers events.replay before any event exists", async () => {
    harness = RuntimeHarness.start();
    await harness.initialize();
    expect((await harness.call("events.replay", { afterSeq: -1 })).result).toEqual({
      events: [],
      complete: true,
      lastSeq: -1,
    });
    expect(harness.events).toEqual([]);
  });

  it("exits with code 0 when the Host closes stdin (ADR-0002)", async () => {
    harness = RuntimeHarness.start();
    await harness.initialize();
    harness.closeStdin();
    expect(await harness.exited).toBe(0);
  });
});
