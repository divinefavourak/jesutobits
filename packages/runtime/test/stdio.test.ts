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

  it("answers ping and exits with code 0 after shutdown", async () => {
    harness = RuntimeHarness.start();
    await harness.initialize();

    expect((await harness.call("runtime.ping", {})).result).toMatchObject({
      uptimeMs: expect.any(Number),
    });
    expect((await harness.call("runtime.shutdown", {})).result).toEqual({});
    expect(await harness.exited).toBe(0);
  });

  it("exits with code 0 when the Host closes stdin (ADR-0002)", async () => {
    harness = RuntimeHarness.start();
    await harness.initialize();
    harness.closeStdin();
    expect(await harness.exited).toBe(0);
  });
});
