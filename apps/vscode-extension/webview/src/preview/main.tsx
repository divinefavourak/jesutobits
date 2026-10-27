import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WebviewHostBridge, type VsCodeApi } from "../host-bridge";
import "../styles/base.css";
import { PreviewApp } from "./PreviewApp";

/** Provided by VS Code inside a webview; callable once. */
declare function acquireVsCodeApi(): VsCodeApi;

const bridge = new WebviewHostBridge(acquireVsCodeApi());
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <PreviewApp bridge={bridge} />
    </StrictMode>,
  );
}
