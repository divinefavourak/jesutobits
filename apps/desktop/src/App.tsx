import { useEffect, useMemo } from "react";
import { PreviewFrameProbe } from "./features/diagnostics/PreviewFrameProbe";
import { measureRelayLatency } from "./features/diagnostics/relay-benchmark";
import { ProjectView } from "./features/layout/ProjectView";
import { RuntimeBanner } from "./features/layout/RuntimeBanner";
import { StatusBar } from "./features/layout/StatusBar";
import { TrustDialog } from "./features/projects/TrustDialog";
import { StartScreen } from "./features/start/StartScreen";
import type { HostBridge } from "./host-bridge";
import type { ProjectStore } from "./state/project-store";
import { useProjects, useWorkbench, WorkbenchProvider } from "./state/workbench-context";

export function App({ bridge, projects }: { bridge: HostBridge; projects: ProjectStore }) {
  // After the first commit: the Host logs how long the cold start took (NFR-001).
  useEffect(() => bridge.reportReady(), [bridge]);
  const workbench = useMemo(() => ({ bridge, projects }), [bridge, projects]);

  return (
    <WorkbenchProvider value={workbench}>
      <div className="flex h-screen flex-col">
        <RuntimeBanner />
        <Screen />
        <StatusBar />
      </div>
      <TrustDialog />
      <RelayBenchOnReady />
      {/* Spike S3: `VITE_JESUTOBITS_PREVIEW_PROBE=<url>` frames that URL (scripts/spikes/s3-run.mjs). */}
      {import.meta.env.VITE_JESUTOBITS_PREVIEW_PROBE && (
        <PreviewFrameProbe bridge={bridge} url={import.meta.env.VITE_JESUTOBITS_PREVIEW_PROBE} />
      )}
    </WorkbenchProvider>
  );
}

/** The start screen, or the project once one is open (one per window, FR-012). */
function Screen() {
  const hasProject = useProjects((state) => state.active !== null);
  return hasProject ? <ProjectView /> : <StartScreen />;
}

/**
 * `VITE_JESUTOBITS_BENCH=relay pnpm dev` measures once the runtime is ready and logs the
 * result through the Host, so Spike S1 can be measured without clicking.
 */
function RelayBenchOnReady() {
  const ready = useProjects((state) => state.runtime.status === "ready");
  const { bridge } = useWorkbench();
  useEffect(() => {
    if (!ready || import.meta.env.VITE_JESUTOBITS_BENCH !== "relay") return;
    void measureRelayLatency(bridge).then(
      (summary) => bridge.log("info", `[bench] relay ${JSON.stringify(summary)}`),
      (error: unknown) => bridge.log("error", `[bench] relay failed: ${String(error)}`),
    );
  }, [bridge, ready]);
  return null;
}
