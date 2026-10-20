import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createHostBridge } from "./host-bridge";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

const bridge = await createHostBridge();

createRoot(root).render(
  <StrictMode>
    <App bridge={bridge} />
  </StrictMode>,
);
