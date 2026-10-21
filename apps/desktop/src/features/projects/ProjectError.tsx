import { t } from "../../i18n";
import { useProjects, useWorkbench } from "../../state/workbench-context";
import { Button } from "../../ui/Button";
import type { ProjectAction } from "../../state/project-store";

/**
 * The last failed project action, in words (UX_AND_INTERFACE.md section 11). `only` limits it
 * to some actions, for example the create dialog shows its own failures.
 */
export function ProjectError({ only }: { only?: ProjectAction[] }) {
  const { projects } = useWorkbench();
  const error = useProjects((state) => state.error);
  if (!error || (only && !only.includes(error.action))) return null;
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 rounded-md border border-danger bg-danger-subtle px-3 py-2 text-text"
    >
      <p className="m-0">{t(`errors.${error.action}`, { reason: error.message })}</p>
      <Button variant="ghost" onClick={() => projects.getState().dismissError()}>
        {t("errors.dismiss")}
      </Button>
    </div>
  );
}
