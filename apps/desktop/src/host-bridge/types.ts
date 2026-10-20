import type {
  LogLevel,
  MethodParams,
  MethodResult,
  RuntimeEventBase,
  RuntimeStatusUpdate,
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
  /** Writes to the Workbench log through the Host (ARCHITECTURE.md section 10). */
  log(level: LogLevel, message: string): void;
}
