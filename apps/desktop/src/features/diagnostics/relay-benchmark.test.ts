import { describe, expect, it } from "vitest";
import { MockHostBridge } from "../../host-bridge/mock-host-bridge";
import { measureRelayLatency, percentile, summarise } from "./relay-benchmark";

describe("percentile", () => {
  it("uses the nearest rank", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile([], 50)).toBeNaN();
  });
});

describe("summarise", () => {
  it("sorts before ranking", () => {
    expect(summarise([3, 1, 2], 1024)).toEqual({
      samples: 3,
      payloadBytes: 1024,
      p50: 2,
      p95: 3,
      p99: 3,
      max: 3,
    });
  });
});

describe("measureRelayLatency", () => {
  it("echoes the payload through the bridge for every sample", async () => {
    const bridge = new MockHostBridge();
    const summary = await measureRelayLatency(bridge, { samples: 20, warmup: 2, payloadBytes: 64 });
    expect(summary.samples).toBe(20);
    expect(summary.payloadBytes).toBe(64);
    expect(summary.p50).toBeGreaterThanOrEqual(0);
  });
});
