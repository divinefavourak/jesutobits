import { lazy, Suspense } from "react";
import { t } from "../../i18n";
import { useEditor, useWorkbench } from "../../state/workbench-context";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import type { EditorTab, OpenFile } from "./editor-store";

// Monaco loads with this component, on the first file open (NFR-001).
const CodeEditor = lazy(() => import("./CodeEditor"));

export function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

/** Editor tabs, the "changed on disk" bar and the editor (UX_AND_INTERFACE.md 5.2, FR-073). */
export function EditorPanel() {
  const tabs = useEditor((state) => state.tabs);
  const active = useEditor((state) => state.active);
  const file = useEditor((state) => (state.active ? state.files[state.active] : undefined));
  const error = useEditor((state) => state.error);
  const { editor } = useWorkbench();

  return (
    <div className="flex h-full flex-col">
      {tabs.length > 0 && <Tabs tabs={tabs} active={active} />}
      {active && file?.conflict && <ConflictBar path={active} file={file} />}
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 border-b border-danger bg-danger-subtle px-3 py-1 text-text"
        >
          <p className="m-0">{t("editor.saveFailed", { reason: error })}</p>
          <Button variant="ghost" onClick={() => editor.getState().dismissError()}>
            {t("errors.dismiss")}
          </Button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <Body path={active} file={file} />
      </div>
    </div>
  );
}

