import { t } from "../../i18n";
import { useProjects } from "../../state/workbench-context";
import { TrustBadge } from "../projects/TrustBadge";

/**
 * The status bar (UX_AND_INTERFACE.md section 6.6). Phase 1 shows the runtime status and the
 * project's trust; agent state, model, cost, preview and branch arrive with their features.
 */
export function StatusBar() {
  const runtime = useProjects((state) => state.runtime);
  const trust = useProjects((state) => state.active?.trust);
  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 text-xs text-text-muted">
      <span role="status">
        {t(`runtime.status.${runtime.status}`)}
        {runtime.detail ? ` (${runtime.detail})` : ""}
      </span>
      {trust && <TrustBadge trust={trust} />}
    </footer>
  );
}
