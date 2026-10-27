import { previewStatusEvent, type PreviewStatus } from "@jesutobits/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { HostBridge } from "../host-bridge";
import { t } from "../i18n";
import { Button } from "../ui/Button";
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

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        {status.state === "stopped" || status.state === "failed" ? (
          <Button variant="primary" onClick={() => void run(() => bridge.rpc("preview.start", {}))}>
            {t("preview.start")}
          </Button>
        ) : (
          <Button onClick={() => void run(() => bridge.rpc("preview.stop", {}))}>
            {t("preview.stop")}
          </Button>
        )}
        {url && (
          <>
            <Button onClick={() => setFrameKey((key) => key + 1)}>{t("preview.reload")}</Button>
            <Button onClick={() => void run(() => bridge.openExternal(url))}>
              {t("preview.openExternal")}
            </Button>
            {visual && (
              <Button
                variant={inspecting ? "primary" : "secondary"}
                aria-pressed={inspecting}
                title={t("preview.inspectHint")}
                onClick={() => setInspecting((on) => !on)}
              >
                {t("preview.inspect")}
              </Button>
            )}
            <span className="truncate font-mono text-text-muted">{url}</span>
          </>
        )}
      </header>

      {error && (
        <p role="alert" className="m-0 border-b border-border p-2 text-danger">
          {error}
        </p>
      )}
      {status.strategy === "generic" && status.detail && status.state !== "failed" && (
        <p className="m-0 border-b border-border p-2 text-text-muted">
          {t("preview.genericNote", { reason: status.detail })}
        </p>
      )}

      <main className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
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
            <div className="flex flex-1 flex-col gap-2 overflow-auto p-4">
              <p className="m-0">
                {status.state === "starting"
                  ? t("preview.starting")
                  : status.state === "failed"
                    ? t("preview.failed", { detail: status.detail ?? "" })
                    : t("preview.stopped")}
              </p>
              {status.log.length > 0 && (
                <section aria-label={t("preview.log")}>
                  <pre className="m-0 max-h-96 overflow-auto rounded-md bg-surface-sunken p-2 font-mono text-xs">
                    {status.log.slice(-60).join("\n")}
                  </pre>
                </section>
              )}
            </div>
          )}
        </div>
        {url && visual && (
          <aside className="w-72 shrink-0 overflow-auto border-l border-border">
            <Inspector key={selectionCount} bridge={bridge} selection={selection} />
          </aside>
        )}
      </main>
    </div>
  );
}
