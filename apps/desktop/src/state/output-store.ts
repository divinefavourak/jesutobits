import { runtimeErrorEvent, runtimeWarningEvent } from "@jesutobits/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { HostBridge } from "../host-bridge";

export interface OutputEntry {
  seq: number;
  ts: string;
  level: "warning" | "error";
  message: string;
  code?: string;
}

export interface OutputState {
  /** Oldest first, at most {@link MAX_OUTPUT_ENTRIES}. */
  entries: OutputEntry[];
  clear(): void;
}

export const MAX_OUTPUT_ENTRIES = 500;

/**
 * The Output panel's messages (UX_AND_INTERFACE.md section 5.6): the runtime's warnings and
 * background errors, collected from startup so none is missed while the panel is hidden.
 */
export function createOutputStore(bridge: HostBridge): StoreApi<OutputState> {
  const store = createStore<OutputState>()((set) => ({
    entries: [],
    clear: () => set({ entries: [] }),
  }));

  const add = (entry: OutputEntry) =>
    store.setState((state) => ({
      entries: [...state.entries, entry].slice(-MAX_OUTPUT_ENTRIES),
    }));

  bridge.onRuntimeEvent((event) => {
    if (event.type === runtimeWarningEvent.type) {
      const parsed = runtimeWarningEvent.payload.safeParse(event);
      if (parsed.success) {
        add({
          seq: event.seq,
          ts: event.ts,
          level: "warning",
          message: parsed.data.message,
          ...(parsed.data.code !== undefined && { code: parsed.data.code }),
        });
      }
    } else if (event.type === runtimeErrorEvent.type) {
      const parsed = runtimeErrorEvent.payload.safeParse(event);
      if (parsed.success) {
        const { error } = parsed.data;
        add({
          seq: event.seq,
          ts: event.ts,
          level: "error",
          message: error.message,
          code: error.code,
        });
      }
    }
  });

  return store;
}
