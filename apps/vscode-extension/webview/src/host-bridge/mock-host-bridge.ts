import {
  AppSettingsSchema,
  ErrorCodes,
  JesutobitsError,
  UiStateSchema,
  type AppSettings,
  type LogLevel,
  type MethodParams,
  type MethodResult,
  type Project,
  type RuntimeEventBase,
  type RuntimeStatusUpdate,
  type Remix,
  type SecretRef,
  type StudioTheme,
  type UiState,
  type WebviewHostParams,
  type WorkbenchMethod,
} from "@jesutobits/protocol";
import { Listeners } from "./listeners";
import type { HostBridge, Unsubscribe } from "./types";

type Handler<M extends WorkbenchMethod> = (
  params: MethodParams<M>,
) => MethodResult<M> | Promise<MethodResult<M>>;
type Handlers = Partial<{ [M in WorkbenchMethod]: Handler<M> }>;

/**
 * An in-memory extension for component tests: runtime methods answer from handlers a test
 * registers, settings and UI state live in memory, and the key prompt returns what the test
 * set in `nextPromptedKey`.
 */
export class MockHostBridge implements HostBridge {
  readonly logs: Array<{ level: LogLevel; message: string }> = [];
  readonly openedSettings: Array<string | undefined> = [];
  /** What the next `secrets.prompt` "types"; null cancels. */
  nextPromptedKey: string | null = null;
  private currentSettings: AppSettings = AppSettingsSchema.parse({});
  private currentUiState: UiState = UiStateSchema.parse({});
  private readonly settingsChanges = new Listeners<AppSettings>(false);
  private readonly events = new Listeners<RuntimeEventBase>(false);
  private readonly status = new Listeners<RuntimeStatusUpdate>(true);
  private readonly projects = new Listeners<Project | null>(true);
  private currentStatus: RuntimeStatusUpdate = { status: "ready" };
  private readonly started = performance.now();
  private readonly emitted: RuntimeEventBase[] = [];
  private readonly handlers: Handlers = {
    "runtime.ping": (params) => ({
      uptimeMs: performance.now() - this.started,
      ...(params.echo !== undefined && { echo: params.echo }),
    }),
    "events.replay": (params) => ({
      events: this.emitted.filter((event) => event.seq > params.afterSeq),
      complete: true,
      lastSeq: this.emitted.at(-1)?.seq ?? -1,
    }),
  };

  constructor() {
    this.status.emit(this.currentStatus);
    this.projects.emit(null);
  }

  async rpc<M extends WorkbenchMethod>(
    method: M,
    params: MethodParams<M>,
  ): Promise<MethodResult<M>> {
    const handler = this.handlers[method] as Handler<M> | undefined;
    if (!handler) {
      throw new JesutobitsError(ErrorCodes.rpcMethodNotFound, `MockHostBridge has no ${method}`);
    }
    return handler(params);
  }

  onRuntimeEvent(handler: (event: RuntimeEventBase) => void): Unsubscribe {
    return this.events.add(handler);
  }

  onRuntimeStatus(handler: (update: RuntimeStatusUpdate) => void): Unsubscribe {
    return this.status.add(handler);
  }

  onProject(handler: (project: Project | null) => void): Unsubscribe {
    return this.projects.add(handler);
  }

  async restartRuntime(): Promise<void> {
    if (this.currentStatus.status !== "failed") return;
    this.setStatus({ status: "starting" });
    await Promise.resolve();
    this.setStatus({ status: "ready" });
  }

  log(level: LogLevel, message: string): void {
    this.logs.push({ level, message });
  }

  async openSettings(section?: string): Promise<void> {
    this.openedSettings.push(section);
  }

  readonly openedFiles: string[] = [];

  async openFile(path: string): Promise<void> {
    this.openedFiles.push(path);
  }

  readonly openedUrls: string[] = [];

  async openExternal(url: string): Promise<void> {
    this.openedUrls.push(url);
  }

  readonly navigations: Array<WebviewHostParams<"ui.navigate">["to"]> = [];

  async navigate(to: WebviewHostParams<"ui.navigate">["to"]): Promise<void> {
    this.navigations.push(to);
  }

  readonly projectStarts: Array<"open" | "new"> = [];

  async startProject(how: "open" | "new"): Promise<void> {
    this.projectStarts.push(how);
  }

  readonly composed: string[] = [];
  private readonly composeRequests = new Listeners<string>(false);

  async compose(text: string): Promise<void> {
    this.composed.push(text);
  }

