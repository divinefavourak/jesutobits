import type { MethodParams, MethodResult, WorkbenchMethod } from "@jesutobits/protocol";

/**
 * The Workbench's only way to reach the Host (ARCHITECTURE.md section 6.2). Only this folder
 * may import `@tauri-apps/*`. Grows member by member as features land; Phase 1 adds the
 * Tauri and mock implementations.
 */
export interface HostBridge {
  rpc<M extends WorkbenchMethod>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
}
