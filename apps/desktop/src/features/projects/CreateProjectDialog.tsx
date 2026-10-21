import { useEffect, useId, useState, type FormEvent } from "react";
import { t } from "../../i18n";
import type { ProjectTemplate } from "../../state/project-store";
import { useProjects, useWorkbench } from "../../state/workbench-context";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { ProjectError } from "./ProjectError";

const TEMPLATES: ProjectTemplate[] = ["empty", "general"];

/**
 * New project from a built-in template (FR-005, J-04). Phase 1 has Empty and General
 * workspace. The folder goes in the default workspace folder (FR-002) unless the user picks
 * another; the runtime refuses a name that already holds files before writing anything.
 */
export function CreateProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  // The dialog renders its content only while open, so each opening starts a fresh form.
  return (
    <Dialog open={open} title={t("create.title")} onCancel={onClose}>
      <CreateProjectForm onClose={onClose} />
    </Dialog>
  );
}

function CreateProjectForm({ onClose }: { onClose: () => void }) {
  const { bridge, projects } = useWorkbench();
  const busy = useProjects((state) => state.busy);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<ProjectTemplate>("empty");
  const [location, setLocation] = useState<string | null>(null);
  const nameId = useId();
  const locationId = useId();

  useEffect(() => {
    projects.getState().dismissError();
    let current = true;
    void bridge.settings.get().then((settings) => {
      if (current) setLocation((chosen) => chosen ?? settings.workspace.defaultFolder);
    });
    return () => {
      current = false;
    };
  }, [bridge, projects]);

  const chooseLocation = async () => {
    const picked = await bridge.dialogs
      .pickFolder({ title: t("create.location.title"), ...(location && { defaultPath: location }) })
      .catch(() => null);
    if (picked) setLocation(picked);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!location || !name.trim()) return;
    await projects.getState().create({ parentDir: location, name: name.trim(), template });
    if (!projects.getState().error) onClose();
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="font-medium">
          {t("create.name")}
        </label>
        <input
          id={nameId}
          value={name}
          maxLength={100}
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
          className="rounded-md border border-border-strong bg-surface px-2 py-1.5 text-text"
        />
      </div>

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 p-0 font-medium">{t("create.template")}</legend>
        {TEMPLATES.map((id) => (
          <label
            key={id}
            className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 hover:bg-item-hover"
          >
            <input
              type="radio"
              name="template"
              value={id}
              checked={template === id}
              onChange={() => setTemplate(id)}
              className="mt-1"
            />
            <span>
              <span className="block font-medium">{t(`create.template.${id}`)}</span>
              <span className="block text-text-muted">{t(`create.template.${id}.hint`)}</span>
            </span>
          </label>
        ))}
        <p className="m-0 text-text-muted">{t("create.template.later")}</p>
      </fieldset>

      <div className="flex flex-col gap-1">
        <span id={locationId} className="font-medium">
          {t("create.location")}
        </span>
        <div className="flex items-center gap-2">
          <code
            aria-labelledby={locationId}
            className="min-w-0 flex-1 truncate rounded-md bg-surface-sunken px-2 py-1.5 font-mono"
          >
            {location ?? t("create.location.none")}
          </code>
          <Button onClick={() => void chooseLocation()}>
            {location ? t("create.location.change") : t("create.location.choose")}
          </Button>
        </div>
        <p className="m-0 text-text-muted">{t("create.location.hint")}</p>
      </div>

      <ProjectError only={["create"]} />

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("create.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !location || !name.trim()}>
          {t("create.submit")}
        </Button>
      </div>
    </form>
  );
}