  onCompose(handler: (text: string) => void): Unsubscribe {
    return this.composeRequests.add(handler);
  }

  private readonly lookRequests = new Listeners<void>(false);

  onOpenLook(handler: () => void): Unsubscribe {
    return this.lookRequests.add(handler);
  }

  /** The extension asks this panel to open its theme picker. */
  requestOpenLook(): void {
    this.lookRequests.emit();
  }

  /** The extension asks this panel to compose `text`. */
  requestCompose(text: string): void {
    this.composeRequests.emit(text);
  }

  /** The workspace's look, as the extension keeps it: one remix per theme, like VS Code. */
  private theme = "Lavender dusk";
  private readonly remixes = new Map<string, Remix>();

  get currentLook(): { theme: string; remix: Remix | null } {
    return { theme: this.theme, remix: this.remixes.get(this.theme) ?? null };
  }

  readonly look = {
    get: async () => structuredClone(this.currentLook),
    setTheme: async (theme: StudioTheme): Promise<void> => {
      this.theme = theme;
    },
    remix: async (remix: Remix | null): Promise<void> => {
      if (remix) this.remixes.set(this.theme, remix);
      else this.remixes.delete(this.theme);
    },
  };

  readonly settings = {
    get: async (): Promise<AppSettings> => structuredClone(this.currentSettings),
    update: async (patch: WebviewHostParams<"settings.update">): Promise<AppSettings> => {
      const next = structuredClone(this.currentSettings);
      next.providers.openrouter.defaultModel = patch.providers.openrouter.defaultModel;
      this.currentSettings = AppSettingsSchema.parse(next);
      this.settingsChanges.emit(structuredClone(this.currentSettings));
      return structuredClone(this.currentSettings);
    },
    onChange: (handler: (settings: AppSettings) => void): Unsubscribe =>
      this.settingsChanges.add(handler),
  };

  readonly uiState = {
    get: async (): Promise<UiState> => structuredClone(this.currentUiState),
    update: async (patch: Record<string, unknown>): Promise<UiState> => {
      const next: Record<string, unknown> = { ...this.currentUiState };
      for (const [key, value] of Object.entries(patch)) {
        if (key === "window" || key === "schemaVersion") {
          throw new JesutobitsError(
            ErrorCodes.storageInvalidSettings,
            `${key} cannot be changed by the panel`,
          );
        }
        if (value === null) delete next[key];
        else next[key] = value;
      }
      this.currentUiState = UiStateSchema.parse(next);
      return structuredClone(this.currentUiState);
    },
  };

  /** Kept in memory only, like SecretStorage: nothing the panel can read back. */
  private readonly storedSecrets = new Map<SecretRef, string>();

  readonly secrets = {
    prompt: async (ref: SecretRef): Promise<boolean> => {
      const typed = this.nextPromptedKey?.trim();
      if (!typed) return false;
      this.storedSecrets.set(ref, typed);
      return true;
    },
    delete: async (ref: SecretRef): Promise<void> => {
      this.storedSecrets.delete(ref);
    },
    exists: async (ref: SecretRef): Promise<boolean> => this.storedSecrets.has(ref),
    onChange: (handler: () => void): Unsubscribe => this.secretChanges.add(handler),
  };

  private readonly secretChanges = new Listeners<void>(false);

  /** Test helpers. */
  handle<M extends WorkbenchMethod>(method: M, handler: Handler<M>): void {
    (this.handlers as Record<string, unknown>)[method] = handler;
  }

  /** The user changed VS Code settings: the extension sends the new ones. */
  changeSettings(settings: AppSettings): void {
    this.currentSettings = AppSettingsSchema.parse(settings);
    this.settingsChanges.emit(structuredClone(this.currentSettings));
  }

  emitEvent(event: RuntimeEventBase): void {
    this.emitted.push(event);
    this.events.emit(event);
  }

  setStatus(update: RuntimeStatusUpdate): void {
    this.currentStatus = update;
    this.status.emit(update);
  }

  openProject(project: Project | null): void {
    this.projects.emit(project);
  }

  /** Stores a key as if the user had typed it into the extension's password box. */
  storeSecret(ref: SecretRef, value: string): void {
    this.storedSecrets.set(ref, value);
  }

  /** Stores a key from outside the panel (the "Set API key" command), and says so. */
  storeSecretElsewhere(ref: SecretRef, value: string): void {
    this.storedSecrets.set(ref, value);
    this.secretChanges.emit();
  }
}
