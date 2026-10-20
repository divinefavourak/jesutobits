import { useEffect, useState } from "react";
import { PROTOCOL_VERSION, type RuntimeStatusUpdate } from "@jesutobits/protocol";
import { PreviewFrameProbe } from "./features/diagnostics/PreviewFrameProbe";
import { RelayBenchmark } from "./features/diagnostics/RelayBenchmark";
import { measureRelayLatency } from "./features/diagnostics/relay-benchmark";
import type { HostBridge } from "./host-bridge";

// Phase 0 placeholder. The real Workbench (layout, ThemeEngine, explorer) starts in Phase 1.
export function App({ bridge }: { bridge: HostBridge }) {
  const [status, setStatus] = useState<RuntimeStatusUpdate>({ status: "starting" });

  useEffect(() => bridge.onRuntimeStatus(setStatus), [bridge]);

  // `VITE_JESUTOBITS_BENCH=relay pnpm dev` measures once the runtime is ready and logs the
  // result through the Host, so Spike S1 can be measured without clicking.
  const ready = status.status === "ready";
  useEffect(() => {
    if (!ready || import.meta.env.VITE_JESUTOBITS_BENCH !== "relay") return;
    void measureRelayLatency(bridge).then(
      (summary) => bridge.log("info", `[bench] relay ${JSON.stringify(summary)}`),
      (error: unknown) => bridge.log("error", `[bench] relay failed: ${String(error)}`),
    );
  }, [bridge, ready]);

  return (
    <main>
      <h1>Jesutobits</h1>
      <p>Workbench scaffold. Protocol {PROTOCOL_VERSION}.</p>
      <p role="status">
        Runtime: {status.status}
        {status.detail ? ` (${status.detail})` : ""}
      </p>
      <RelayBenchmark bridge={bridge} disabled={!ready} />
      {/* Spike S3: `VITE_JESUTOBITS_PREVIEW_PROBE=<url>` frames that URL (scripts/spikes/s3-run.mjs). */}
      {import.meta.env.VITE_JESUTOBITS_PREVIEW_PROBE && (
        <PreviewFrameProbe bridge={bridge} url={import.meta.env.VITE_JESUTOBITS_PREVIEW_PROBE} />
      )}
    </main>
  );
}
