import {
  previewStatusEvent,
  type CompanionSkin,
  type PreviewState,
  type RuntimeStatus,
} from "@jesutobits/protocol";
import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { useAgent, useWorkbench } from "../../state/workbench-context";
import { Buddy } from "../../ui/Studio";
import { COMPANION_KIND, deriveCompanionState, type CompanionState } from "./companion-state";

/**
 * The companion (COMPANION_SYSTEM.md): a small "J" beside the agent panel's header that shows
 * what the agent is actually doing, from runtime events only (invariant 6). The motion is CSS,
 * calm, and off under reduced motion; the state is also said in words for screen readers.
 */
export function Companion() {
  const { bridge } = useWorkbench();
  const timeline = useAgent((state) => state.timeline);
  const [runtime, setRuntime] = useState<RuntimeStatus>("starting");
  const [preview, setPreview] = useState<{ state: PreviewState; changedAt: number }>({
    state: "stopped",
    changedAt: 0,
  });
  const [now, setNow] = useState(() => Date.now());
  const [skin, setSkin] = useState<CompanionSkin>("buddy");

  useEffect(() => bridge.onRuntimeStatus((update) => setRuntime(update.status)), [bridge]);
  useEffect(() => {
    let live = true;
    bridge.settings
      .get()
      .then((settings) => live && setSkin(settings.companion.skin))
      .catch(() => undefined);
    const off = bridge.settings.onChange((settings) => setSkin(settings.companion.skin));
    return () => {
      live = false;
      off();
    };
  }, [bridge]);
  useEffect(
    () =>
      bridge.onRuntimeEvent((event) => {
        const parsed = previewStatusEvent.payload.safeParse(event);
        if (parsed.success) setPreview({ state: parsed.data.status.state, changedAt: Date.now() });
      }),
    [bridge],
  );

  const state = deriveCompanionState({ timeline, runtime, preview, now });
  const kind = COMPANION_KIND[state];

  // Transient and sticky states expire; re-derive once they may have. Nothing else ticks.
  useEffect(() => {
    if (kind !== "transient" && kind !== "sticky") return;
    const timer = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(timer);
  }, [kind, now, state]);

  const chip =
    kind === "blocking"
      ? "bg-warning-subtle text-warning"
      : kind === "sticky"
        ? "bg-danger-subtle text-danger"
        : "bg-success-subtle text-success";
  return (
    <div
      className="flex min-w-0 items-center gap-2"
      data-companion-state={state}
      data-companion-skin={skin}
    >
      {skin === "buddy" && <Buddy className="buddy-companion" kind={kind} />}
      {skin === "mark" && <CompanionMark state={state} kind={kind} />}
      {skin === "dot" && <CompanionDot state={state} kind={kind} />}
      <strong className="font-display text-[13px] font-medium">{t("studio.coBuilder")}</strong>
      <span
        role="status"
        aria-live="polite"
        className={`truncate rounded-full px-2 py-0.5 text-[11px] ${chip}`}
      >
        {t(`companion.${state}`)}
      </span>
    </div>
  );
}

const RING: Record<string, string> = {
  blocking: "ring-2 ring-warning",
  sticky: "ring-2 ring-danger",
};

/** The pixel "J" (the Studio design's mark), moving only while the agent really works. */
function CompanionMark({ state, kind }: { state: CompanionState; kind: string }) {
  const motion =
    kind === "active"
      ? "motion-safe:animate-pulse"
      : kind === "blocking"
        ? "motion-safe:animate-bounce"
        : "";
  const tone =
    state === "completed" || state === "preview_ready" ? "ring-2 ring-success" : (RING[kind] ?? "");
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-accent-subtle text-accent ${motion} ${tone} ${state === "unavailable" ? "opacity-40" : ""}`}
    >
      <svg viewBox="0 0 32 32" width="20" height="20">
        <path d="M8 6h18v6h-5v14H9v-5H4v-7h6v6h5v-8H8z" fill="currentColor" />
      </svg>
    </span>
  );
}

/** The minimal skin: one dot in the state's colour, pulsing only while the agent works. */
function CompanionDot({ state, kind }: { state: CompanionState; kind: string }) {
  const colour =
    kind === "blocking"
      ? "bg-warning"
      : kind === "sticky"
        ? "bg-danger"
        : kind === "active"
          ? "bg-accent motion-safe:animate-pulse"
          : state === "unavailable"
            ? "bg-text-muted opacity-50"
            : "bg-success";
  return <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-full ${colour}`} />;
}
