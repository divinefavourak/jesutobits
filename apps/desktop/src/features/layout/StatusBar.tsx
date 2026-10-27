import { t } from "../../i18n";
import { useAgent, useEditor, useProjects } from "../../state/workbench-context";
import { liveTurn } from "../agent/timeline-reducer";
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

/** The live turn's state in words; "Agent idle" when nothing runs (never invented). */
function AgentStatus() {
  const state = useAgent((agent) => liveTurn(agent.timeline)?.state);
  const session = useAgent((agent) =>
    agent.sessions?.find((candidate) => candidate.id === agent.activeSessionId),
  );
  return (
    <span className="flex gap-3">
      <span>{state ? t(`agent.state.${state}`) : t("agent.idle")}</span>
      {session && (
        <span title={session.modelId}>
          {session.modelId} · {t("agent.session.cost", { cost: session.costUsd.toFixed(2) })}
        </span>
      )}
    </span>
  );
}

/**
 * The status bar (UX_AND_INTERFACE.md section 6.6): runtime status, the agent's state as the
 * runtime reports it, the session's model and cost, and the project's trust. Preview and
 * branch arrive with their features.
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
      {hasProject && <AgentStatus />}
      {trust && <TrustBadge trust={trust} />}
      {hasProject && <EditorStatus />}
    </footer>
  );
}
