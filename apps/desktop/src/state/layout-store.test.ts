import { describe, expect, it, vi } from "vitest";
import { presetLayout, toggleZone } from "../features/layout/layout-model";
import { MockHostBridge } from "../host-bridge";
import { createLayoutStore, LAYOUTS_KEY, SAVE_DELAY_MS } from "./layout-store";
import { createProjectStore } from "./project-store";

const project = (id: string) => ({
  id,
  path: `c:\\work\\${id}`,
  name: id,
  kind: "project" as const,
  trust: "trusted" as const,
  createdByJesutobits: false,
  lastOpenedAt: null,
  missing: false,
});
const A = "prj_01JAAAAAAAAAAAAAAAAAAAAAAA";
const B = "prj_01JBBBBBBBBBBBBBBBBBBBBBBB";

function setup() {
  const bridge = new MockHostBridge();
  bridge.handle("projects.open", (params) => ({
    project: project("id" in params ? params.id : A),
    needsTrustDecision: false,
  }));
  bridge.handle("projects.detect", () => {
    throw new Error("not needed");
  });
  const projects = createProjectStore(bridge);
  const layout = createLayoutStore(bridge, projects);
  return { bridge, projects, layout };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("layout store", () => {
  it("opens a project with the Code preset when it has no stored layout", async () => {
    const { projects, layout } = setup();
    expect(layout.getState().layout).toBeNull();
    await projects.getState().openRecent(A);
    await settle();
    expect(layout.getState().layout).toEqual(presetLayout("code"));
  });

  it("saves changes per project once they settle, and restores them (FR-008)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { bridge, projects, layout } = setup();
      await projects.getState().openRecent(A);
      await vi.advanceTimersByTimeAsync(0);
      layout.getState().update((current) => toggleZone(current, "left"));
      layout.getState().update((current) => toggleZone(current, "bottom"));
      expect((await bridge.uiState.get())[LAYOUTS_KEY]).toBeUndefined();

      await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
      const saved = (await bridge.uiState.get())[LAYOUTS_KEY] as Record<string, unknown>;
      expect(saved[A]).toMatchObject({ preset: "code", modified: true });

      // Another project keeps its own layout; coming back restores A's.
      await projects.getState().openRecent(B);
      await vi.advanceTimersByTimeAsync(0);
      expect(layout.getState().layout).toEqual(presetLayout("code"));
      await projects.getState().openRecent(A);
      await vi.advanceTimersByTimeAsync(0);
      expect(layout.getState().layout?.zones.left.collapsed).toBe(true);
      expect(layout.getState().layout?.zones.bottom.collapsed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes a pending change at once when the project closes", async () => {
    const { bridge, projects, layout } = setup();
    bridge.handle("projects.close", () => ({}));
    bridge.handle("projects.list", () => ({ projects: [] }));
    await projects.getState().openRecent(A);
    await settle();
    layout.getState().usePreset("focus");
    await projects.getState().close();
    await settle();

    const saved = (await bridge.uiState.get())[LAYOUTS_KEY] as Record<string, unknown>;
    expect(saved[A]).toMatchObject({ preset: "focus", modified: false });
    expect(layout.getState().layout).toBeNull();
  });

  it("falls back to the preset when the stored layout is invalid", async () => {
    const { bridge, projects, layout } = setup();
    await bridge.uiState.update({ [LAYOUTS_KEY]: { [A]: { preset: "code", zones: {} } } });
    await projects.getState().openRecent(A);
    await settle();
    expect(layout.getState().layout).toEqual(presetLayout("code"));
  });

  it("resets a changed layout to its preset", async () => {
    const { projects, layout } = setup();
    await projects.getState().openRecent(A);
    await settle();
    layout.getState().usePreset("design");
    layout.getState().update((current) => toggleZone(current, "right"));
    expect(layout.getState().layout?.modified).toBe(true);
    layout.getState().reset();
    expect(layout.getState().layout).toEqual(presetLayout("design"));
  });
});
