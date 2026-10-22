import { PROTOCOL_VERSION, type SettingsPatch } from "@jesutobits/protocol";
import { useEffect, useId, useState, type ReactNode } from "react";
import { t, type MessageKey } from "../../i18n";
import { useAppearance, useProjects, useWorkbench } from "../../state/workbench-context";
import { Button } from "../../ui/Button";
import { ThemePicker } from "../appearance/ThemePicker";
import { RelayBenchmark } from "../diagnostics/RelayBenchmark";

type Section = "workspace" | "appearance" | "project" | "advanced" | "about";

/**
 * Settings (FR-011, UX_AND_INTERFACE.md section 8). Phase 1 has the sections whose features
 * exist; providers, agent limits, permissions, companion, previews, extensions and privacy
 * arrive with their features. Changes save at once through the Host's settings store.
 */
export function SettingsView() {
  const { ui } = useWorkbench();
  const hasProject = useProjects((state) => state.active !== null);
  const [section, setSection] = useState<Section>("workspace");
  const sections: Section[] = hasProject
    ? ["workspace", "appearance", "project", "advanced", "about"]
    : ["workspace", "appearance", "advanced", "about"];
  const headingId = useId();

  return (
    <main aria-labelledby={headingId} className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
        <h1 id={headingId} className="m-0 flex-1 text-base font-semibold">
          {t("settings.title")}
        </h1>
        <Button variant="ghost" onClick={() => ui.getState().closeSettings()}>
          {t("settings.close")}
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t("settings.sections")}
          className="w-48 shrink-0 border-r border-border p-2"
        >
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {sections.map((id) => (
              <li key={id}>
                <button
                  type="button"
                  aria-current={id === section ? "page" : undefined}
                  onClick={() => setSection(id)}
                  className={`w-full rounded-sm px-2 py-1 text-left ${
                    id === section
                      ? "bg-item-active text-text"
                      : "text-text-muted hover:bg-item-hover"
                  }`}
                >
                  {t(`settings.${id}`)}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto p-6">
          <div className="flex max-w-2xl flex-col gap-6">
            <h2 className="m-0 text-lg font-semibold">{t(`settings.${section}`)}</h2>
            {section === "workspace" && <WorkspaceSection />}
            {section === "appearance" && <AppearanceSection />}
            {section === "project" && <ProjectSection />}
            {section === "advanced" && <AdvancedSection />}
            {section === "about" && <AboutSection />}
          </div>
        </div>
      </div>
    </main>
  );
}

/** Saves a change; a refused one (invalid) is logged, and the form shows the stored value. */
function useUpdate() {
  const { bridge } = useWorkbench();
  return (patch: SettingsPatch) =>
    void bridge.settings
      .update(patch)
      .catch((error: unknown) => bridge.log("error", `settings update failed: ${String(error)}`));
}

function Field({
  label,
  hint,
  children,
}: {
  label: MessageKey;
  hint?: MessageKey;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium">{t(label)}</span>
      {children}
      {hint && <p className="m-0 text-text-muted">{t(hint)}</p>}
    </div>
  );
}

function WorkspaceSection() {
  const { bridge } = useWorkbench();
  const update = useUpdate();
  const [folder, setFolder] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void bridge.settings.get().then((settings) => {
      if (current) setFolder(settings.workspace.defaultFolder);
    });
    const stop = bridge.settings.onChange((settings) =>
      setFolder(settings.workspace.defaultFolder),
    );
    return () => {
      current = false;
      stop();
    };
  }, [bridge]);
  const change = async () => {
    const picked = await bridge.dialogs
      .pickFolder({ title: t("onboarding.workspace.choose") })
      .catch(() => null);
    if (picked) update({ workspace: { defaultFolder: picked } });
  };
  return (
    <Field label="settings.workspace.folder" hint="settings.workspace.hint">
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-surface-sunken px-2 py-1.5 font-mono">
          {folder ?? t("create.location.none")}
        </code>
        <Button onClick={() => void change()}>{t("create.location.change")}</Button>
      </div>
    </Field>
  );
}

const SCALES = [0.9, 1, 1.1, 1.25, 1.5];
const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 24];

function AppearanceSection() {
  const appearance = useAppearance((state) => state.appearance);
  const update = useUpdate();
  const scaleId = useId();
  const fontId = useId();
  if (!appearance) return null;
  return (
    <>
      <ThemePicker />
      <div className="flex flex-col gap-1">
        <label htmlFor={scaleId} className="font-medium">
          {t("settings.appearance.uiScale")}
        </label>
        <select
          id={scaleId}
          value={appearance.uiScale}
          onChange={(event) => update({ appearance: { uiScale: Number(event.target.value) } })}
          className="w-40 rounded-md border border-border-strong bg-surface-raised px-1.5 py-1 text-text"
        >
          {SCALES.map((scale) => (
            <option key={scale} value={scale}>
              {t("settings.appearance.percent", { value: Math.round(scale * 100) })}
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={appearance.reduceMotion}
          onChange={(event) => update({ appearance: { reduceMotion: event.target.checked } })}
        />
        {t("settings.appearance.reduceMotion")}
      </label>
      <div className="flex flex-col gap-1">
        <label htmlFor={fontId} className="font-medium">
          {t("settings.appearance.editorFontSize")}
        </label>
        <select
          id={fontId}
          value={appearance.editorFontSize ?? ""}
          onChange={(event) =>
            update({
              appearance: {
                editorFontSize: event.target.value === "" ? null : Number(event.target.value),
              },
            })
          }
          className="w-40 rounded-md border border-border-strong bg-surface-raised px-1.5 py-1 text-text"
        >
          <option value="">{t("settings.appearance.fontFromTheme")}</option>
          {FONT_SIZES.map((size) => (
            <option key={size} value={size}>
              {t("settings.appearance.px", { value: size })}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

/** The open project's trust decision, which can be changed here (J-05, FR-006). */
function ProjectSection() {
  const { projects } = useWorkbench();
  const project = useProjects((state) => state.active);
  const busy = useProjects((state) => state.busy);
  const name = useId();
  if (!project) return null;
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-1 p-0 font-medium">
        {t("settings.project.trust", { name: project.name })}
      </legend>
      {(["trusted", "restricted"] as const).map((trust) => (
        <label key={trust} className="flex items-start gap-2">
          <input
            type="radio"
            name={name}
            className="mt-1"
            disabled={busy}
            checked={project.trust === trust}
            onChange={() => void projects.getState().setTrust(trust)}
          />
          <span>
            <span className="block">{t(`project.trust.${trust}`)}</span>
            <span className="block text-text-muted">{t(`settings.project.${trust}`)}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function AdvancedSection() {
  const { bridge } = useWorkbench();
  const ready = useProjects((state) => state.runtime.status === "ready");
  return (
    <>
      <p className="m-0 text-text-muted">{t("settings.advanced.body")}</p>
      <RelayBenchmark bridge={bridge} disabled={!ready} />
    </>
  );
}

function AboutSection() {
  return (
    <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
      <dt className="text-text-muted">{t("settings.about.product")}</dt>
      <dd className="m-0">{t("app.name")}</dd>
      <dt className="text-text-muted">{t("settings.about.protocol")}</dt>
      <dd className="m-0 font-mono">{PROTOCOL_VERSION}</dd>
    </dl>
  );
}
