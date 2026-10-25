import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import {
  documentTarget,
  ThemeEngine,
  windowMedia,
  type AppliedTheme,
} from "./features/appearance/theme-engine";
import { MonacoBuffers } from "./features/editor/monaco-buffers";
import { createHostBridge } from "./host-bridge";
import { createWorkbench } from "./state/workbench-context";
import "./styles/base.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

const bridge = await createHostBridge();
// Monaco itself loads on the first file open (NFR-001).
const workbench = createWorkbench(bridge, { buffers: new MonacoBuffers() });

// Theme first, so the first frame is already in the user's colours. The editor follows
// through the appearance store, also when the OS switches between light and dark.
const themes = new ThemeEngine(documentTarget(), windowMedia());
let appearance = (await bridge.settings.get()).appearance;
const applied = (next: AppliedTheme) => {
  workbench.appearance.setState({ compiled: next.compiled, appearance });
  bridge.log("info", `theme ${next.theme.id} applied in ${next.ms.toFixed(1)} ms`);
};
applied(themes.start(appearance, applied));
bridge.settings.onChange((next) => {
  appearance = next.appearance;
  applied(themes.apply(appearance));
});

createRoot(root).render(
  <StrictMode>
    <App workbench={workbench} />
  </StrictMode>,
);
