import { isTauri } from "@tauri-apps/api/core";
import { MockHostBridge } from "./mock-host-bridge";
import { TauriHostBridge } from "./tauri-host-bridge";
import type { HostBridge } from "./types";

export type { HostBridge, Unsubscribe } from "./types";
export { MockHostBridge } from "./mock-host-bridge";

/** The Tauri bridge inside the desktop app; the mock in a plain browser (`pnpm dev:web`). */
export async function createHostBridge(): Promise<HostBridge> {
  return isTauri() ? TauriHostBridge.connect() : new MockHostBridge();
}
