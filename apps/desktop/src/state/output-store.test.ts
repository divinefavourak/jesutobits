import { describe, expect, it } from "vitest";
import { MockHostBridge } from "../host-bridge";
import { createOutputStore, MAX_OUTPUT_ENTRIES } from "./output-store";

const ts = "2026-10-21T10:00:00.000Z";

describe("output store", () => {
  it("collects runtime warnings and errors, and nothing else", () => {
    const bridge = new MockHostBridge();
    const output = createOutputStore(bridge);
    bridge.emitEvent({
      seq: 1,
      ts,
      type: "runtime.warning",
      message: "Jesutobits stopped noticing file changes",
      code: "fs.watch_stopped",
    } as never);
    bridge.emitEvent({ seq: 2, ts, type: "fs.changed" });
    bridge.emitEvent({
      seq: 3,
      ts,
      type: "runtime.error",
      error: { code: "fs.io", message: "Disk full", retryable: false },
    } as never);

    expect(output.getState().entries).toEqual([
      {
        seq: 1,
        ts,
        level: "warning",
        message: "Jesutobits stopped noticing file changes",
        code: "fs.watch_stopped",
      },
      { seq: 3, ts, level: "error", message: "Disk full", code: "fs.io" },
    ]);
    output.getState().clear();
    expect(output.getState().entries).toEqual([]);
  });

  it(`keeps the newest ${MAX_OUTPUT_ENTRIES} messages`, () => {
    const bridge = new MockHostBridge();
    const output = createOutputStore(bridge);
    for (let seq = 0; seq < MAX_OUTPUT_ENTRIES + 5; seq += 1) {
      bridge.emitEvent({ seq, ts, type: "runtime.warning", message: `m${seq}` } as never);
    }
    const { entries } = output.getState();
    expect(entries).toHaveLength(MAX_OUTPUT_ENTRIES);
    expect(entries[0]?.message).toBe("m5");
  });
});
