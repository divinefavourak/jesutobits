import { t } from "../i18n";
import type { Command } from "./commands";
import type { Workbench } from "./workbench-context";

/** Commands that belong to no single panel: the palettes, projects, the runtime. */
export function workbenchCommands({
  bridge,
  projects,
  editor,
  ui,
}: Pick<Workbench, "bridge" | "projects" | "editor" | "ui">): Command[] {
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
      id: "workbench.commandPalette",
      title: "command.commandPalette",
      keys: "Ctrl+K",
      run: () => ui.getState().show("commands"),
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
      id: "runtime.restart",
      title: "command.runtime.restart",
      enabled: () => projects.getState().runtime.status === "failed",
      run: () => void bridge.restartRuntime(),
    },
  ];
}
