import { t } from "../../i18n";
import { useProjects, useWorkbench } from "../../state/workbench-context";
import { Button } from "../../ui/Button";

/** Full-width banner once the runtime gave up restarting (UX_AND_INTERFACE.md section 12). */
export function RuntimeBanner() {
  const { bridge } = useWorkbench();
  const runtime = useProjects((state) => state.runtime);
  if (runtime.status !== "failed") return null;
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 border-b border-danger bg-danger-subtle px-4 py-2 text-text"
    >
      <p className="m-0">
        {t("runtime.failedBanner")}
        {runtime.detail ? ` (${runtime.detail})` : ""}
      </p>
      <Button variant="primary" onClick={() => void bridge.restartRuntime()}>
        {t("runtime.restart")}
      </Button>
    </div>
  );
}
