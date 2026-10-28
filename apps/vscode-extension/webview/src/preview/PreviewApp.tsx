import { previewStatusEvent, type PreviewStatus } from "@jesutobits/protocol";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { HostBridge } from "../host-bridge";
import { t } from "../i18n";
import { Button } from "../ui/Button";
import { Glyph } from "../ui/Studio";
import { BridgeClient } from "./bridge-client";
import { Inspector, type Selection } from "./Inspector";

const STOPPED: PreviewStatus = {
  state: "stopped",
  strategy: null,
  url: null,
  detail: null,
  log: [],
};

/**
 * The preview panel (ROADMAP Phases 4 and 5): the project's running app, its state from
 * runtime events only (invariant 6), and in Vite React projects the visual-editing inspector.
 */
export function PreviewApp({ bridge }: { bridge: HostBridge }) {
  const [status, setStatus] = useState<PreviewStatus>(STOPPED);
  const [error, setError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  /** Counts selections, so the inspector starts fresh for each click. */
  const [selectionCount, setSelectionCount] = useState(0);
  const [frameKey, setFrameKey] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const client = useRef<BridgeClient | null>(null);

  useEffect(() => {
    void bridge
      .rpc("preview.get", {})
      .then(setStatus)
      .catch(() => undefined);
    return bridge.onRuntimeEvent((event) => {
      const parsed = previewStatusEvent.payload.safeParse(event);
      if (parsed.success) setStatus(parsed.data.status);
    });
  }, [bridge]);

  const visual = status.strategy === "vite-react";
  const url = status.state === "ready" ? status.url : null;

  // A bridge client per loaded page: new origin or reload means a new nonce.
  const onFrameLoad = useCallback(() => {
    client.current?.dispose();
    client.current = null;
    if (!frame.current || !url || !visual) return;
    client.current = new BridgeClient(frame.current, url, (message) => {
      if (message.type === "inspect.selected") {
        setSelection(message);
        setSelectionCount((count) => count + 1);
      }
    });
    client.current.setInspect(inspecting);
  }, [url, visual, inspecting]);

  useEffect(() => client.current?.setInspect(inspecting), [inspecting]);
  useEffect(() => () => client.current?.dispose(), []);

  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const stopped = status.state === "stopped" || status.state === "failed";
  const running = status.state === "running";
  const start = () => void run(() => bridge.rpc("preview.start", {}));
  const startWith = (command: string[]) => void run(() => bridge.rpc("preview.start", { command }));
  const strategyLabel =
    status.strategy === "vite-react"
      ? t("preview.viteReact")
      : status.strategy === "static"
        ? t("preview.staticSite")
        : status.strategy && status.command
          ? t("preview.command", { command: status.command })
          : status.strategy && t("preview.devScript");
  const address = url?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? null;

  return (
    <div className="flex h-screen flex-col bg-canvas font-ui">
      <header className="flex flex-wrap items-center gap-2 px-3 pt-3 pb-2">
        {/* While it rests, the one Start button is the empty state's. */}
        {!stopped && (
          <Button onClick={() => void run(() => bridge.rpc("preview.stop", {}))}>
            <Glyph name="stop" size={14} />
            {t("preview.stop")}
          </Button>
        )}
        {url && visual && (
          <Button
            variant={inspecting ? "primary" : "secondary"}
            aria-pressed={inspecting}
            title={t("preview.inspectHint")}
            onClick={() => setInspecting((on) => !on)}
          >
            <Glyph name="inspect" size={14} />
            {inspecting ? t("preview.exitInspect") : t("preview.inspect")}
          </Button>
        )}
        {url && (
          <span className="ml-auto flex items-center gap-1">
            <IconButton label={t("preview.reload")} onClick={() => setFrameKey((key) => key + 1)}>
              <Glyph name="reload" size={15} />
            </IconButton>
            <IconButton
              label={t("preview.openExternal")}
              onClick={() => void run(() => bridge.openExternal(url))}
            >
              <Glyph name="external" size={15} />
            </IconButton>
          </span>
        )}
      </header>

      {error && (
        <p role="alert" className="m-0 mx-3 mb-2 rounded-md bg-danger-subtle p-2 text-danger">
          {error}
        </p>
      )}
      {status.strategy === "generic" && status.detail && status.state !== "failed" && (
        <p className="m-0 mx-3 mb-2 text-text-muted">
          {t("preview.genericNote", { reason: status.detail })}
        </p>
      )}

      <main className="flex min-h-0 flex-1 gap-3 px-3">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
          {/* The browser bar: the real address, and what a click does right now. */}
          <div className="flex items-center gap-3 border-b border-border px-3 py-2">
            <span className="flex gap-1.5" aria-hidden="true">
              <i className="h-2.5 w-2.5 rounded-full bg-border-strong" />
              <i className="h-2.5 w-2.5 rounded-full bg-border-strong" />
              <i className="h-2.5 w-2.5 rounded-full bg-border-strong" />
            </span>
            <span className="flex min-w-0 items-center gap-1.5 rounded-full bg-surface-sunken px-3 py-1 text-xs text-text-muted">
              <Glyph name="shield" size={11} />
              <span className="truncate font-mono">{address ?? t("preview.noAddress")}</span>
            </span>
            <span className="ml-auto truncate text-xs text-text-muted">
              {inspecting ? t("preview.inspectingHint") : t("preview.addressHint")}
            </span>
          </div>
          {url ? (
            <iframe
              key={frameKey}
              ref={frame}
              src={url}
              title={t("preview.title")}
              onLoad={onFrameLoad}
              className="h-full w-full flex-1 border-0 bg-white"
            />
          ) : (
            <div className="flex flex-1 flex-col items-center gap-3 overflow-auto p-6 text-center">
              <span className="mt-6 text-accent">
                <Glyph name={status.state === "starting" ? "reload" : "play"} size={36} />
              </span>
              <h2 className="m-0 font-display text-lg font-medium">
                {status.state === "starting"
                  ? t("preview.startingTitle")
                  : status.state === "failed"
                    ? t("preview.failedTitle")
                    : running
                      ? t("preview.runningTitle")
                      : t("preview.stoppedTitle")}
              </h2>
              <p className="m-0 max-w-md text-text-muted">
                {status.state === "starting"
                  ? t("preview.starting")
                  : status.state === "failed"
                    ? t("preview.failed", { detail: status.detail ?? "" })
                    : running
                      ? t("preview.running")
                      : t("preview.stopped")}
              </p>
              {stopped && (
                <Button variant="primary" onClick={start}>
                  {t("preview.start")}
                </Button>
              )}
              {stopped && (
                <CommandForm
                  initial={status.strategy === "command" ? (status.command ?? "") : ""}
                  open={error !== null || status.state === "failed"}
                  onStart={startWith}
                />
              )}
              {status.log.length > 0 && (
                <section
                  aria-label={running ? t("preview.output") : t("preview.log")}
                  className="w-full text-left"
                >
                  <pre
                    className={`m-0 overflow-auto rounded-md bg-surface-sunken p-2 font-mono text-xs ${running ? "max-h-[60vh]" : "max-h-96"}`}
                  >
                    {status.log.slice(running ? -200 : -60).join("\n")}
                  </pre>
                </section>
              )}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-1.5 text-xs text-text-muted">
            <span className="flex items-center gap-1.5">
              <i
                aria-hidden="true"
                className={`h-2 w-2 rounded-full ${url || running ? "bg-success" : status.state === "failed" ? "bg-danger" : "bg-border-strong"}`}
              />
              {url ? t("preview.ready") : t(`preview.state.${status.state}`)}
            </span>
            {strategyLabel && <span className="truncate">{strategyLabel}</span>}
          </div>
        </div>
        {url && visual && (
          <aside className="w-72 shrink-0 overflow-auto rounded-xl border border-border bg-surface">
            <Inspector key={selectionCount} bridge={bridge} selection={selection} />
          </aside>
        )}
      </main>
      <p className="m-0 flex items-center gap-1.5 px-3 py-2 text-xs text-text-muted">
        <Glyph name="shield" size={12} />
        {t("preview.caption")}
      </p>
    </div>
  );
}

/**
 * For a project Jesutobits cannot start by itself (Python, Go, a game...): the user types
 * the command once and it is saved for the project. Run without a shell, like the agent's.
 */
function CommandForm({
  initial,
  open,
  onStart,
}: {
  initial: string;
  open: boolean;
  onStart: (command: string[]) => void;
}) {
  const [text, setText] = useState(initial);
  const inputId = useId();
  const hintId = useId();
  const command = splitCommand(text);
  return (
    <details open={open} className="w-full max-w-md text-left">
      <summary className="cursor-pointer text-text-muted">{t("preview.otherWay")}</summary>
      <form
        className="mt-2 flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (command.length > 0) onStart(command);
        }}
      >
        <label htmlFor={inputId} className="font-medium">
          {t("preview.commandLabel")}
        </label>
        <input
          id={inputId}
          aria-describedby={hintId}
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          placeholder="python app.py"
          className="rounded-md border border-border-strong bg-surface-sunken px-2 py-1.5 font-mono text-xs"
        />
        <p id={hintId} className="m-0 text-xs text-text-muted">
          {t("preview.commandHint")}
        </p>
        <Button type="submit" disabled={command.length === 0}>
          {t("preview.commandStart")}
        </Button>
      </form>
    </details>
  );
}

/** `python "my app.py" --debug` -> ["python", "my app.py", "--debug"]: spaces split, quotes group. */
export function splitCommand(text: string): string[] {
  const parts: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    parts.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return parts.filter((part) => part !== "");
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="rounded-md p-1.5 text-text-muted hover:bg-item-hover hover:text-text"
    >
      {children}
    </button>
  );
}
