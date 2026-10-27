import type { BridgeToWorkbenchMessage } from "@jesutobits/protocol";
import { useId, useState } from "react";
import type { HostBridge } from "../host-bridge";
import { t } from "../i18n";
import { Button } from "../ui/Button";
import { Glyph } from "../ui/Studio";

export type Selection = Extract<BridgeToWorkbenchMessage, { type: "inspect.selected" }>;

const classList = (value: string) => value.split(/\s+/).filter((name) => name !== "");

/**
 * The selected element (VISUAL_EDITING.md section 7): where it comes from, and its classes to
 * edit. Applying is the user's action here; the runtime edits the JSX through
 * WorkspaceService and Vite's HMR shows it (Spike S2). Rendered with a new `key` per
 * selection, so its fields start from the element just clicked.
 */
export function Inspector({
  bridge,
  selection,
}: {
  bridge: HostBridge;
  selection: Selection | null;
}) {
  const [classes, setClasses] = useState(selection?.className ?? "");
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fieldId = useId();

  if (!selection) {
    return (
      <div className="flex flex-col items-center px-4 py-10 text-center text-accent">
        <Glyph name="inspect" size={35} />
        <h3 className="mt-5 mb-3 font-display text-lg font-medium text-text">
          {t("preview.inspector.empty")}
        </h3>
        <p className="m-0 leading-relaxed text-text-muted">{t("preview.inspector.emptyBody")}</p>
      </div>
    );
  }

  const match = /^(.+):(\d+):(\d+)$/.exec(selection.loc);
  const openSource = () => {
    if (!match) return;
    void bridge
      .openFile(match[1]!, { line: Number(match[2]), column: Number(match[3]) })
      .catch(() => undefined);
  };

  const apply = async () => {
    const before = new Set(classList(selection.className));
    const after = new Set(classList(classes));
    const remove = [...before].filter((name) => !after.has(name));
    const add = [...after].filter((name) => !before.has(name));
    if (remove.length === 0 && add.length === 0) {
      setStatus({ tone: "ok", text: t("preview.inspector.unchanged") });
      return;
    }
    setBusy(true);
    try {
      const result = await bridge.rpc("visual.setClasses", { loc: selection.loc, remove, add });
      setStatus({
        tone: "ok",
        text: result.changed
          ? t("preview.inspector.applied", { path: result.path })
          : t("preview.inspector.unchanged"),
      });
    } catch (error) {
      setStatus({
        tone: "error",
        text: t("preview.inspector.failed", {
          reason: error instanceof Error ? error.message : String(error),
        }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label={t("preview.inspector.title")}
      className="studio-in flex flex-col gap-2 p-4"
    >
      <p className="m-0 mb-3 flex items-center gap-2 font-display text-lg font-medium">
        <span className="text-accent">
          <Glyph name="inspect" size={19} />
        </span>
        {t("preview.inspector.title")}
      </p>
      <h2 className="m-0 text-sm font-semibold">
        &lt;{selection.tag}&gt;
        {selection.text && (
          <span className="ml-2 font-normal text-text-muted">“{selection.text}”</span>
        )}
      </h2>
      {selection.component && (
        <p className="m-0">
          <span className="text-text-muted">{t("preview.inspector.component")}: </span>
          {selection.component}
        </p>
      )}
      <p className="m-0">
        <span className="text-text-muted">{t("preview.inspector.source")}: </span>
        <button
          type="button"
          onClick={openSource}
          className="cursor-pointer border-0 bg-transparent p-0 font-mono text-accent hover:underline"
        >
          {selection.loc}
        </button>
      </p>
      <label htmlFor={fieldId} className="font-medium">
        {t("preview.inspector.classes")}
      </label>
      <textarea
        id={fieldId}
        value={classes}
        rows={4}
        spellCheck={false}
        onChange={(event) => setClasses(event.target.value)}
        className="w-full resize-y rounded-md border border-border-strong bg-surface-sunken p-2 font-mono text-text"
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void apply()}>
          {t("preview.inspector.apply")}
        </Button>
        <Button onClick={() => void bridge.compose(askText(selection)).catch(() => undefined)}>
          {t("preview.inspector.ask")}
        </Button>
      </div>
      {status && (
        <p
          role={status.tone === "error" ? "alert" : "status"}
          className={`m-0 ${status.tone === "error" ? "text-danger" : "text-text-muted"}`}
        >
          {status.text}
        </p>
      )}
    </section>
  );
}

/** The element's context for the agent (FR-113); the user writes what to change. */
function askText(selection: Selection): string {
  return t("preview.inspector.askText", {
    tag: selection.tag,
    text: selection.text ? ` "${selection.text.slice(0, 80)}"` : "",
    loc: selection.loc,
    component: selection.component
      ? t("preview.inspector.askComponent", { name: selection.component })
      : "",
    classes: selection.className,
  });
}
