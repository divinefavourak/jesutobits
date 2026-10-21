import type { ComponentType } from "react";
import { t, type MessageKey } from "../../i18n";
import {
  AgentIcon,
  EditorIcon,
  FilesIcon,
  InspectorIcon,
  OutputIcon,
  PreviewIcon,
  ProblemsIcon,
  TerminalIcon,
} from "../../ui/icons";
import type { PanelId } from "./layout-model";
import { ExplorerPanel } from "../explorer/ExplorerPanel";
import { OutputPanel } from "./OutputPanel";

export interface PanelDefinition {
  title: MessageKey;
  Icon: ComponentType;
  Content: ComponentType;
}

/** A panel whose feature arrives in a later version says so; it never pretends to work. */
function later(message: MessageKey): ComponentType {
  return function LaterPanel() {
    return <p className="m-0 p-4 text-text-muted">{t(message)}</p>;
  };
}

/** Every panel the dock layout can show (FR-070). */
export const PANELS: Record<PanelId, PanelDefinition> = {
  explorer: { title: "panel.explorer", Icon: FilesIcon, Content: ExplorerPanel },
  editor: { title: "panel.editor", Icon: EditorIcon, Content: later("panel.notYet") },
  preview: { title: "panel.preview", Icon: PreviewIcon, Content: later("panel.preview.later") },
  agent: { title: "panel.agent", Icon: AgentIcon, Content: later("panel.agent.later") },
  inspector: {
    title: "panel.inspector",
    Icon: InspectorIcon,
    Content: later("panel.inspector.later"),
  },
  terminal: { title: "panel.terminal", Icon: TerminalIcon, Content: later("panel.terminal.later") },
  problems: { title: "panel.problems", Icon: ProblemsIcon, Content: later("panel.problems.later") },
  output: { title: "panel.output", Icon: OutputIcon, Content: OutputPanel },
};
