import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { documentTarget, ThemeEngine, windowMedia } from "./features/appearance/theme-engine";
import { createHostBridge } from "./host-bridge";
import "./styles/base.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

const bridge = await createHostBridge();

// Theme first, so the first frame is already in the user's colours.
const themes = new ThemeEngine(documentTarget(), windowMedia());
const applied = themes.start((await bridge.settings.get()).appearance);
bridge.log("info", `theme ${applied.theme.id} applied in ${applied.ms.toFixed(1)} ms`);
bridge.settings.onChange((settings) => {
  const next = themes.apply(settings.appearance);
  bridge.log("info", `theme ${next.theme.id} applied in ${next.ms.toFixed(1)} ms`);
});

createRoot(root).render(
  <StrictMode>
    <App bridge={bridge} />
  </StrictMode>,
);
