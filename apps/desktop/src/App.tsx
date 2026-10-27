import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { PreviewFrameProbe } from "./features/diagnostics/PreviewFrameProbe";
import { measureRelayLatency } from "./features/diagnostics/relay-benchmark";
import { editorCommands } from "./features/editor/editor-commands";
import { CloseDirtyDialog, LeaveDialog } from "./features/editor/EditorPanel";
import { layoutCommands } from "./features/layout/layout-commands";
import { Onboarding } from "./features/onboarding/Onboarding";
import { CommandPalette } from "./features/search/CommandPalette";
import { SettingsView } from "./features/settings/SettingsView";
import { QuickOpen } from "./features/search/QuickOpen";
import { TextSearch } from "./features/search/TextSearch";
import type { Command } from "./state/commands";
import { ProjectView } from "./features/layout/ProjectView";
import { RuntimeBanner } from "./features/layout/RuntimeBanner";
import { StatusBar } from "./features/layout/StatusBar";
import { TrustDialog } from "./features/projects/TrustDialog";
import { StartScreen } from "./features/start/StartScreen";
import { useKeybindings } from "./state/use-keybindings";
import { workbenchCommands } from "./state/workbench-commands";
import {
  useProjects,
  useUi,
  useWorkbench,
  WorkbenchProvider,
  type Workbench,
} from "./state/workbench-context";

export function App({ workbench }: { workbench: Workbench }) {
  const { bridge } = workbench;
  // After the first commit: the Host logs how long the cold start took (NFR-001).
  useEffect(() => bridge.reportReady(), [bridge]);
  const commands = useMemo(
    () => [
      ...workbenchCommands(workbench),
      ...editorCommands(workbench),
      ...layoutCommands(workbench),
    ],
    [workbench],
  );
  useKeybindings(commands);
  // Closing the window with unsaved files asks first.
  useEffect(
    () => bridge.onCloseRequested(() => workbench.editor.getState().confirmLeave("window")),
    [bridge, workbench],
  );

  return (
    <WorkbenchProvider value={workbench}>
      <div className="flex h-screen flex-col">
        <RuntimeBanner />
        <Screen />
        <StatusBar />
      </div>
      <Overlay commands={commands} />
      <TrustDialog />
      <CloseDirtyDialog />
      <LeaveDialog />
      <RelayBenchOnReady />
      {/* Spike S3: `VITE_JESUTOBITS_PREVIEW_PROBE=<url>` frames that URL (scripts/spikes/s3-run.mjs). */}
      {import.meta.env.VITE_JESUTOBITS_PREVIEW_PROBE && (
        <PreviewFrameProbe bridge={bridge} url={import.meta.env.VITE_JESUTOBITS_PREVIEW_PROBE} />
      )}
    </WorkbenchProvider>
  );
}

/** Quick open, project search or the command palette, mounted only while shown. */
function Overlay({ commands }: { commands: readonly Command[] }) {
  const overlay = useUi((state) => state.overlay);
  if (overlay === "files") return <QuickOpen />;
  if (overlay === "commands") return <CommandPalette commands={commands} />;
  if (overlay === "search") return <TextSearch />;
  return null;
}

/**
 * Onboarding on first run (FR-001), else the start screen, or the project once one is open
 * (one per window, FR-012). Settings cover either until closed.
 */
function Screen() {
  const { onboarding } = useWorkbench();
  const hasProject = useProjects((state) => state.active !== null);
  const onboardingStatus = useStore(onboarding, (state) => state.status);
  const settingsOpen = useUi((state) => state.settingsOpen);
  if (onboardingStatus === "loading") return <main className="flex-1" aria-busy="true" />;
  if (settingsOpen) return <SettingsView />;
  if (onboardingStatus === "active" && !hasProject) return <Onboarding />;
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
