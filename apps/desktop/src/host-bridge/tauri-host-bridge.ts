import { Channel, invoke } from "@tauri-apps/api/core";
import {
  AppSettingsSchema,
  getMethod,
  HostNoticeSchema,
  RuntimeEventBaseSchema,
  RuntimeStatusUpdateSchema,
  toJesutobitsError,
  UiStateSchema,
  type AppSettings,
  type HostNotice,
  type LogLevel,
  type MethodParams,
  type MethodResult,
  type RuntimeEventBase,
  type RuntimeStatusUpdate,
  type SettingsPatch,
  type UiState,
  type WorkbenchMethod,
} from "@jesutobits/protocol";
import { Listeners } from "./listeners";
import type { HostBridge, Unsubscribe } from "./types";

/** What the bridge needs from a protocol schema (the Workbench does not depend on Zod). */
interface Parser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/** HostBridge over Tauri IPC: `invoke` for calls, Channels for streams (ADR-0003). */
export class TauriHostBridge implements HostBridge {
  private readonly events = new Listeners<RuntimeEventBase>(false);
  private readonly status = new Listeners<RuntimeStatusUpdate>(true);
  private readonly settingsChanges = new Listeners<AppSettings>(false);
  private readyReported = false;

  private constructor() {}

  static async connect(): Promise<TauriHostBridge> {
    const bridge = new TauriHostBridge();
    const onEvent = new Channel<unknown>();
    onEvent.onmessage = (message) => bridge.receiveEvent(message);
    const onStatus = new Channel<unknown>();
    onStatus.onmessage = (message) => bridge.receiveStatus(message);
    await invoke("runtime_subscribe", { onEvent, onStatus });
    const onChange = new Channel<unknown>();
    onChange.onmessage = (message) => {
      const settings = AppSettingsSchema.safeParse(message);
      if (settings.success) bridge.settingsChanges.emit(settings.data);
      else bridge.log("warn", "Dropped a settings change that failed validation");
    };
    await invoke("settings_subscribe", { onChange });
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

  readonly settings = {
    get: (): Promise<AppSettings> => this.command("settings_get", {}, AppSettingsSchema),
    update: (patch: SettingsPatch): Promise<AppSettings> =>
      this.command("settings_update", { patch }, AppSettingsSchema),
    onChange: (handler: (settings: AppSettings) => void): Unsubscribe =>
      this.settingsChanges.add(handler),
  };

  readonly uiState = {
    get: (): Promise<UiState> => this.command("ui_state_get", {}, UiStateSchema),
    update: (patch: Record<string, unknown>): Promise<UiState> =>
      this.command("ui_state_update", { patch }, UiStateSchema),
  };

  readonly dialogs = {
    pickFolder: (options: { title?: string; defaultPath?: string } = {}): Promise<string | null> =>
      this.command(
        "dialog_pick_folder",
        { title: options.title ?? null, defaultPath: options.defaultPath ?? null },
        nullableString,
      ),
  };

  notices(): Promise<HostNotice[]> {
    return this.command("host_notices", {}, HostNoticeSchema.array());
  }

  /** Invokes a Host command and checks its result (NFR-024). */
  private async command<T>(
    name: string,
    args: Record<string, unknown>,
    schema: Parser<T>,
  ): Promise<T> {
    let raw: unknown;
    try {
      raw = await invoke(name, args);
    } catch (error) {
      throw toJesutobitsError(error);
    }
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw toJesutobitsError({ code: -32603, message: `Invalid result from ${name}` });
    }
    return result.data;
  }

  async restartRuntime(): Promise<void> {
    try {
      await invoke("runtime_restart");
    } catch (error) {
      throw toJesutobitsError(error);
    }
  }

  reportReady(): void {
    // Once per page load; React StrictMode runs effects twice in development.
    if (this.readyReported) return;
    this.readyReported = true;
    // performance.now() counts from the webview's navigation start.
    void invoke("workbench_ready", { sinceNavigationMs: performance.now() }).catch(() => undefined);
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

const nullableString: Parser<string | null> = {
  safeParse: (value) =>
    value === null || typeof value === "string"
      ? { success: true, data: value }
      : { success: false },
};
