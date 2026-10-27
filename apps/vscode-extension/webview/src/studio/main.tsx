import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StudioSidebar } from "../features/studio/StudioSidebar";
import { WebviewHostBridge, type VsCodeApi } from "../host-bridge";
import "../styles/base.css";

/** Provided by VS Code inside a webview; callable once. */
declare function acquireVsCodeApi(): VsCodeApi;

const bridge = new WebviewHostBridge(acquireVsCodeApi());
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <StudioSidebar bridge={bridge} />
    </StrictMode>,
  );
}
