import type {
  AppSettings,
  HostNotice,
  LogLevel,
  MethodParams,
  MethodResult,
  RuntimeEventBase,
  RuntimeStatusUpdate,
  SettingsPatch,
  UiState,
  WorkbenchMethod,
} from "@jesutobits/protocol";

export type Unsubscribe = () => void;

/**
 * The Workbench's only way to reach the Host (ARCHITECTURE.md section 6.2). Only this folder
 * may import `@tauri-apps/*`. Grows member by member as features land.
 *
 * Every call rejects with a `JesutobitsError`. Results, events and status updates are
 * validated against `@jesutobits/protocol` on receipt (NFR-024).
 */
export interface HostBridge {
  rpc<M extends WorkbenchMethod>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
  onRuntimeEvent(handler: (event: RuntimeEventBase) => void): Unsubscribe;
  /** Calls the handler with the current status straight away, then on every change. */
  onRuntimeStatus(handler: (update: RuntimeStatusUpdate) => void): Unsubscribe;
  /** Starts the runtime again after it reached `failed` (ADR-0002). Ignored in other states. */
  restartRuntime(): Promise<void>;
  /** Tells the Host the first screen has rendered, for startup timing (NFR-001). */
  reportReady(): void;
  /** Writes to the Workbench log through the Host (ARCHITECTURE.md section 10). */
  log(level: LogLevel, message: string): void;

  /** `settings.json`, written only by the Host (DATA_AND_PERSISTENCE.md section 5). */
  settings: {
    get(): Promise<AppSettings>;
    /** Merges a partial update; rejects with `storage.invalid_settings` and saves nothing. */
    update(patch: SettingsPatch): Promise<AppSettings>;
    /** Every later change, from this window or another source. */
    onChange(handler: (settings: AppSettings) => void): Unsubscribe;
  };
  /** `ui-state.json`. The Host owns `window`; other keys are the Workbench's to validate. */
  uiState: {
    get(): Promise<UiState>;
    /** Replaces the given top-level keys; `null` removes one. */
    update(patch: Record<string, unknown>): Promise<UiState>;
  };
  /** Startup notices about the settings files, shown once. */
  notices(): Promise<HostNotice[]>;
  dialogs: {
    /** The OS folder picker; null when the user cancels. One at a time. */
    pickFolder(options?: { title?: string; defaultPath?: string }): Promise<string | null>;
  };
}
