import { isTauri } from "@tauri-apps/api/core";
import { MockHostBridge } from "./mock-host-bridge";
import { RelayHostBridge } from "./relay-host-bridge";
import { TauriHostBridge } from "./tauri-host-bridge";
import type { HostBridge } from "./types";

export type { HostBridge, Unsubscribe } from "./types";
export { MockHostBridge } from "./mock-host-bridge";

/**
 * The Tauri bridge inside the desktop app. In a plain browser (`pnpm dev:web`): the mock, or
 * with `--runtime` the mock relaying runtime calls to a real runtime.
 */
export async function createHostBridge(): Promise<HostBridge> {
  if (isTauri()) return TauriHostBridge.connect();
  const relay = import.meta.env.VITE_JESUTOBITS_RELAY;
  return relay ? RelayHostBridge.fromSetting(relay) : new MockHostBridge();
}
