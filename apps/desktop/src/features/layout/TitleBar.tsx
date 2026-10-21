import { t } from "../../i18n";
import { useProjects, useWorkbench } from "../../state/workbench-context";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { TrustBadge } from "../projects/TrustBadge";
import { PresetSwitcher } from "./PresetSwitcher";

/**
 * Project name, trust badge, what kind of project it is and the layout preset switcher
 * (UX_AND_INTERFACE.md section 4.1, J-05). The Stop button arrives with the agent.
 */
export function TitleBar() {
  const { projects, editor } = useWorkbench();
  const project = useProjects((state) => state.active);
  const detection = useProjects((state) => state.detection);
  const busy = useProjects((state) => state.busy);
  if (!project) return null;

  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
      <h1 className="m-0 truncate text-base font-semibold" title={project.path}>
        {project.name}
      </h1>
      {project.kind === "general" && <Badge>{t("project.kind.general")}</Badge>}
      <TrustBadge trust={project.trust} />
      <p className="m-0 min-w-0 flex-1 truncate text-text-muted">
        {detection ? detection.visualEditing.reason : t("project.detecting")}
      </p>
      <PresetSwitcher />
      <Button
        variant="ghost"
        disabled={busy}
        onClick={async () => {
          if (await editor.getState().confirmLeave("project")) await projects.getState().close();
        }}
      >
        {t("project.close")}
      </Button>
    </header>
  );
}
