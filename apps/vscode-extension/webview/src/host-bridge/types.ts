import type {
  AppSettings,
  LogLevel,
  MethodParams,
  MethodResult,
  Project,
  RuntimeEventBase,
  RuntimeStatusUpdate,
  SecretRef,
  UiState,
  WebviewHostParams,
  WorkbenchMethod,
} from "@jesutobits/protocol";

export type Unsubscribe = () => void;

/**
 * The agent panel's only way to reach the extension, over `postMessage` (ADR-0015,
 * `packages/protocol/src/webview.ts`). The webview has no other access to files, processes,
 * settings or secrets (invariant 4).
 *
 * Every call rejects with a `JesutobitsError`. Results, events and status updates are
 * validated against `@jesutobits/protocol` on receipt (NFR-024).
 */
export interface HostBridge {
  rpc<M extends WorkbenchMethod>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
  onRuntimeEvent(handler: (event: RuntimeEventBase) => void): Unsubscribe;
  /** Calls the handler with the current status straight away, then on every change. */
  onRuntimeStatus(handler: (update: RuntimeStatusUpdate) => void): Unsubscribe;
  /**
   * The active project: VS Code's open folder. Called with the current one straight away,
   * then whenever it is opened again (another folder, or after a runtime restart).
   */
  onProject(handler: (project: Project | null) => void): Unsubscribe;
  /** Starts the runtime again after it reached `failed` (ADR-0002). Ignored in other states. */
  restartRuntime(): Promise<void>;
  /** Writes to the Jesutobits output channel. */
  log(level: LogLevel, message: string): void;
  /** Opens VS Code's Settings editor on Jesutobits' settings. */
  openSettings(section?: string): Promise<void>;
  /** Opens a project file (path relative to the project) in VS Code's editor, at a position. */
  openFile(path: string, position?: { line: number; column: number }): Promise<void>;
  /** Opens a running preview (a loopback URL) in the user's browser. */
  openExternal(url: string): Promise<void>;
  /** Fills the agent panel's message box for the user to finish and send. */
  compose(text: string): Promise<void>;
  /** Text the extension asks the agent panel to put in its message box. */
  onCompose(handler: (text: string) => void): Unsubscribe;

  /** The `jesutobits.*` VS Code settings, in the `settings.json` shape the panel knows. */
  settings: {
    get(): Promise<AppSettings>;
    update(patch: WebviewHostParams<"settings.update">): Promise<AppSettings>;
    onChange(handler: (settings: AppSettings) => void): Unsubscribe;
  };
  /** The panel's own remembered state (active session per project), kept by the extension. */
  uiState: {
    get(): Promise<UiState>;
    /** Replaces the given top-level keys; `null` removes one. */
    update(patch: Record<string, unknown>): Promise<UiState>;
  };
  /**
   * VS Code `SecretStorage`. There is no way to read or even send a secret from here: the
   * extension asks for the key in its own password box (invariant 3).
   */
  secrets: {
    /** False when the user cancelled. */
    prompt(ref: SecretRef): Promise<boolean>;
    delete(ref: SecretRef): Promise<void>;
    exists(ref: SecretRef): Promise<boolean>;
    /** A secret was set or removed anywhere (a command, another window): check again. */
    onChange(handler: () => void): Unsubscribe;
  };
}
