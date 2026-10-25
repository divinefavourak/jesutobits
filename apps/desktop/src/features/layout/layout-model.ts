import { z } from "zod";

/**
 * The dock layout as data (UX_AND_INTERFACE.md section 4.2): four zones, each holding panels
 * as tabs. Pure functions, so the rules are unit-tested without a DOM. Every panel is in
 * exactly one zone; the center zone always exists and never collapses.
 */

export const PANEL_IDS = [
  "explorer",
  "editor",
  "preview",
  "agent",
  "inspector",
  "terminal",
  "problems",
  "output",
] as const;
export type PanelId = (typeof PANEL_IDS)[number];

export const ZONE_IDS = ["left", "center", "right", "bottom"] as const;
export type ZoneId = (typeof ZONE_IDS)[number];

export const PRESET_IDS = ["build", "code", "design", "focus"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

/** Smallest sizes in px (section 4.2). Center has no stored size: it takes what is left. */
export const MIN_SIZE: Record<ZoneId, number> = { left: 180, center: 360, right: 300, bottom: 120 };
/** Width of a collapsed zone's icon rail. */
export const RAIL_SIZE = 32;

const PanelIdSchema = z.enum(PANEL_IDS);
const ZoneSchema = z.object({
  panels: z.array(PanelIdSchema),
  active: PanelIdSchema.nullable(),
  collapsed: z.boolean(),
  /** Width (left, right) or height (bottom) in px when expanded. */
  size: z.number().int().nonnegative(),
});
export type Zone = z.infer<typeof ZoneSchema>;

export const LayoutSchema = z
  .object({
    /** The preset this layout started from. */
    preset: z.enum(PRESET_IDS),
    /** The user changed it since: shown as "Custom (based on …)". */
    modified: z.boolean(),
    zones: z.object({
      left: ZoneSchema,
      center: ZoneSchema,
      right: ZoneSchema,
      bottom: ZoneSchema,
    }),
  })
  .refine(isComplete, "Every panel must be in exactly one zone");
export type Layout = z.infer<typeof LayoutSchema>;

function zone(panels: PanelId[], size: number, collapsed = false, active = panels[0]): Zone {
  return { panels, active: active ?? null, collapsed, size };
}

/** Section 4.3. Panels a preset does not show sit collapsed or as background tabs. */
const PRESETS: Record<PresetId, Layout["zones"]> = {
  // Agent (left, wide) · Preview (center) · Explorer collapsed · Bottom collapsed until errors.
  build: {
    left: zone(["agent", "explorer"], 420),
    center: zone(["preview", "editor"], 0),
    right: zone(["inspector"], 320, true),
    bottom: zone(["terminal", "problems", "output"], 200, true),
  },
  // Explorer (left) · Editor (center) · Agent (right) · Terminal (bottom).
  code: {
    left: zone(["explorer"], 260),
    center: zone(["editor", "preview"], 0),
    right: zone(["agent", "inspector"], 360),
    bottom: zone(["terminal", "problems", "output"], 200),
  },
  // Agent (left, narrow) · Preview (center, large) · Inspector (right).
  design: {
    left: zone(["agent", "explorer"], 300),
    center: zone(["preview", "editor"], 0),
    right: zone(["inspector"], 320),
    bottom: zone(["terminal", "problems", "output"], 200, true),
  },
  // Center only; the agent slides over with Ctrl+L once it exists.
  focus: {
    left: zone(["explorer"], 260, true),
    center: zone(["editor", "preview"], 0),
    right: zone(["agent", "inspector"], 360, true),
    bottom: zone(["terminal", "problems", "output"], 200, true),
  },
};

export function presetLayout(preset: PresetId): Layout {
  return { preset, modified: false, zones: structuredClone(PRESETS[preset]) };
}

/** Which zone holds a panel. */
export function zoneOf(layout: Layout, panel: PanelId): ZoneId {
  const found = ZONE_IDS.find((id) => layout.zones[id].panels.includes(panel));
  if (!found) throw new Error(`Panel ${panel} is in no zone`);
  return found;
}

/** Moves a panel to the end of another zone's tabs, makes it active and shows the zone. */
export function movePanel(layout: Layout, panel: PanelId, to: ZoneId): Layout {
  const from = zoneOf(layout, panel);
  if (from === to) return showPanel(layout, panel);
  const next = edit(layout);
  const source = next.zones[from];
  source.panels = source.panels.filter((id) => id !== panel);
  if (source.active === panel) source.active = source.panels[0] ?? null;
  const target = next.zones[to];
  target.panels.push(panel);
  target.active = panel;
  target.collapsed = false;
  return next;
}

/** Makes a panel the active tab of its zone and expands the zone. */
export function showPanel(layout: Layout, panel: PanelId): Layout {
  const id = zoneOf(layout, panel);
  const current = layout.zones[id];
  if (current.active === panel && !current.collapsed) return layout;
  const next = edit(layout);
  next.zones[id].active = panel;
  next.zones[id].collapsed = false;
  return next;
}

/** Collapses or expands a side zone (`Ctrl+B`, `Ctrl+Alt+B`, `Ctrl+J`). Center never collapses. */
export function toggleZone(layout: Layout, id: ZoneId): Layout {
  if (id === "center") return layout;
  const next = edit(layout);
  next.zones[id].collapsed = !next.zones[id].collapsed;
  return next;
}

/** Sets a side zone's size, kept between its minimum and what leaves the center its own. */
export function resizeZone(
  layout: Layout,
  id: ZoneId,
  size: number,
  window: { width: number; height: number },
): Layout {
  if (id === "center") return layout;
  const clamped = clampSize(layout, id, size, window);
  if (clamped === layout.zones[id].size) return layout;
  const next = edit(layout);
  next.zones[id].size = clamped;
  return next;
}

/** The largest size a zone may take in this window, never under its minimum. */
export function maxSize(
  layout: Layout,
  id: Exclude<ZoneId, "center">,
  window: { width: number; height: number },
): number {
  if (id === "bottom") return Math.max(MIN_SIZE.bottom, window.height - 200);
  const other = id === "left" ? "right" : "left";
  const otherZone = layout.zones[other];
  const otherWidth = otherZone.collapsed ? RAIL_SIZE : otherZone.size;
  return Math.max(MIN_SIZE[id], window.width - MIN_SIZE.center - otherWidth);
}

function clampSize(
  layout: Layout,
  id: Exclude<ZoneId, "center">,
  size: number,
  window: { width: number; height: number },
): number {
  return Math.round(Math.min(Math.max(size, MIN_SIZE[id]), maxSize(layout, id, window)));
}

/** A stored layout, or the preset when it is missing or invalid (ui-state is the Workbench's). */
export function parseLayout(stored: unknown, fallback: PresetId): Layout {
  const parsed = LayoutSchema.safeParse(stored);
  return parsed.success ? parsed.data : presetLayout(fallback);
}

function isComplete(layout: { zones: Record<ZoneId, { panels: PanelId[] }> }): boolean {
  const all = ZONE_IDS.flatMap((id) => layout.zones[id].panels);
  return all.length === PANEL_IDS.length && PANEL_IDS.every((panel) => all.includes(panel));
}

/** A copy marked as changed by the user. */
function edit(layout: Layout): Layout {
  return { ...structuredClone(layout), modified: true };
}
