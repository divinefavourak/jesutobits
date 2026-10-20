import { useState } from "react";
import type { HostBridge } from "../../host-bridge";
import { measureRelayLatency, type LatencySummary } from "./relay-benchmark";

const BUDGET_P95_MS = 5; // NFR-006

const format = (ms: number) => `${ms.toFixed(2)} ms`;

/** Spike S1 relay probe; later part of Help > Diagnostics (ARCHITECTURE.md section 10). */
export function RelayBenchmark({ bridge, disabled }: { bridge: HostBridge; disabled: boolean }) {
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<LatencySummary>();
  const [error, setError] = useState<string>();

  async function run() {
    setRunning(true);
    setError(undefined);
    try {
      const result = await measureRelayLatency(bridge);
      setSummary(result);
      bridge.log("info", `[bench] relay ${JSON.stringify(result)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  }

  return (
    <section aria-labelledby="relay-benchmark-title">
      <h2 id="relay-benchmark-title">Relay latency</h2>
      <button type="button" onClick={() => void run()} disabled={disabled || running}>
        {running ? "Measuring…" : "Measure 1,000 round trips (1 KB)"}
      </button>
      {error && <p role="alert">{error}</p>}
      {summary && (
        <dl aria-live="polite">
          <dt>p50</dt>
          <dd>{format(summary.p50)}</dd>
          <dt>p95</dt>
          <dd>
            {format(summary.p95)} ({summary.p95 < BUDGET_P95_MS ? "within" : "over"} the{" "}
            {BUDGET_P95_MS} ms budget)
          </dd>
          <dt>p99</dt>
          <dd>{format(summary.p99)}</dd>
          <dt>max</dt>
          <dd>{format(summary.max)}</dd>
        </dl>
      )}
    </section>
  );
}
