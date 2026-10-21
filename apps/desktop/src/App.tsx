import { useEffect, useState } from "react";
import { PROTOCOL_VERSION, type RuntimeStatusUpdate } from "@jesutobits/protocol";
import { PreviewFrameProbe } from "./features/diagnostics/PreviewFrameProbe";
import { RelayBenchmark } from "./features/diagnostics/RelayBenchmark";
import { measureRelayLatency } from "./features/diagnostics/relay-benchmark";
import type { HostBridge } from "./host-bridge";

// Phase 0 placeholder. The real Workbench (layout, ThemeEngine, explorer) starts in Phase 1.
export function App({ bridge }: { bridge: HostBridge }) {
  const [status, setStatus] = useState<RuntimeStatusUpdate>({ status: "starting" });
  const [opened, setOpened] = useState<string>("");

  useEffect(() => bridge.onRuntimeStatus(setStatus), [bridge]);
  // After the first commit: the Host logs how long the cold start took (NFR-001).
  useEffect(() => bridge.reportReady(), [bridge]);

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
      {/* Temporary until the start screen (Phase 1 step 13): exercises the folder dialog. */}
      <button
        type="button"
        disabled={!ready}
        onClick={() =>
          void (async () => {
            const path = await bridge.dialogs.pickFolder({ title: "Open folder" });
            if (path === null) return setOpened("Cancelled");
            const { project } = await bridge.rpc("projects.open", { path });
            setOpened(`Opened ${project.name} (${project.trust})`);
          })().catch((error: unknown) => setOpened(`Failed: ${String(error)}`))
        }
      >
        Open folder…
      </button>
      {opened && <p role="status">{opened}</p>}
      {status.status === "failed" && (
        <button type="button" onClick={() => void bridge.restartRuntime()}>
          Restart runtime
        </button>
      )}
      <RelayBenchmark bridge={bridge} disabled={!ready} />
      {/* Spike S3: `VITE_JESUTOBITS_PREVIEW_PROBE=<url>` frames that URL (scripts/spikes/s3-run.mjs). */}
      {import.meta.env.VITE_JESUTOBITS_PREVIEW_PROBE && (
        <PreviewFrameProbe bridge={bridge} url={import.meta.env.VITE_JESUTOBITS_PREVIEW_PROBE} />
      )}
    </main>
  );
}
