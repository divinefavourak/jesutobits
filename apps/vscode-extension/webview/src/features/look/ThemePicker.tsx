import type { Remix } from "@jesutobits/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { HostBridge } from "../../host-bridge";
import { t } from "../../i18n";
import { useWorkbench } from "../../state/workbench-context";
import {
  STUDIO_PALETTES,
  paletteNamed,
  readableText,
  remixOf,
  textContrast,
} from "../../themes/studio-palettes";
import { Glyph } from "../../ui/Studio";

const PARTS = ["accent", "canvas", "surfaces", "text"] as const;

type Look = Awaited<ReturnType<HostBridge["look"]["get"]>>;
/** Colour pickers fire on every drag step; settings are written once it settles. */
const REMIX_DELAY_MS = 250;

/**
 * The theme picker (Figma Make "Jesutobits AI Coding Workspace", ThemePicker.tsx): the
 * Studio themes and a remix of the current one. Both change VS Code's real settings
 * (`workbench.colorTheme`, `workbench.colorCustomizations`) through the extension; only the
 * workspace changes, never the user's project.
 */
export function ThemePicker({ onClose }: { onClose: () => void }) {
  const { bridge } = useWorkbench();
  const [theme, setTheme] = useState<string | null>(null);
  const [remix, setRemix] = useState<Remix | null>(null);
  const [remixed, setRemixed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = useCallback((look: Look) => {
    setTheme(look.theme);
    setRemixed(look.remix !== null);
    // Without a remix, the sliders start from the theme's own colours.
    setRemix(look.remix ?? remixOf(paletteNamed(look.theme) ?? STUDIO_PALETTES[0]!));
  }, []);

  const load = async () => show(await bridge.look.get());

  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  // Loads once per opening; a late answer after closing is ignored.
  useEffect(() => {
    let open = true;
    bridge.look
      .get()
      .then((look) => open && show(look))
      .catch((failure: unknown) => open && setError(String(failure)));
    return () => {
      open = false;
    };
  }, [bridge, show]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "Tab") {
        const controls = dialog.current?.querySelectorAll<HTMLElement>("button, input");
        if (!controls?.length) return;
        const first = controls[0]!;
        const last = controls[controls.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(pending.current);
      previous?.focus();
    };
  }, [onClose]);

  const choose = (name: (typeof STUDIO_PALETTES)[number]["name"]) =>
    run(async () => {
      await bridge.look.setTheme(name);
      await load();
    });

  const change = (next: Remix) => {
    setRemix(next);
    setRemixed(true);
    clearTimeout(pending.current);
    pending.current = setTimeout(() => void run(() => bridge.look.remix(next)), REMIX_DELAY_MS);
  };

  const reset = () =>
    run(async () => {
      clearTimeout(pending.current);
      await bridge.look.remix(null);
      await bridge.look.setTheme("Lavender dusk");
      await bridge.look.remix(null);
      await load();
    });

  const ratio = remix ? textContrast(remix) : 21;

  return (
    <div className="absolute inset-0 z-20 flex items-start justify-center bg-canvas/80 p-3 backdrop-blur-sm">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="look-title"
        className="studio-in flex max-h-full w-full flex-col overflow-hidden rounded-xl border border-border-strong bg-surface shadow-lg"
      >
        <header className="flex items-start gap-2 border-b border-border p-4">
          <div className="flex-1">
            <p className="m-0 mb-1 text-xs tracking-widest text-text-muted">{t("look.eyebrow")}</p>
            <h2 id="look-title" className="m-0 font-display text-lg font-medium">
              {t("look.title")}
            </h2>
            <p className="m-0 text-text-muted">{t("look.body")}</p>
          </div>
          <button
            type="button"
            aria-label={t("look.close")}
            onClick={onClose}
            className="rounded-md p-1.5 text-text-muted hover:bg-item-hover hover:text-text"
          >
            <Glyph name="close" size={17} />
          </button>
        </header>

        <div className="flex flex-col gap-3 overflow-y-auto p-4">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="m-0 font-medium">{t("look.pick")}</h3>
            <span className="text-xs text-text-muted">{t("look.instant")}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {STUDIO_PALETTES.map((palette) => {
              const selected = theme === palette.name;
              return (
                <button
                  key={palette.name}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => void choose(palette.name)}
                  className={`flex flex-col gap-1 rounded-lg border p-2 text-left ${selected ? "border-accent ring-2 ring-accent-subtle" : "border-border hover:border-accent"}`}
                >
                  {/* A tiny workspace in the theme's own colours. */}
                  <span
                    aria-hidden="true"
                    className="flex h-12 gap-1 rounded-md p-1.5"
                    style={{ background: palette.bg }}
                  >
                    <span className="w-1/4 rounded-sm" style={{ background: palette.panel }} />
                    <span className="flex flex-1 flex-col gap-1 pt-1">
                      <span
                        className="h-1.5 w-1/2 rounded-full"
                        style={{ background: palette.accent }}
                      />
                      <span
                        className="h-1.5 w-3/4 rounded-full opacity-40"
                        style={{ background: palette.text }}
                      />
                    </span>
                    <span className="w-1/4 rounded-sm" style={{ background: palette.panel }} />
                  </span>
                  <span className="flex items-center justify-between font-medium">
                    {palette.name}
                    {selected && <Glyph name="check" size={13} />}
                  </span>
                  <span className="text-xs text-text-muted">{palette.description}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-2 flex items-start justify-between gap-2">
            <div>
              <h3 className="m-0 font-medium">{t("look.remixTitle")}</h3>
              <p className="m-0 text-text-muted">{t("look.remixBody")}</p>
            </div>
            <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-xs text-accent">
              {remixed ? t("look.custom") : t("look.tryIt")}
            </span>
          </div>
          {remix && (
            <div className="grid grid-cols-2 gap-2">
              {PARTS.map((part) => (
                <label key={part} className="flex flex-col gap-1">
                  <span className="text-text-muted">{t(`look.part.${part}`)}</span>
                  <span className="flex items-center gap-2">
                    <input
                      type="color"
                      value={remix[part]}
                      aria-label={t("look.partLabel", { part: t(`look.part.${part}`) })}
                      onChange={(event) => change({ ...remix, [part]: event.target.value })}
                      className="h-7 w-9 cursor-pointer rounded border border-border-strong bg-transparent"
                    />
                    <code className="text-xs">{remix[part].toUpperCase()}</code>
                  </span>
                </label>
              ))}
            </div>
          )}
          <p role="status" className={`m-0 ${ratio < 4.5 ? "text-warning" : "text-success"}`}>
            {ratio >= 4.5
              ? t("look.contrastOk")
              : t("look.contrastLow", { ratio: ratio.toFixed(1) })}
            {ratio < 4.5 && remix && (
              <button
                type="button"
                onClick={() => change({ ...remix, text: readableText(remix) })}
                className="ml-2 text-accent underline"
              >
                {t("look.improve")}
              </button>
            )}
          </p>
          {error && (
            <p role="alert" className="m-0 text-danger">
              {error}
            </p>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-border p-3">
          <button
            type="button"
            onClick={() => void reset()}
            className="text-text-muted hover:text-text"
          >
            {t("look.reset")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 font-medium text-text-on-accent hover:bg-accent-hover"
          >
            {t("look.done")}
            <Glyph name="check" size={14} />
          </button>
        </footer>
      </div>
    </div>
  );
}
