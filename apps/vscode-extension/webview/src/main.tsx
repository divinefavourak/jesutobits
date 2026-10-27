import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AgentPanel } from "./features/agent/AgentPanel";
import { WebviewHostBridge, type VsCodeApi } from "./host-bridge";
import { createWorkbench, WorkbenchProvider } from "./state/workbench-context";
import "./styles/base.css";

/** Provided by VS Code inside a webview; callable once. */
declare function acquireVsCodeApi(): VsCodeApi;

const workbench = createWorkbench(new WebviewHostBridge(acquireVsCodeApi()));
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <WorkbenchProvider value={workbench}>
        <AgentPanel />
      </WorkbenchProvider>
    </StrictMode>,
  );
}
