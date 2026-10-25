import { describe, expect, it } from "vitest";
import {
  LayoutSchema,
  MIN_SIZE,
  movePanel,
  PANEL_IDS,
  parseLayout,
  PRESET_IDS,
  presetLayout,
  resizeZone,
  showPanel,
  toggleZone,
  zoneOf,
} from "./layout-model";

const window = { width: 1600, height: 900 };

describe("layout presets (UX_AND_INTERFACE.md section 4.3)", () => {
  it.each(PRESET_IDS)("%s places every panel exactly once and validates", (preset) => {
    const layout = presetLayout(preset);
    expect(LayoutSchema.safeParse(layout).success).toBe(true);
    const placed = Object.values(layout.zones).flatMap((zone) => zone.panels);
    expect(placed.toSorted()).toEqual([...PANEL_IDS].toSorted());
    expect(layout.modified).toBe(false);
    expect(layout.zones.center.collapsed).toBe(false);
  });

  it("Code has the explorer left, the editor center, the agent right and the terminal below", () => {
    const { zones } = presetLayout("code");
    expect([
      zones.left.active,
      zones.center.active,
      zones.right.active,
      zones.bottom.active,
    ]).toEqual(["explorer", "editor", "agent", "terminal"]);
    expect(zones.bottom.collapsed).toBe(false);
  });

  it("Focus shows only the center", () => {
    const { zones } = presetLayout("focus");
    expect([zones.left.collapsed, zones.right.collapsed, zones.bottom.collapsed]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("returns a copy, so editing a layout never changes the preset", () => {
    const first = presetLayout("code");
    first.zones.left.size = 999;
    expect(presetLayout("code").zones.left.size).toBe(260);
  });
});

describe("layout edits", () => {
  it("moves a panel to another zone, shows it there and marks the layout modified", () => {
    const layout = movePanel(presetLayout("code"), "explorer", "right");
    expect(zoneOf(layout, "explorer")).toBe("right");
    expect(layout.zones.right.active).toBe("explorer");
    expect(layout.zones.left).toMatchObject({ panels: [], active: null });
    expect(layout.modified).toBe(true);
  });

  it("expands a collapsed zone when a panel moves into it", () => {
    const layout = movePanel(presetLayout("focus"), "editor", "bottom");
    expect(layout.zones.bottom).toMatchObject({ collapsed: false, active: "editor" });
    expect(layout.zones.center.active).toBe("preview");
  });

  it("showing a panel activates its tab and expands its zone", () => {
    const layout = showPanel(presetLayout("focus"), "problems");
    expect(layout.zones.bottom).toMatchObject({ active: "problems", collapsed: false });
  });

  it("collapses side zones but never the center", () => {
    const code = presetLayout("code");
    expect(toggleZone(code, "left").zones.left.collapsed).toBe(true);
    expect(toggleZone(toggleZone(code, "left"), "left").zones.left.collapsed).toBe(false);
    expect(toggleZone(code, "center")).toBe(code);
  });

  it("keeps sizes between the minimum and what leaves the center 360 px", () => {
    const code = presetLayout("code");
    expect(resizeZone(code, "left", 50, window).zones.left.size).toBe(MIN_SIZE.left);
    // 1600 - 360 (center) - 360 (right) = 880.
    expect(resizeZone(code, "left", 5000, window).zones.left.size).toBe(880);
    expect(resizeZone(code, "bottom", 10, window).zones.bottom.size).toBe(MIN_SIZE.bottom);
    expect(resizeZone(code, "left", 260, window)).toBe(code);
  });

  it("gives a zone the collapsed neighbour's space", () => {
    const layout = toggleZone(presetLayout("code"), "right");
    // 1600 - 360 (center) - 32 (rail) = 1208.
    expect(resizeZone(layout, "left", 5000, window).zones.left.size).toBe(1208);
  });
});

describe("parseLayout", () => {
  it("keeps a valid stored layout", () => {
    const stored = movePanel(presetLayout("code"), "terminal", "right");
    expect(parseLayout(JSON.parse(JSON.stringify(stored)), "code")).toEqual(stored);
  });

  it("falls back to the preset for anything invalid", () => {
    expect(parseLayout(undefined, "code")).toEqual(presetLayout("code"));
    expect(parseLayout({ preset: "code" }, "focus")).toEqual(presetLayout("focus"));
    const lost = presetLayout("code");
    lost.zones.left.panels = [];
    expect(parseLayout(lost, "code")).toEqual(presetLayout("code"));
  });
});
