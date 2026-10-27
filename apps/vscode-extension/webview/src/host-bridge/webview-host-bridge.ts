import {
  ErrorCodes,
  getMethod,
  HostToWebviewSchema,
  JesutobitsError,
  WEBVIEW_HOST_OPS,
  type AppSettings,
  type LogLevel,
  type MethodParams,
  type MethodResult,
  type Project,
  type RuntimeEventBase,
  type RuntimeStatusUpdate,
  type SecretRef,
  type UiState,
  type WebviewHostOp,
  type WebviewHostParams,
  type WebviewHostResult,
  type WebviewToHost,
  type WorkbenchMethod,
} from "@jesutobits/protocol";
import { Listeners } from "./listeners";
import type { HostBridge, Unsubscribe } from "./types";

/** What `acquireVsCodeApi()` returns; the only channel out of the webview. */
export interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: JesutobitsError): void;
  /** Validates the result on receipt (NFR-024). */
  parse(result: unknown): unknown;
}

/**
 * The agent panel's bridge to the extension (ADR-0015). Messages in both directions follow
 * `packages/protocol/src/webview.ts`; anything else arriving on the window is ignored.
 */
export class WebviewHostBridge implements HostBridge {
  readonly #vscode: VsCodeApi;
  readonly #pending = new Map<number, Pending>();
  readonly #events = new Listeners<RuntimeEventBase>(false);
  readonly #status = new Listeners<RuntimeStatusUpdate>(true);
  readonly #projects = new Listeners<Project | null>(true);
  readonly #settings = new Listeners<AppSettings>(false);
  #nextId = 1;

  constructor(vscode: VsCodeApi, target: Pick<Window, "addEventListener"> = window) {
    this.#vscode = vscode;
    target.addEventListener("message", (event) => this.#receive(event.data));
    vscode.postMessage({ kind: "ready" });
  }

  rpc<M extends WorkbenchMethod>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    const definition = getMethod(method);
    return this.#send(
      (id) => ({ kind: "call", id, method, params }),
      (result) => (definition ? definition.result.parse(result) : result),
    ) as Promise<MethodResult<M>>;
  }

  #host<Op extends WebviewHostOp>(
    op: Op,
    params: WebviewHostParams<Op>,
  ): Promise<WebviewHostResult<Op>> {
    return this.#send(
      (id) => ({ kind: "host", id, op, params }),
      (result) => WEBVIEW_HOST_OPS[op].result.parse(result),
    ) as Promise<WebviewHostResult<Op>>;
  }

  #send(message: (id: number) => WebviewToHost, parse: (result: unknown) => unknown) {
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, parse });
      this.#vscode.postMessage(message(id));
    });
  }

  #receive(data: unknown): void {
    const parsed = HostToWebviewSchema.safeParse(data);
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.kind) {
      case "result":
      case "error": {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.kind === "error") {
          pending.reject(JesutobitsError.fromData(message.error));
          return;
        }
        try {
          pending.resolve(pending.parse(message.result));
        } catch {
          pending.reject(
            new JesutobitsError(ErrorCodes.rpcInternal, "The extension sent an invalid result"),
          );
        }
        return;
      }
      case "event":
        this.#events.emit(message.event);
        return;
      case "status":
        this.#status.emit(message.update);
        return;
      case "project":
        this.#projects.emit(message.project);
        return;
      case "settings":
        this.#settings.emit(message.settings);
    }
  }

  onRuntimeEvent(handler: (event: RuntimeEventBase) => void): Unsubscribe {
    return this.#events.add(handler);
  }

  onRuntimeStatus(handler: (update: RuntimeStatusUpdate) => void): Unsubscribe {
    return this.#status.add(handler);
  }

  onProject(handler: (project: Project | null) => void): Unsubscribe {
    return this.#projects.add(handler);
  }

  async restartRuntime(): Promise<void> {
    await this.#host("runtime.restart", {});
  }

  log(level: LogLevel, message: string): void {
    void this.#host("log", { level, message: message.slice(0, 4000) }).catch(() => undefined);
  }

  async openSettings(section?: string): Promise<void> {
    await this.#host("ui.openSettings", section === undefined ? {} : { section });
  }

  async openFile(path: string): Promise<void> {
    await this.#host("ui.openFile", { path });
  }

  readonly settings = {
    get: (): Promise<AppSettings> => this.#host("settings.get", {}),
    update: (patch: WebviewHostParams<"settings.update">): Promise<AppSettings> =>
      this.#host("settings.update", patch),
    onChange: (handler: (settings: AppSettings) => void): Unsubscribe =>
      this.#settings.add(handler),
  };

  readonly uiState = {
    get: (): Promise<UiState> => this.#host("uiState.get", {}),
    update: (patch: Record<string, unknown>): Promise<UiState> =>
      this.#host("uiState.update", patch),
  };

  readonly secrets = {
    prompt: async (ref: SecretRef): Promise<boolean> =>
      (await this.#host("secrets.prompt", { ref })).stored,
    delete: async (ref: SecretRef): Promise<void> => {
      await this.#host("secrets.delete", { ref });
    },
    exists: async (ref: SecretRef): Promise<boolean> =>
      (await this.#host("secrets.exists", { ref })).exists,
  };
}
