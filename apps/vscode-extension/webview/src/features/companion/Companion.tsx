import { previewStatusEvent, type PreviewState, type RuntimeStatus } from "@jesutobits/protocol";
import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { useAgent, useWorkbench } from "../../state/workbench-context";
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

  useEffect(() => bridge.onRuntimeStatus((update) => setRuntime(update.status)), [bridge]);
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

  return (
    <div className="flex items-center gap-2" data-companion-state={state}>
      <CompanionMark state={state} kind={kind} />
      <span role="status" aria-live="polite" className="text-xs text-text-muted">
        {t(`companion.${state}`)}
      </span>
    </div>
  );
}

const RING: Record<string, string> = {
  blocking: "ring-2 ring-warning",
  sticky: "ring-2 ring-danger",
};

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
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      aria-hidden="true"
      className={`shrink-0 rounded-md ${motion} ${tone} ${state === "unavailable" ? "opacity-40" : ""}`}
    >
      <rect width="24" height="24" rx="5" fill="var(--jesutobits-color-surface-sunken)" />
      <path
        d="M14 5h3v9.5a4.5 4.5 0 0 1-9 0V13h3v1.5a1.5 1.5 0 0 0 3 0z"
        fill="var(--jesutobits-color-accent)"
      />
    </svg>
  );
}
