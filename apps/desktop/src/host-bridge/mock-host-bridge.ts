import {
  ErrorCodes,
  JesutobitsError,
  type LogLevel,
  type MethodParams,
  type MethodResult,
  type RuntimeEventBase,
  type RuntimeStatusUpdate,
  type WorkbenchMethod,
} from "@jesutobits/protocol";
import { Listeners } from "./listeners";
import type { HostBridge, Unsubscribe } from "./types";

type Handlers = { [M in WorkbenchMethod]: (params: MethodParams<M>) => MethodResult<M> };

/**
 * In-memory HostBridge for `pnpm dev:web` and browser tests (TESTING_STRATEGY.md section
 * 3.2). It answers from fixed handlers; Phase 1 adds relaying to a real runtime.
 */
export class MockHostBridge implements HostBridge {
  readonly logs: Array<{ level: LogLevel; message: string }> = [];
  readyReports = 0;
  private readonly events = new Listeners<RuntimeEventBase>(false);
  private readonly status = new Listeners<RuntimeStatusUpdate>(true);
  private currentStatus: RuntimeStatusUpdate = { status: "ready" };
  private readonly started = performance.now();
  private readonly handlers: Handlers = {
    "runtime.ping": (params) => ({
      uptimeMs: performance.now() - this.started,
      ...(params.echo !== undefined && { echo: params.echo }),
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

  /** Test helpers. */
  emitEvent(event: RuntimeEventBase): void {
    this.events.emit(event);
  }

  setStatus(update: RuntimeStatusUpdate): void {
    this.currentStatus = update;
    this.status.emit(update);
  }
}
