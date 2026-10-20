import type { HostBridge } from "../../host-bridge";

export interface LatencySummary {
  samples: number;
  payloadBytes: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Nearest-rank percentile of sorted values (milliseconds). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function summarise(durations: readonly number[], payloadBytes: number): LatencySummary {
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    payloadBytes,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? Number.NaN,
  };
}

/**
 * Round-trip latency of `runtime.ping` with a payload echoed both ways, measured from the
 * Workbench: webview IPC, Host relay, stdio and the runtime (Spike S1, NFR-006). Calls run
 * one at a time so each sample is a full round trip.
 */
export async function measureRelayLatency(
  bridge: HostBridge,
  { samples = 1000, warmup = 50, payloadBytes = 1024 } = {},
): Promise<LatencySummary> {
  const echo = "x".repeat(payloadBytes);
  for (let i = 0; i < warmup; i++) await bridge.rpc("runtime.ping", { echo });

  const durations: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    await bridge.rpc("runtime.ping", { echo });
    durations.push(performance.now() - start);
  }
  return summarise(durations, payloadBytes);
}
