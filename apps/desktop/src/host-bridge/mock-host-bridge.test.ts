import { describe, expect, it } from "vitest";
import type { RuntimeStatus } from "@jesutobits/protocol";
import { MockHostBridge } from "./mock-host-bridge";

describe("MockHostBridge.restartRuntime", () => {
  it("restarts a failed runtime through starting to ready", async () => {
    const bridge = new MockHostBridge();
    const seen: RuntimeStatus[] = [];
    bridge.onRuntimeStatus((update) => seen.push(update.status));
    bridge.setStatus({ status: "failed", detail: "boom" });

    await bridge.restartRuntime();

    expect(seen).toEqual(["ready", "failed", "starting", "ready"]);
  });

  it("ignores a restart unless the runtime failed", async () => {
    const bridge = new MockHostBridge();
    const seen: RuntimeStatus[] = [];
    bridge.onRuntimeStatus((update) => seen.push(update.status));

    await bridge.restartRuntime();

    expect(seen).toEqual(["ready"]);
  });
});

describe("MockHostBridge settings", () => {
  it("merges updates, validates them and tells subscribers", async () => {
    const bridge = new MockHostBridge();
    const seen: number[] = [];
    bridge.settings.onChange((settings) => seen.push(settings.appearance.uiScale));

    const updated = await bridge.settings.update({ appearance: { uiScale: 1.25 } });
    expect(updated.appearance).toMatchObject({ uiScale: 1.25, followOsTheme: true });
    await expect(bridge.settings.update({ appearance: { uiScale: 3 } })).rejects.toMatchObject({
      code: "storage.invalid_settings",
    });
    expect((await bridge.settings.get()).appearance.uiScale).toBe(1.25);
    expect(seen).toEqual([1.25]);
  });

  it("keeps UI state keys and reserves the window for the Host", async () => {
    const bridge = new MockHostBridge();
    await bridge.uiState.update({ onboarding: { step: 2 } });
    expect(await bridge.uiState.get()).toEqual({
      schemaVersion: 1,
      window: null,
      onboarding: { step: 2 },
    });
    await expect(bridge.uiState.update({ window: null })).rejects.toMatchObject({
      code: "storage.invalid_settings",
    });
    await bridge.uiState.update({ onboarding: null });
    expect(await bridge.uiState.get()).toEqual({ schemaVersion: 1, window: null });
  });
});

describe("MockHostBridge storage", () => {
  const memoryStorage = () => {
    const items = new Map<string, string>();
    return {
      items,
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    };
  };

  it("keeps settings and UI state for the next bridge, like the Host's files", async () => {
    const storage = memoryStorage();
    const first = new MockHostBridge({ storage });
    await first.settings.update({ appearance: { uiScale: 1.25 } });
    await first.uiState.update({ onboarding: { step: 3 } });

    const second = new MockHostBridge({ storage });
    expect((await second.settings.get()).appearance.uiScale).toBe(1.25);
    expect((await second.uiState.get()).onboarding).toEqual({ step: 3 });
  });

  it("falls back to defaults when what is stored does not validate", async () => {
    const storage = memoryStorage();
    storage.items.set("jesutobits.mock.settings", '{"appearance":{"uiScale":9}}');
    storage.items.set("jesutobits.mock.ui-state", "not json");

    const bridge = new MockHostBridge({ storage });
    expect((await bridge.settings.get()).appearance.uiScale).toBe(1);
    expect(await bridge.uiState.get()).toEqual({ schemaVersion: 1, window: null });
  });
});
