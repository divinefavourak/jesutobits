import type { Project } from "@jesutobits/protocol";
import { useId, useState } from "react";
import { formatDateTime, t } from "../../i18n";
import { useProjects, useWorkbench } from "../../state/workbench-context";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { CreateProjectDialog } from "../projects/CreateProjectDialog";
import { ProjectError } from "../projects/ProjectError";
import { TrustBadge } from "../projects/TrustBadge";

/** Start screen (UX_AND_INTERFACE.md section 2): new project, open folder, recent projects. */
export function StartScreen() {
  const { bridge, projects, ui } = useWorkbench();
  const ready = useProjects((state) => state.runtime.status === "ready");
  const busy = useProjects((state) => state.busy);
  const [creating, setCreating] = useState(false);
  const headingId = useId();

  const openFolder = async () => {
    const path = await bridge.dialogs
      .pickFolder({ title: t("start.openFolder.title") })
      .catch(() => null);
    if (path) await projects.getState().openFolder(path);
  };

  return (
    <main
      aria-labelledby={headingId}
      className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 overflow-y-auto px-6 py-10"
    >
      <header className="flex flex-col gap-1">
        <h1 id={headingId} className="m-0 text-2xl font-semibold">
          {t("app.name")}
        </h1>
        <p className="m-0 text-text-muted">{t("app.tagline")}</p>
      </header>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={!ready || busy} onClick={() => setCreating(true)}>
          {t("start.newProject")}
        </Button>
        <Button disabled={!ready || busy} onClick={() => void openFolder()}>
          {t("start.openFolder")}
        </Button>
        <Button variant="ghost" onClick={() => ui.getState().openSettings()}>
          {t("settings.title")}
        </Button>
      </div>

      <ProjectError only={["open", "close", "remove", "locate", "list"]} />
      <RecentProjects />

      <CreateProjectDialog open={creating} onClose={() => setCreating(false)} />
    </main>
  );
}

function RecentProjects() {
  const recent = useProjects((state) => state.recent);
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="m-0 text-lg font-semibold">
        {t("start.recent")}
      </h2>
      {recent === null ? (
        <p className="m-0 text-text-muted">{t("start.recent.loading")}</p>
      ) : recent.length === 0 ? (
        <p className="m-0 text-text-muted">{t("start.recent.empty")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {recent.map((project) => (
            <RecentProject key={project.id} project={project} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One recent project with Open, Locate (when missing) and Remove (FR-004). */
function RecentProject({ project }: { project: Project }) {
  const { bridge, projects } = useWorkbench();
  const busy = useProjects((state) => state.busy);
  const ready = useProjects((state) => state.runtime.status === "ready");
  const disabled = busy || !ready;
  const detailsId = useId();

  const locate = async () => {
    const path = await bridge.dialogs
      .pickFolder({ title: t("start.recent.locate.title", { name: project.name }) })
      .catch(() => null);
    if (path) await projects.getState().locate(project.id, path);
  };

  return (
    <li className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col items-start">
        {/* The visible name is the accessible name (WCAG 2.5.3); path and date describe it. */}
        <button
          type="button"
          disabled={disabled}
          aria-describedby={detailsId}
          onClick={() => void projects.getState().openRecent(project.id)}
          className="rounded-sm text-left font-medium hover:underline disabled:cursor-not-allowed"
        >
          {project.name}
        </button>
        <span id={detailsId} className="flex w-full flex-col text-xs text-text-muted">
          <span className="truncate font-mono">{project.path}</span>
          <span>
            {project.lastOpenedAt
              ? t("start.recent.lastOpened", { date: formatDateTime(project.lastOpenedAt) })
              : t("start.recent.never")}
          </span>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {project.kind === "general" && <Badge>{t("project.kind.general")}</Badge>}
        <TrustBadge trust={project.trust} />
        {project.missing && (
          <>
            <Badge tone="danger">
              <span title={t("start.recent.missingHint", { path: project.path })}>
                {t("start.recent.missing")}
              </span>
            </Badge>
            <Button disabled={disabled} onClick={() => void locate()}>
              {t("start.recent.locate")}
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          disabled={disabled}
          aria-label={t("start.recent.removeLabel", { name: project.name })}
          onClick={() => void projects.getState().remove(project.id)}
        >
          {t("start.recent.remove")}
        </Button>
      </div>
    </li>
  );
}
