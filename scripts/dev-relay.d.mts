// Types for scripts/dev-relay.mjs, used by the browser E2E fixtures (apps/desktop/e2e).

export interface DevRelay {
  /** `http://127.0.0.1:<port>`. */
  url: string;
  /** Sent in the `x-jesutobits-token` header. */
  token: string;
  /** Shuts the runtime down and stops listening. */
  close(): Promise<void>;
}

export function startRelay(options?: {
  port?: number;
  dataDir?: string;
  /** The one browser origin allowed to call the relay. */
  origin?: string;
  token?: string;
  /** Hides the runtime's log lines. */
  quiet?: boolean;
}): Promise<DevRelay>;
