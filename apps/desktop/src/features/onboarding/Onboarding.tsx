import type { MethodResult } from "@jesutobits/protocol";
import { useEffect, useId, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { t, type MessageKey } from "../../i18n";
import { useProjects, useWorkbench } from "../../state/workbench-context";
import { Button } from "../../ui/Button";
import { KeyForm, ModelPicker } from "../agent/ProviderSetup";
import { ThemePicker } from "../appearance/ThemePicker";
import { CreateProjectDialog } from "../projects/CreateProjectDialog";
import { ONBOARDING_STEPS, SKIPPABLE, type OnboardingStep } from "./onboarding-store";

/**
 * First-run onboarding (FR-001, J-01, UX_AND_INTERFACE.md section 3): seven steps with a step
 * indicator, Back, and Skip where allowed. Companions arrive in Phase 6.
 */
export function Onboarding() {
  const { onboarding } = useWorkbench();
  const step = useStore(onboarding, (state) => state.step);
  const id = ONBOARDING_STEPS[step] ?? "welcome";
  const headingId = useId();

  return (
    <main
      aria-labelledby={headingId}
      className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 overflow-y-auto px-6 py-10"
    >
      <StepIndicator current={step} />
      <h1 id={headingId} className="m-0 text-2xl font-semibold">
        {t(`onboarding.${id}.title`)}
      </h1>
      <StepContent step={id} />
    </main>
  );
}

function StepIndicator({ current }: { current: number }) {
  return (
    <nav aria-label={t("onboarding.progress")}>
      <p className="m-0 mb-2 text-text-muted">
        {t("onboarding.stepOf", { step: current + 1, total: ONBOARDING_STEPS.length })}
      </p>
      <ol className="m-0 flex list-none gap-1 p-0">
        {ONBOARDING_STEPS.map((step, index) => (
          <li
            key={step}
            aria-current={index === current ? "step" : undefined}
            className={`h-1.5 flex-1 rounded-sm ${index <= current ? "bg-accent" : "bg-border"}`}
          >
            <span className="sr-only">{t(`onboarding.${step}.title`)}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function StepContent({ step }: { step: OnboardingStep }) {
  switch (step) {
    case "welcome":
      return <Welcome />;
    case "workspace":
      return <WorkspaceFolder />;
    case "toolchain":
      return <Toolchain />;
    case "provider":
      return <Provider />;
    case "credentials":
      return <Credentials />;
    case "look":
      return (
        <Later text="onboarding.look.companionLater" step={step}>
          <ThemePicker />
        </Later>
      );
    case "project":
      return <FirstProject />;
  }
}

/** Back, Skip (where allowed) and Continue, the same on every step. */
function Footer({
  step,
  onContinue,
  continueLabel = "onboarding.continue",
  busy = false,
}: {
  step: OnboardingStep;
  onContinue: () => void;
  continueLabel?: MessageKey;
  busy?: boolean;
}) {
  const { onboarding } = useWorkbench();
  const first = step === "welcome";
  return (
    <div className="mt-2 flex items-center gap-2">
      {!first && (
        <Button variant="ghost" onClick={() => onboarding.getState().back()}>
          {t("onboarding.back")}
        </Button>
      )}
      <span className="flex-1" />
      {SKIPPABLE.has(step) && (
        <Button variant="ghost" onClick={() => onboarding.getState().next()}>
          {t("onboarding.skip")}
        </Button>
      )}
      <Button variant="primary" disabled={busy} onClick={onContinue}>
        {t(continueLabel)}
      </Button>
    </div>
  );
}

function Welcome() {
  const { onboarding } = useWorkbench();
  return (
    <>
      <p className="m-0 text-lg">{t("onboarding.welcome.body")}</p>
      <Footer
        step="welcome"
        continueLabel="onboarding.getStarted"
        onContinue={() => onboarding.getState().next()}
      />
    </>
  );
}

/** Suggests Documents\Jesutobits Projects; the folder is created only on Continue (FR-002). */
function WorkspaceFolder() {
  const { bridge, onboarding } = useWorkbench();
  const [folder, setFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const labelId = useId();

  useEffect(() => {
    let current = true;
    void (async () => {
      const chosen = (await bridge.settings.get()).workspace.defaultFolder;
      const documents = chosen ? null : await bridge.paths.documents();
      if (!current) return;
      setFolder((existing) => existing ?? chosen ?? (documents && suggestIn(documents)));
    })();
    return () => {
      current = false;
    };
  }, [bridge]);

  const change = async () => {
    const picked = await bridge.dialogs
      .pickFolder({
        title: t("onboarding.workspace.choose"),
        ...(folder && { defaultPath: folder }),
      })
      .catch(() => null);
    if (picked) setFolder(picked);
  };

  const confirm = async () => {
    if (!folder) return;
    setBusy(true);
    setError(null);
    try {
      const { path } = await bridge.rpc("projects.prepareWorkspaceFolder", { path: folder });
      await bridge.settings.update({ workspace: { defaultFolder: path } });
      onboarding.getState().next();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="m-0">{t("onboarding.workspace.body")}</p>
      <div className="flex flex-col gap-1">
        <span id={labelId} className="font-medium">
          {t("onboarding.workspace.folder")}
        </span>
        <div className="flex items-center gap-2">
          <code
            aria-labelledby={labelId}
            className="min-w-0 flex-1 truncate rounded-md bg-surface-sunken px-2 py-1.5 font-mono"
          >
            {folder ?? t("create.location.none")}
          </code>
          <Button onClick={() => void change()}>{t("create.location.change")}</Button>
        </div>
        <p className="m-0 text-text-muted">{t("onboarding.workspace.note")}</p>
      </div>
      {error && (
        <p role="alert" className="m-0 text-danger">
          {t("onboarding.workspace.failed", { reason: error })}
        </p>
      )}
      <Footer step="workspace" busy={busy || !folder} onContinue={() => void confirm()} />
    </>
  );
}

function suggestIn(documents: string): string {
  const separator = documents.includes("\\") ? "\\" : "/";
  const base = documents.endsWith(separator) ? documents.slice(0, -1) : documents;
  return `${base}${separator}Jesutobits Projects`;
}

type Tool = MethodResult<"toolchain.detect">["tools"][number];

const INSTALL: Record<"git" | "node" | "packageManager", string> = {
  git: "https://git-scm.com/downloads",
  node: "https://nodejs.org/en/download",
  packageManager: "https://nodejs.org/en/download",
};

/** Git, Node.js and a package manager: found or missing, never blocking (FR-010). */
function Toolchain() {
  const { bridge, onboarding } = useWorkbench();
  const ready = useProjects((state) => state.runtime.status === "ready");
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    let current = true;
    bridge.rpc("toolchain.detect", {}).then(
      (result) => current && setTools(result.tools),
      (failure: unknown) => current && setError(String(failure)),
    );
    return () => {
      current = false;
    };
  }, [bridge, ready]);

  const found = (name: Tool["name"]) => tools?.find((tool) => tool.name === name && tool.found);
  const managers = tools?.filter(
    (tool) => tool.found && ["npm", "pnpm", "yarn", "bun"].includes(tool.name),
  );
  const rows: Array<{ key: "git" | "node" | "packageManager"; found: string | null }> = tools
    ? [
        { key: "git", found: found("git") ? (found("git")?.version ?? "") : null },
        { key: "node", found: found("node") ? (found("node")?.version ?? "") : null },
        {
          key: "packageManager",
          found:
            managers && managers.length > 0
              ? managers.map((tool) => `${tool.name} ${tool.version ?? ""}`.trim()).join(", ")
              : null,
        },
      ]
    : [];

  return (
    <>
      <p className="m-0">{t("onboarding.toolchain.body")}</p>
      {error ? (
        <p role="alert" className="m-0 text-danger">
          {t("onboarding.toolchain.failed", { reason: error })}
        </p>
      ) : !tools ? (
        <p role="status" className="m-0 text-text-muted">
          {t("onboarding.toolchain.checking")}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {rows.map((row) => (
            <li key={row.key} className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{t(`onboarding.toolchain.${row.key}`)}</span>
                <span className={row.found !== null ? "text-text" : "text-text-muted"}>
                  {row.found !== null
                    ? t("onboarding.toolchain.found", { version: row.found || "?" })
                    : t("onboarding.toolchain.missing")}
                </span>
              </div>
              {row.found === null && (
                <details className="mt-2">
                  <summary className="cursor-pointer">{t("onboarding.toolchain.why")}</summary>
                  <p className="m-0 mt-1">{t(`onboarding.toolchain.${row.key}.why`)}</p>
                  <InstallLink url={INSTALL[row.key]} />
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      <Footer step="toolchain" onContinue={() => onboarding.getState().next()} />
    </>
  );
}

/** Jesutobits does not open web pages yet; the address is shown with a Copy button. */
function InstallLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <p className="m-0 mt-2 flex flex-wrap items-center gap-2">
      {t("onboarding.toolchain.install")}
      <code className="rounded-sm bg-surface-sunken px-1 font-mono">{url}</code>
      <Button
        variant="ghost"
        onClick={() =>
          void navigator.clipboard.writeText(url).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? t("onboarding.toolchain.copied") : t("onboarding.toolchain.copy")}
      </Button>
    </p>
  );
}

function Later({
  text,
  step,
  children,
}: {
  text: MessageKey;
  step: OnboardingStep;
  children: ReactNode;
}) {
  const { onboarding } = useWorkbench();
  return (
    <>
      {children}
      <p className="m-0 text-text-muted">{t(text)}</p>
      <Footer step={step} onContinue={() => onboarding.getState().next()} />
    </>
  );
}

/** OpenRouter is the only provider in the MVP (ADR-0005); the step says so plainly. */
function Provider() {
  const { onboarding } = useWorkbench();
  return (
    <>
      <p className="m-0">{t("onboarding.provider.body")}</p>
      <div className="rounded-md border border-accent bg-accent-subtle p-3">
        <p className="m-0 font-medium">{t("onboarding.provider.openrouter")}</p>
        <p className="m-0 mt-1">{t("onboarding.provider.openrouterBody")}</p>
      </div>
      <p className="m-0 text-text-muted">{t("onboarding.provider.others")}</p>
      <Footer step="provider" onContinue={() => onboarding.getState().next()} />
    </>
  );
}

/** The key goes to the system's credential store (FR-021); then a default model (FR-022). */
function Credentials() {
  const { onboarding } = useWorkbench();
  return (
    <>
      <p className="m-0">{t("onboarding.credentials.body")}</p>
      <KeyForm />
      <ModelPicker />
      <Footer step="credentials" onContinue={() => onboarding.getState().next()} />
    </>
  );
}

/** Ends in the Workbench (a new or opened project) or on the start screen. */
function FirstProject() {
  const { bridge, onboarding, projects } = useWorkbench();
  const ready = useProjects((state) => state.runtime.status === "ready");
  const [creating, setCreating] = useState(false);
  const finish = () => onboarding.getState().finish();

  const openFolder = async () => {
    const path = await bridge.dialogs
      .pickFolder({ title: t("start.openFolder.title") })
      .catch(() => null);
    if (!path) return;
    await projects.getState().openFolder(path);
    if (projects.getState().active) finish();
  };

  return (
    <>
      <p className="m-0">{t("onboarding.project.body")}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={!ready} onClick={() => setCreating(true)}>
          {t("start.newProject")}
        </Button>
        <Button disabled={!ready} onClick={() => void openFolder()}>
          {t("start.openFolder")}
        </Button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button variant="ghost" onClick={() => onboarding.getState().back()}>
          {t("onboarding.back")}
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" onClick={finish}>
          {t("onboarding.toStart")}
        </Button>
      </div>
      <CreateProjectDialog
        open={creating}
        onClose={() => {
          setCreating(false);
          if (projects.getState().active) finish();
        }}
      />
    </>
  );
}
