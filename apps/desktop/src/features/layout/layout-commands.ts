import type { Command } from "../../state/commands";
import type { Workbench } from "../../state/workbench-context";
import {
  PANEL_IDS,
  PRESET_IDS,
  showPanel,
  toggleZone,
  ZONE_IDS,
  zoneOf,
  type Layout,
  type ZoneId,
} from "./layout-model";

/** View commands for the dock layout (UX_AND_INTERFACE.md section 9). Need an open project. */
export function layoutCommands({ layout }: Pick<Workbench, "layout">): Command[] {
  const hasLayout = () => layout.getState().layout !== null;
  const update = (edit: (current: Layout) => Layout) => layout.getState().update(edit);
  const toggle = (zone: ZoneId) => () => update((current) => toggleZone(current, zone));

  return [
    {
      id: "layout.toggleLeft",
      title: "command.layout.toggleLeft",
      keys: "Ctrl+B",
      enabled: hasLayout,
      run: toggle("left"),
    },
    {
      id: "layout.toggleRight",
      title: "command.layout.toggleRight",
      keys: "Ctrl+Alt+B",
      enabled: hasLayout,
      run: toggle("right"),
    },
    {
      id: "layout.toggleBottom",
      title: "command.layout.toggleBottom",
      keys: "Ctrl+J",
      enabled: hasLayout,
      run: toggle("bottom"),
    },
    ...PRESET_IDS.map((preset, index): Command => ({
      id: `layout.preset.${preset}`,
      title: `command.layout.preset.${preset}`,
      keys: `Alt+${index + 1}`,
      enabled: hasLayout,
      run: () => layout.getState().usePreset(preset),
    })),
    {
      id: "layout.reset",
      title: "command.layout.reset",
      enabled: () => layout.getState().layout?.modified ?? false,
      run: () => layout.getState().reset(),
    },
    {
      id: "layout.focusNextDock",
      title: "command.layout.focusNextDock",
      keys: "F6",
      enabled: hasLayout,
      run: () => focusDock(1),
    },
    {
      id: "layout.focusPreviousDock",
      title: "command.layout.focusPreviousDock",
      keys: "Shift+F6",
      enabled: hasLayout,
      run: () => focusDock(-1),
    },
    ...PANEL_IDS.map((panel): Command => ({
      id: `layout.show.${panel}`,
      title: `command.layout.show.${panel}`,
      enabled: hasLayout,
      run: () => {
        update((current) => showPanel(current, panel));
        // After React shows it: focus the panel's tab.
        requestAnimationFrame(() => {
          const current = layout.getState().layout;
          if (current) focusZone(zoneOf(current, panel));
        });
      },
    })),
  ];
}

/** `F6` and `Shift+F6` move focus between docks (UX_AND_INTERFACE.md section 10). */
function focusDock(step: 1 | -1): void {
  const zones = ZONE_IDS.filter((id) => document.querySelector(`[data-zone="${id}"]`));
  const current = (document.activeElement?.closest("[data-zone]") as HTMLElement | null)?.dataset
    .zone;
  const index = zones.indexOf(current as ZoneId);
  const next = zones[(index + step + zones.length) % zones.length];
  if (next) focusZone(next);
}

function focusZone(zone: ZoneId): void {
  const element = document.querySelector(`[data-zone="${zone}"]`);
  const target =
    element?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
    element?.querySelector<HTMLElement>("button");
  target?.focus();
}
