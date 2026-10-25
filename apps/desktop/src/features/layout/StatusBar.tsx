import { t } from "../../i18n";
import { useEditor, useProjects } from "../../state/workbench-context";
import { TrustBadge } from "../projects/TrustBadge";

/** Cursor, line endings and encoding of the active editor tab. */
function EditorStatus() {
  const active = useEditor((state) => state.active);
  const format = useEditor((state) =>
    state.active ? (state.files[state.active]?.format ?? null) : null,
  );
  const line = useEditor((state) => (state.active ? state.cursors[state.active]?.line : undefined));
  const column = useEditor((state) =>
    state.active ? state.cursors[state.active]?.column : undefined,
  );
  if (!active || !format) return null;
  return (
    <span className="ml-auto flex gap-3">
      <span>{t("editor.position", { line: line ?? 1, column: column ?? 1 })}</span>
      <span>{t(`editor.eol.${format.eol}`)}</span>
      <span>{t(format.bom ? "editor.encodingBom" : "editor.encoding")}</span>
    </span>
  );
}

/**
 * The status bar (UX_AND_INTERFACE.md section 6.6). Phase 1 shows the runtime status and the
 * project's trust; agent state, model, cost, preview and branch arrive with their features.
 */
export function StatusBar() {
  const runtime = useProjects((state) => state.runtime);
  const trust = useProjects((state) => state.active?.trust);
  const hasProject = useProjects((state) => state.active !== null);
  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 text-xs text-text-muted">
      <span role="status">
        {t(`runtime.status.${runtime.status}`)}
        {runtime.detail ? ` (${runtime.detail})` : ""}
      </span>
      {trust && <TrustBadge trust={trust} />}
      {hasProject && <EditorStatus />}
    </footer>
  );
}
