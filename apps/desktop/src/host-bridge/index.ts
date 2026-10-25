import { isTauri } from "@tauri-apps/api/core";
import { MockHostBridge, type MockStorage } from "./mock-host-bridge";
import { RelayHostBridge } from "./relay-host-bridge";
import { TauriHostBridge } from "./tauri-host-bridge";
import type { HostBridge } from "./types";

export type { HostBridge, Unsubscribe } from "./types";
export { MockHostBridge } from "./mock-host-bridge";

/**
 * Set by browser E2E tests before the page loads (`apps/desktop/e2e/fixtures.ts`): the
 * relay to use (`<url>#<token>`, one runtime per test), and afterwards the mock itself, so a
 * test can choose what the folder dialog returns. Read only in development builds.
 */
declare global {
  var __JESUTOBITS_E2E_RELAY__: string | undefined;
  var __JESUTOBITS_MOCK_HOST__: MockHostBridge | undefined;
}

/**
 * The Tauri bridge inside the desktop app. In a plain browser (`pnpm dev:web`): the mock, or
 * with `--runtime` the mock relaying runtime calls to a real runtime. Browser settings and UI
 * state live in `localStorage`, so they survive a reload.
 */
export async function createHostBridge(): Promise<HostBridge> {
  if (isTauri()) return TauriHostBridge.connect();
  const storage = browserStorage();
  const relay =
    (import.meta.env.DEV ? globalThis.__JESUTOBITS_E2E_RELAY__ : undefined) ??
    import.meta.env.VITE_JESUTOBITS_RELAY;
  const bridge = relay
    ? RelayHostBridge.fromSetting(relay, { storage })
    : new MockHostBridge({ storage });
  if (import.meta.env.DEV) globalThis.__JESUTOBITS_MOCK_HOST__ = bridge;
  return bridge;
}

function browserStorage(): MockStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    // Storage can be blocked; the mock then keeps state in memory.
    return undefined;
  }
}
