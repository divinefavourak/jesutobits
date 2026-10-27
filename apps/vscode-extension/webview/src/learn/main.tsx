import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LearningCentre } from "../features/learn/LearningCentre";
import { WebviewHostBridge, type VsCodeApi } from "../host-bridge";
import "../styles/base.css";

/** Provided by VS Code inside a webview; callable once. */
declare function acquireVsCodeApi(): VsCodeApi;

const bridge = new WebviewHostBridge(acquireVsCodeApi());
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <div className="h-screen overflow-y-auto bg-canvas font-ui">
        {/* "Ask my co-builder" puts the question in the agent's message box, unsent. */}
        <LearningCentre bridge={bridge} onAsk={(text) => void bridge.compose(text)} />
      </div>
    </StrictMode>,
  );
}
