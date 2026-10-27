import { describe, expect, it } from "vitest";
import { RestartPolicy } from "./restart-policy.js";

function adr0002(): RestartPolicy {
  return new RestartPolicy([500, 1000, 2000, 4000], 120_000, 5);
}

describe("RestartPolicy", () => {
  it("backs off, then gives up on the fifth crash within two minutes", () => {
    const policy = adr0002();

    expect(policy.onCrash(0)).toEqual({ kind: "restart", afterMs: 500 });
    expect(policy.onCrash(1_000)).toEqual({ kind: "restart", afterMs: 1_000 });
    expect(policy.onCrash(3_000)).toEqual({ kind: "restart", afterMs: 2_000 });
    expect(policy.onCrash(6_000)).toEqual({ kind: "restart", afterMs: 4_000 });
    expect(policy.onCrash(11_000)).toEqual({ kind: "give_up", crashes: 5 });
  });

  it("forgets crashes older than the window", () => {
    const policy = adr0002();
    for (const nowMs of [0, 1_000, 2_000, 3_000]) policy.onCrash(nowMs);

    expect(policy.onCrash(120_000)).toEqual({ kind: "restart", afterMs: 4_000 });
    expect(policy.onCrash(1_000_000)).toEqual({ kind: "restart", afterMs: 500 });
  });

  it("starts counting again after a reset", () => {
    const policy = adr0002();
    for (const nowMs of [0, 1_000, 2_000, 3_000, 4_000]) policy.onCrash(nowMs);

    policy.reset();

    expect(policy.onCrash(6_000)).toEqual({ kind: "restart", afterMs: 500 });
  });

  it("needs a backoff and at least one crash until failed", () => {
    expect(() => new RestartPolicy([], 120_000, 5)).toThrow(RangeError);
    expect(() => new RestartPolicy([500], 120_000, 0)).toThrow(RangeError);
  });
});
