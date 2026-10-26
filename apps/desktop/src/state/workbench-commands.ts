import { liveTurn } from "../features/agent/timeline-reducer";
import { showPanel } from "../features/layout/layout-model";
import { t } from "../i18n";
import type { Command } from "./commands";
import type { Workbench } from "./workbench-context";

/** Commands that belong to no single panel: the palettes, projects, the runtime. */
export function workbenchCommands({
  bridge,
  projects,
  editor,
  ui,
  agent,
  layout,
}: Pick<Workbench, "bridge" | "projects" | "editor" | "ui" | "agent" | "layout">): Command[] {
  const ready = () => projects.getState().runtime.status === "ready";
  const hasProject = () => projects.getState().active !== null;
  /** Closing or replacing the project asks about unsaved files first. */
  const leaveProject = () =>
    hasProject() ? editor.getState().confirmLeave("project") : Promise.resolve(true);

  return [
    {
      id: "workbench.quickOpen",
      title: "command.quickOpen",
      keys: "Ctrl+P",
      enabled: () => ready() && hasProject(),
      run: () => ui.getState().show("files"),
    },
    {
      id: "workbench.searchText",
      title: "command.searchText",
      keys: "Ctrl+Shift+F",
      enabled: () => ready() && hasProject(),
      run: () => ui.getState().show("search"),
    },
    {
      id: "workbench.commandPalette",
      title: "command.commandPalette",
      keys: "Ctrl+K",
      run: () => ui.getState().show("commands"),
    },
    {
      id: "workbench.settings",
      title: "command.settings",
      keys: "Ctrl+,",
      run: () => ui.getState().openSettings(),
    },
    {
      id: "project.openFolder",
      title: "command.project.openFolder",
      enabled: ready,
      run: async () => {
        const path = await bridge.dialogs
          .pickFolder({ title: t("start.openFolder.title") })
          .catch(() => null);
        if (path && (await leaveProject())) await projects.getState().openFolder(path);
      },
    },
    {
      id: "project.close",
      title: "command.project.close",
      enabled: hasProject,
      run: async () => {
        if (await leaveProject()) await projects.getState().close();
      },
    },
    {
      // The global Stop (FR-061): cancels the running turn.
      id: "agent.stop",
      title: "command.agent.stop",
      keys: "Ctrl+.",
      enabled: () => liveTurn(agent.getState().timeline) !== undefined,
      run: () => agent.getState().stop(),
    },
    {
      id: "agent.focusComposer",
      title: "command.agent.focusComposer",
      keys: "Ctrl+L",
      enabled: () => hasProject() && layout.getState().layout !== null,
      run: () => {
        layout.getState().update((current) => showPanel(current, "agent"));
        requestAnimationFrame(() => ui.getState().focusComposer());
      },
    },
    {
      id: "agent.newSession",
      title: "command.agent.newSession",
      enabled: () => ready() && hasProject(),
      run: () => agent.getState().newSession(),
    },
    {
      id: "runtime.restart",
      title: "command.runtime.restart",
      enabled: () => projects.getState().runtime.status === "failed",
      run: () => void bridge.restartRuntime(),
    },
  ];
}
