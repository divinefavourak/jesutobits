import { Channel, invoke } from "@tauri-apps/api/core";
import {
  getMethod,
  RuntimeEventBaseSchema,
  RuntimeStatusUpdateSchema,
  toJesutobitsError,
  type LogLevel,
  type MethodParams,
  type MethodResult,
  type RuntimeEventBase,
  type RuntimeStatusUpdate,
  type WorkbenchMethod,
} from "@jesutobits/protocol";
import { Listeners } from "./listeners";
import type { HostBridge, Unsubscribe } from "./types";

/** HostBridge over Tauri IPC: `invoke` for calls, Channels for streams (ADR-0003). */
export class TauriHostBridge implements HostBridge {
  private readonly events = new Listeners<RuntimeEventBase>(false);
  private readonly status = new Listeners<RuntimeStatusUpdate>(true);

  private constructor() {}

  static async connect(): Promise<TauriHostBridge> {
    const bridge = new TauriHostBridge();
    const onEvent = new Channel<unknown>();
    onEvent.onmessage = (message) => bridge.receiveEvent(message);
    const onStatus = new Channel<unknown>();
    onStatus.onmessage = (message) => bridge.receiveStatus(message);
    await invoke("runtime_subscribe", { onEvent, onStatus });
    return bridge;
  }

  async rpc<M extends WorkbenchMethod>(
    method: M,
    params: MethodParams<M>,
  ): Promise<MethodResult<M>> {
    let raw: unknown;
    try {
      raw = await invoke("rpc_call", { method, params });
    } catch (error) {
      throw toJesutobitsError(error);
    }
    const definition = getMethod(method);
    const result = definition?.result.safeParse(raw);
    if (!result?.success) {
      throw toJesutobitsError({ code: -32603, message: `Invalid result for ${method}` });
    }
    return result.data as MethodResult<M>;
  }

  onRuntimeEvent(handler: (event: RuntimeEventBase) => void): Unsubscribe {
    return this.events.add(handler);
  }

  onRuntimeStatus(handler: (update: RuntimeStatusUpdate) => void): Unsubscribe {
    return this.status.add(handler);
  }

  log(level: LogLevel, message: string): void {
    // Logging must never throw into the caller.
    void invoke("workbench_log", { level, message }).catch(() => undefined);
  }

  private receiveEvent(message: unknown): void {
    const event = RuntimeEventBaseSchema.safeParse(message);
    if (event.success) this.events.emit(event.data);
    else this.log("warn", "Dropped a runtime event that failed validation");
  }

  private receiveStatus(message: unknown): void {
    const update = RuntimeStatusUpdateSchema.safeParse(message);
    if (update.success) this.status.emit(update.data);
    else this.log("warn", "Dropped a runtime status update that failed validation");
  }
}
