import { useEffect, useId, useState, type DragEvent, type KeyboardEvent } from "react";
import { t } from "../../i18n";
import { useLayout, useWorkbench } from "../../state/workbench-context";
import { CollapseIcon, MoreIcon } from "../../ui/icons";
import { Menu } from "../../ui/Menu";
import { Splitter } from "../../ui/Splitter";
import {
  maxSize,
  MIN_SIZE,
  movePanel,
  resizeZone,
  showPanel,
  toggleZone,
  ZONE_IDS,
  type Layout,
  type PanelId,
  type ZoneId,
} from "./layout-model";
import { PANELS } from "./panels";

/** dataTransfer type of a dragged panel tab. */
const PANEL_MIME = "application/x-jesutobits-panel";

/**
 * The four dock zones (UX_AND_INTERFACE.md section 4.2): tabs per zone, splitters that work
 * with the keyboard, collapsed zones as icon rails, and panels that move by dragging their
 * tab or with "Move to…" in the panel menu.
 */
export function DockLayout() {
  const layout = useLayout((state) => state.layout);
  const window = useWindowSize();
  if (!layout) return <main className="min-h-0 flex-1" aria-busy="true" />;

  const shown = (id: ZoneId) =>
    id === "center" || (!layout.zones[id].collapsed && layout.zones[id].panels.length > 0);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <ZoneView layout={layout} id="left" window={window} shown={shown("left")} />
        {shown("left") && <ZoneSplitter layout={layout} id="left" window={window} />}
        <ZoneView layout={layout} id="center" window={window} shown />
        {shown("right") && <ZoneSplitter layout={layout} id="right" window={window} />}
        <ZoneView layout={layout} id="right" window={window} shown={shown("right")} />
      </div>
      {shown("bottom") && <ZoneSplitter layout={layout} id="bottom" window={window} />}
      <ZoneView layout={layout} id="bottom" window={window} shown={shown("bottom")} />
    </main>
  );
}

type WindowSize = { width: number; height: number };

function useWindowSize(): WindowSize {
  const read = () => ({ width: globalThis.innerWidth, height: globalThis.innerHeight });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const onResize = () => setSize(read());
    globalThis.addEventListener("resize", onResize);
    return () => globalThis.removeEventListener("resize", onResize);
  }, []);
  return size;
}

function ZoneSplitter({
  layout,
  id,
  window,
}: {
  layout: Layout;
  id: Exclude<ZoneId, "center">;
  window: WindowSize;
}) {
  const { layout: store } = useWorkbench();
  const max = maxSize(layout, id, window);
  return (
    <Splitter
      label={t("layout.resize", { zone: t(`layout.zone.${id}`) })}
      orientation={id === "bottom" ? "horizontal" : "vertical"}
      value={Math.min(layout.zones[id].size, max)}
      min={MIN_SIZE[id]}
      max={max}
      direction={id === "left" ? 1 : -1}
      onResize={(size) =>
        store.getState().update((current) => resizeZone(current, id, size, window))
      }
    />
  );
}