function Tabs({ tabs, active }: { tabs: EditorTab[]; active: string | null }) {
  const { editor } = useWorkbench();
  const files = useEditor((state) => state.files);
  return (
    <ul
      aria-label={t("editor.tabs")}
      className="m-0 flex h-8 shrink-0 list-none overflow-x-auto border-b border-border bg-surface p-0"
    >
      {tabs.map((tab) => {
        const name = fileName(tab.path);
        const dirty = files[tab.path]?.dirty ?? false;
        const current = tab.path === active;
        return (
          <li
            key={tab.path}
            className={`flex shrink-0 items-center border-r border-border ${
              current ? "bg-canvas text-text" : "text-text-muted"
            }`}
            onAuxClick={(event) => {
              if (event.button === 1) editor.getState().requestClose(tab.path);
            }}
          >
            <button
              type="button"
              aria-current={current ? "page" : undefined}
              title={tab.path}
              onClick={() => editor.getState().activate(tab.path)}
              onDoubleClick={() => editor.getState().pin(tab.path)}
              className={`flex h-full items-center gap-1 pl-3 pr-1 ${tab.preview ? "italic" : ""}`}
            >
              {name}
              {tab.preview && <span className="sr-only">{`, ${t("editor.previewMark")}`}</span>}
              {dirty && (
                <>
                  <span aria-hidden="true" className="text-accent">
                    ●
                  </span>
                  <span className="sr-only">{`, ${t("editor.unsavedMark")}`}</span>
                </>
              )}
            </button>
            <button
              type="button"
              aria-label={t("editor.close", { name })}
              title={t("editor.close", { name })}
              onClick={() => editor.getState().requestClose(tab.path)}
              className="mr-1 inline-flex size-6 items-center justify-center rounded-sm text-text-muted hover:bg-item-hover hover:text-text"
            >
              <span aria-hidden="true">×</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ConflictBar({ path, file }: { path: string; file: OpenFile }) {
  const { editor } = useWorkbench();
  const conflict = file.conflict;
  if (!conflict) return null;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 border-b border-warning bg-warning-subtle px-3 py-1 text-text"
    >
      <p className="m-0 flex-1">
        {conflict.kind === "deleted"
          ? t("editor.deletedOnDisk")
          : file.comparing
            ? t("editor.comparing")
            : t("editor.changedOnDisk")}
      </p>
      {conflict.kind === "changed" && (
        <>
          <Button onClick={() => editor.getState().setComparing(path, !file.comparing)}>
            {file.comparing ? t("editor.closeCompare") : t("editor.compare")}
          </Button>
          <Button onClick={() => editor.getState().keepMine(path)}>{t("editor.keepMine")}</Button>
          <Button onClick={() => void editor.getState().takeTheirs(path)}>
            {t("editor.takeTheirs")}
          </Button>
        </>
      )}
      {conflict.kind === "deleted" && (
        <Button onClick={() => editor.getState().requestClose(path)}>{t("editor.closeTab")}</Button>
      )}
    </div>
  );
}

function Body({ path, file }: { path: string | null; file: OpenFile | undefined }) {
  if (!path || !file) return <Message text={t("editor.empty")} />;
  const name = fileName(path);
  if (file.status === "loading") return <Message text={t("editor.opening", { name })} />;
  if (file.status === "failed") {
    const code = file.failure?.code;
    const text =
      code === "fs.too_large"
        ? t("editor.tooLarge", { name })
        : code === "fs.binary"
          ? t("editor.binary", { name })
          : code === "fs.not_found"
            ? t("editor.notFound", { name })
            : t("editor.failed", { name, reason: file.failure?.message ?? "" });
    return <Message text={text} />;
  }
  const compare =
    file.comparing && file.conflict?.kind === "changed" ? file.conflict.diskText : null;
  return (
    <Suspense fallback={<Message text={t("editor.opening", { name })} />}>
      <div className="absolute inset-0">
        <CodeEditor path={path} name={name} compare={compare} />
      </div>
    </Suspense>
  );
}

function Message({ text }: { text: string }) {
  return <p className="m-0 p-4 text-text-muted">{text}</p>;
}

/**
 * Closing a tab with unsaved changes (UX_AND_INTERFACE.md 5.2). Rendered by the App, not the
 * panel, so it appears even when the editor panel is hidden.
 */
export function CloseDirtyDialog() {
  const { editor } = useWorkbench();
  const path = useEditor((state) => state.pendingClose);
  const resolve = (choice: "save" | "discard" | "cancel") =>
    void editor.getState().resolveClose(choice);
  return (
    <Dialog
      open={path !== null}
      title={t("editor.closeDirty.title", { name: path ? fileName(path) : "" })}
      description={<p className="m-0">{t("editor.closeDirty.body")}</p>}
      focusSelf
      onCancel={() => resolve("cancel")}
    >
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => resolve("cancel")}>
          {t("editor.cancel")}
        </Button>
        <Button onClick={() => resolve("discard")}>{t("editor.dontSave")}</Button>
        <Button variant="primary" onClick={() => resolve("save")}>
          {t("editor.save")}
        </Button>
      </div>
    </Dialog>
  );
}

/** Closing the project or quitting with unsaved changes. Rendered by the App. */
export function LeaveDialog() {
  const { editor } = useWorkbench();
  const leaving = useEditor((state) => state.leaving);
  const error = useEditor((state) => state.error);
  const unsaved = useEditor((state) => state.unsaved().join("\n"));
  const names = unsaved === "" ? [] : unsaved.split("\n").map(fileName);
  const saveAll = async () => {
    const decide = leaving?.decide;
    if (await editor.getState().saveAll()) decide?.(true);
    // A failed save leaves the dialog open; the editor shows why.
  };
  return (
    <Dialog
      open={leaving !== null}
      title={t(leaving?.reason === "window" ? "editor.leave.window" : "editor.leave.project")}
      description={
        <p className="m-0">
          {t("editor.leave.body", { count: names.length, names: names.join(", ") })}
        </p>
      }
      focusSelf
      onCancel={() => leaving?.decide(false)}
    >
      {error && (
        <p role="alert" className="m-0 mb-3 text-danger">
          {t("editor.saveFailed", { reason: error })}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => leaving?.decide(false)}>
          {t("editor.cancel")}
        </Button>
        <Button onClick={() => leaving?.decide(true)}>{t("editor.dontSave")}</Button>
        <Button variant="primary" onClick={() => void saveAll()}>
          {t("editor.saveAll")}
        </Button>
      </div>
    </Dialog>
  );
}
