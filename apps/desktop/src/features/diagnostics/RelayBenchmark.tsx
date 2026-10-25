import { useState } from "react";
import type { HostBridge } from "../../host-bridge";
import { t } from "../../i18n";
import { measureRelayLatency, type LatencySummary } from "./relay-benchmark";

// No pass/fail verdict: NFR-006's 5 ms budget is for the relay alone, and this full round
// trip is mostly WebView2 IPC (5 to 9 ms p95 even in release, Spike S1).
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
      <h2 id="relay-benchmark-title">{t("diagnostics.roundTrip.title")}</h2>
      <p>{t("diagnostics.roundTrip.scope")}</p>
      <button type="button" onClick={() => void run()} disabled={disabled || running}>
        {t(running ? "diagnostics.roundTrip.running" : "diagnostics.roundTrip.run")}
      </button>
      {error && <p role="alert">{error}</p>}
      {summary && (
        <dl aria-live="polite">
          <dt>p50</dt>
          <dd>{format(summary.p50)}</dd>
          <dt>p95</dt>
          <dd>{format(summary.p95)}</dd>
          <dt>p99</dt>
          <dd>{format(summary.p99)}</dd>
          <dt>max</dt>
          <dd>{format(summary.max)}</dd>
        </dl>
      )}
    </section>
  );
}
