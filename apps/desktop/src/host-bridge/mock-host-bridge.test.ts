import { describe, expect, it } from "vitest";
import type { RuntimeStatus } from "@jesutobits/protocol";
import { MockHostBridge } from "./mock-host-bridge";

describe("MockHostBridge.restartRuntime", () => {
  it("restarts a failed runtime through starting to ready", async () => {
    const bridge = new MockHostBridge();
    const seen: RuntimeStatus[] = [];
    bridge.onRuntimeStatus((update) => seen.push(update.status));
    bridge.setStatus({ status: "failed", detail: "boom" });

    await bridge.restartRuntime();

    expect(seen).toEqual(["ready", "failed", "starting", "ready"]);
  });

  it("ignores a restart unless the runtime failed", async () => {
    const bridge = new MockHostBridge();
    const seen: RuntimeStatus[] = [];
    bridge.onRuntimeStatus((update) => seen.push(update.status));

    await bridge.restartRuntime();

    expect(seen).toEqual(["ready"]);
  });
});
