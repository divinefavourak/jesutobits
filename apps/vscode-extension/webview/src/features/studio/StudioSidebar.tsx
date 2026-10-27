import type { RuntimeStatus } from "@jesutobits/protocol";
import { useEffect, useState } from "react";
import type { HostBridge } from "../../host-bridge";
import { t } from "../../i18n";
import { Glyph, type GlyphName } from "../../ui/Studio";

/**
 * The Studio's left column (Figma Make "Jesutobits AI Coding Workspace", Studio.tsx) in the
 * Explorer side bar: New project, Recent projects, the Learning Centre, the "Big ideas start
 * small" card, and the agent's real state (invariant 6) with a beginner's tip.
 */
export function StudioSidebar({ bridge }: { bridge: HostBridge }) {
  const [runtime, setRuntime] = useState<RuntimeStatus>("starting");
  const [tip, setTip] = useState(false);

  useEffect(() => bridge.onRuntimeStatus((update) => setRuntime(update.status)), [bridge]);

  const nav: { icon: GlyphName; label: string; onClick: () => void; badge?: string }[] = [
    {
      icon: "clock",
      label: t("studio.side.recent"),
      onClick: () => void bridge.navigate("recent"),
    },
    {
      icon: "book",
      label: t("studio.side.learning"),
      onClick: () => void bridge.navigate("learning"),
      badge: t("studio.side.new"),
    },
    {
      icon: "palette",
      label: t("studio.side.look"),
      onClick: () => void bridge.navigate("look"),
    },
  ];

  const tone =
    runtime === "ready"
      ? "bg-success"
      : runtime === "failed"
        ? "bg-danger"
        : runtime === "degraded"
          ? "bg-warning"
          : "bg-border-strong motion-safe:animate-pulse";

  return (
    <div className="flex min-h-screen flex-col gap-2 bg-transparent px-3 py-2.5 font-ui">
      <button
        type="button"
        onClick={() => void bridge.startProject("new")}
        className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 font-medium text-text-on-accent hover:bg-accent-hover"
      >
        <Glyph name="plus" size={16} />
        {t("studio.side.newProject")}
      </button>

      <nav aria-label={t("studio.side.nav")} className="flex flex-col">
        {nav.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={item.onClick}
            className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-text-muted hover:bg-item-hover hover:text-text"
          >
            <Glyph name={item.icon} size={16} />
            <span className="flex-1">{item.label}</span>
            {item.badge && (
              <span className="rounded-full bg-accent-subtle px-1.5 text-[10px] font-semibold tracking-wide text-accent">
                {item.badge}
              </span>
            )}
          </button>
        ))}
      </nav>

      <section className="flex flex-col gap-1 rounded-xl border border-border bg-surface-raised p-2.5">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-success-subtle text-success">
          <Glyph name="leaf" size={18} />
        </span>
        <h3 className="m-0 font-display text-sm font-medium">{t("studio.side.cardTitle")}</h3>
        <p className="m-0 text-xs leading-relaxed text-text-muted">{t("studio.side.cardBody")}</p>
        <button
          type="button"
          onClick={() => void bridge.navigate("learning")}
          className="flex items-center gap-1 self-start text-xs font-medium text-accent hover:underline"
        >
          {t("studio.side.cardAction")}
          <Glyph name="arrow" size={12} />
        </button>
      </section>

      <div className="mt-auto flex flex-col gap-2">
        <button
          type="button"
          onClick={() => void bridge.openSettings()}
          className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-text-muted hover:bg-item-hover hover:text-text"
        >
          <Glyph name="settings" size={16} />
          {t("studio.side.settings")}
        </button>
        <div className="flex items-center gap-2 px-2 text-xs text-text-muted">
          <i aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${tone}`} />
          <span role="status" className="flex-1">
            {t(`studio.side.status.${runtime}`)}
          </span>
          {runtime === "failed" && (
            <button
              type="button"
              onClick={() => void bridge.restartRuntime()}
              className="text-accent hover:underline"
            >
              {t("studio.side.restart")}
            </button>
          )}
          <button
            type="button"
            aria-expanded={tip}
            aria-label={t("studio.side.tipButton")}
            title={t("studio.side.tipButton")}
            onClick={() => setTip((open) => !open)}
            className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border-strong text-[11px] hover:text-text"
          >
            ?
          </button>
        </div>
        {tip && (
          <section
            aria-label={t("studio.side.tipTitle")}
            className="studio-in flex flex-col gap-1.5 rounded-xl border border-accent-subtle bg-surface-raised p-3"
          >
            <p className="m-0 text-[10px] tracking-widest text-text-muted">
              {t("studio.side.tipEyebrow")}
            </p>
            <h3 className="m-0 font-display text-sm font-medium">{t("studio.side.tipTitle")}</h3>
            <p className="m-0 text-xs leading-relaxed text-text-muted">
              {t("studio.side.tipBody")}
            </p>
            <button
              type="button"
              onClick={() => {
                void bridge.compose(t("studio.side.tipTask"));
                setTip(false);
              }}
              className="flex items-center gap-1 self-start rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-text-on-accent hover:bg-accent-hover"
            >
              {t("studio.side.tipAction")}
              <Glyph name="arrow" size={12} />
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