function ZoneView({
  layout,
  id,
  window,
  shown,
}: {
  layout: Layout;
  id: ZoneId;
  window: WindowSize;
  shown: boolean;
}) {
  const { layout: store } = useWorkbench();
  const [dropping, setDropping] = useState(false);
  const zone = layout.zones[id];
  const label = t(`layout.zone.${id}`);

  const dropProps = {
    "data-zone": id,
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(PANEL_MIME)) return;
      event.preventDefault();
      setDropping(true);
    },
    onDragLeave: () => setDropping(false),
    onDrop: (event: DragEvent) => {
      setDropping(false);
      const panel = event.dataTransfer.getData(PANEL_MIME) as PanelId;
      if (!(panel in PANELS)) return;
      event.preventDefault();
      store.getState().update((current) => movePanel(current, panel, id));
    },
  };
  const dropRing = dropping ? "outline outline-2 -outline-offset-2 outline-accent" : "";

  if (!shown) {
    const vertical = id !== "bottom";
    return (
      <section
        aria-label={label}
        {...dropProps}
        className={`flex shrink-0 gap-1 bg-surface ${dropRing} ${
          vertical
            ? `w-8 flex-col items-center py-1 ${id === "left" ? "border-r" : "border-l"} border-border`
            : "h-8 flex-row items-center border-t border-border px-1"
        }`}
      >
        {zone.panels.map((panel) => {
          const { Icon, title } = PANELS[panel];
          return (
            <button
              key={panel}
              type="button"
              aria-label={t("layout.show", { panel: t(title) })}
              title={t("layout.show", { panel: t(title) })}
              onClick={() => store.getState().update((current) => showPanel(current, panel))}
              className="inline-flex rounded-sm p-1 text-text-muted hover:bg-item-hover hover:text-text"
            >
              <Icon />
            </button>
          );
        })}
      </section>
    );
  }

  const style =
    id === "center"
      ? { minWidth: MIN_SIZE.center }
      : id === "bottom"
        ? { height: Math.min(zone.size, maxSize(layout, id, window)) }
        : { width: Math.min(zone.size, maxSize(layout, id, window)) };

  return (
    <section
      aria-label={label}
      {...dropProps}
      style={style}
      className={`flex min-h-0 min-w-0 flex-col bg-canvas ${id === "center" ? "flex-1" : "shrink-0"} ${dropRing}`}
    >
      {zone.panels.length === 0 ? (
        <p className="m-0 p-4 text-text-muted">{t("layout.empty")}</p>
      ) : (
        <Tabs id={id} panels={zone.panels} active={zone.active ?? zone.panels[0]!} />
      )}
    </section>
  );
}

function Tabs({ id, panels, active }: { id: ZoneId; panels: PanelId[]; active: PanelId }) {
  const { layout: store } = useWorkbench();
  const prefix = useId();
  const tabId = (panel: PanelId) => `${prefix}-tab-${panel}`;
  const panelId = (panel: PanelId) => `${prefix}-panel-${panel}`;
  const { Content, title: activeTitle } = PANELS[active];
  const show = (panel: PanelId) => store.getState().update((current) => showPanel(current, panel));

  // Arrow keys move between tabs and select them (WAI-ARIA tabs, automatic activation).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = panels.indexOf(active);
    const next =
      event.key === "ArrowRight"
        ? panels[(index + 1) % panels.length]
        : event.key === "ArrowLeft"
          ? panels[(index - 1 + panels.length) % panels.length]
          : event.key === "Home"
            ? panels[0]
            : event.key === "End"
              ? panels.at(-1)
              : undefined;
    if (!next) return;
    event.preventDefault();
    show(next);
    requestAnimationFrame(() => document.getElementById(tabId(next))?.focus());
  };

  const moveItems = ZONE_IDS.filter((zone) => zone !== id).map((zone) => ({
    label: t("layout.moveTo", { zone: t(`layout.zone.${zone}`) }),
    onSelect: () => store.getState().update((current) => movePanel(current, active, zone)),
  }));

  return (
    <>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-surface pr-1">
        <div
          role="tablist"
          aria-label={t(`layout.zone.${id}`)}
          onKeyDown={onKeyDown}
          className="flex h-full min-w-0 flex-1 overflow-x-auto"
        >
          {panels.map((panel) => {
            const { Icon, title } = PANELS[panel];
            const selected = panel === active;
            return (
              <button
                key={panel}
                id={tabId(panel)}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={selected ? panelId(panel) : undefined}
                tabIndex={selected ? 0 : -1}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(PANEL_MIME, panel);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => show(panel)}
                className={`inline-flex shrink-0 items-center gap-1.5 border-b-2 px-2 ${
                  selected
                    ? "border-accent text-text"
                    : "border-transparent text-text-muted hover:text-text"
                }`}
              >
                <Icon />
                {t(title)}
              </button>
            );
          })}
        </div>
        <Menu label={t("layout.options", { panel: t(activeTitle) })} items={moveItems}>
          <MoreIcon />
        </Menu>
        {id !== "center" && (
          <button
            type="button"
            aria-label={t("layout.hide", { zone: t(`layout.zone.${id}`) })}
            title={t("layout.hide", { zone: t(`layout.zone.${id}`) })}
            onClick={() => store.getState().update((current) => toggleZone(current, id))}
            className="inline-flex rounded-sm p-1 text-text-muted hover:bg-item-hover hover:text-text"
          >
            <CollapseIcon />
          </button>
        )}
      </div>
      <div
        role="tabpanel"
        id={panelId(active)}
        aria-labelledby={tabId(active)}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto"
      >
        <Content />
      </div>
    </>
  );
}
