import {
  AppSettingsSchema,
  ErrorCodes,
  JesutobitsError,
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

/**
 * Fixed answers for the methods the mock knows. Others fail with `rpc.method_not_found`;
 * relaying to a real runtime (Phase 1 step 12) covers projects and files.
 */
type Handlers = Partial<{
  [M in WorkbenchMethod]: (params: MethodParams<M>) => MethodResult<M>;
}>;

/**
 * In-memory HostBridge for `pnpm dev:web` and browser tests (TESTING_STRATEGY.md section
 * 3.2). It answers from fixed handlers; Phase 1 adds relaying to a real runtime.
 */
export class MockHostBridge implements HostBridge {
  readonly logs: Array<{ level: LogLevel; message: string }> = [];
  readyReports = 0;
  /** What the next folder dialog returns: a path, or null for Cancel (test helper). */
  nextPickedFolder: string | null = null;
  /** Startup notices the next `notices()` returns (test helper). */
  pendingNotices: HostNotice[] = [];
  private currentSettings: AppSettings = AppSettingsSchema.parse({});
  private currentUiState: UiState = UiStateSchema.parse({});
  private readonly settingsChanges = new Listeners<AppSettings>(false);
  private readonly events = new Listeners<RuntimeEventBase>(false);
  private readonly status = new Listeners<RuntimeStatusUpdate>(true);
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
  }

  async rpc<M extends WorkbenchMethod>(
    method: M,
    params: MethodParams<M>,
  ): Promise<MethodResult<M>> {
    const handler = this.handlers[method] as ((p: MethodParams<M>) => MethodResult<M>) | undefined;
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

  /** Like the Host: only a failed runtime restarts, through `starting` to `ready`. */
  async restartRuntime(): Promise<void> {
    if (this.currentStatus.status !== "failed") return;
    this.setStatus({ status: "starting" });
    await Promise.resolve();
    this.setStatus({ status: "ready" });
  }

  reportReady(): void {
    this.readyReports += 1;
  }

  log(level: LogLevel, message: string): void {
    this.logs.push({ level, message });
  }

  /** Same rules as the Host's settings store: deep merge, validate, then save. */
  readonly settings = {
    get: async (): Promise<AppSettings> => structuredClone(this.currentSettings),
    update: async (patch: SettingsPatch): Promise<AppSettings> => {
      const { schemaVersion: _ignored, ...rest } = patch as Record<string, unknown>;
      const merged = mergeDeep(structuredClone(this.currentSettings), rest);
      const parsed = AppSettingsSchema.safeParse(merged);
      if (!parsed.success) {
        throw new JesutobitsError(ErrorCodes.storageInvalidSettings, "Invalid settings", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      this.currentSettings = parsed.data;
      this.settingsChanges.emit(structuredClone(parsed.data));
      return structuredClone(parsed.data);
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
            `${key} cannot be changed by the Workbench`,
          );
        }
        if (value === null) delete next[key];
        else next[key] = value;
      }
      this.currentUiState = UiStateSchema.parse(next);
      return structuredClone(this.currentUiState);
    },
  };

  readonly dialogs = {
    pickFolder: async (): Promise<string | null> => this.nextPickedFolder,
  };

  async notices(): Promise<HostNotice[]> {
    return this.pendingNotices;
  }

  /** Test helpers. */
  emitEvent(event: RuntimeEventBase): void {
    this.emitted.push(event);
    this.events.emit(event);
  }

  setStatus(update: RuntimeStatusUpdate): void {
    this.currentStatus = update;
    this.status.emit(update);
  }
}

/** Objects merge key by key; anything else replaces (the Host's `merge`). */
function mergeDeep(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [key, value] of Object.entries(patch)) {
    const current = target[key];
    if (isPlainObject(current) && isPlainObject(value)) mergeDeep(current, value);
    else target[key] = value;
  }
  return target;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
