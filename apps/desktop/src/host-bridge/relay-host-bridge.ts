import {
  getMethod,
  RuntimeEventBaseSchema,
  RuntimeStatusUpdateSchema,
  toJesutobitsError,
  type MethodParams,
  type MethodResult,
  type RuntimeEventBase,
  type RuntimeStatusUpdate,
  type SecretRef,
  type WorkbenchMethod,
} from "@jesutobits/protocol";
import { Listeners } from "./listeners";
import { MockHostBridge, type MockStorage } from "./mock-host-bridge";
import type { Unsubscribe } from "./types";

/**
 * The browser Workbench against a real runtime through `scripts/dev-relay.mjs`
 * (`pnpm dev:web --runtime`, browser E2E). Runtime calls and events are real; Host features
 * (settings, dialogs) stay the mock's. Development only: `createHostBridge` picks it only
 * when `VITE_JESUTOBITS_RELAY` is set.
 */
export class RelayHostBridge extends MockHostBridge {
  private readonly relayEvents = new Listeners<RuntimeEventBase>(false);
  private readonly relayStatus = new Listeners<RuntimeStatusUpdate>(true);
  private readonly abort = new AbortController();

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    options: { storage?: MockStorage | undefined } = {},
  ) {
    super(options);
    this.relayStatus.emit({ status: "starting" });
    void this.stream();
  }

  /** `VITE_JESUTOBITS_RELAY` is `<url>#<token>`. */
  static fromSetting(
    setting: string,
    options: { storage?: MockStorage | undefined } = {},
  ): RelayHostBridge {
    const [url, token] = setting.split("#");
    if (!url || !token) throw new Error("VITE_JESUTOBITS_RELAY must be <url>#<token>");
    return new RelayHostBridge(url, token, undefined, options);
  }

  override async rpc<M extends WorkbenchMethod>(
    method: M,
    params: MethodParams<M>,
  ): Promise<MethodResult<M>> {
    let body: { result?: unknown; error?: unknown };
    try {
      const response = await this.fetchImpl(`${this.url}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-jesutobits-token": this.token },
        body: JSON.stringify({ method, params }),
      });
      body = (await response.json()) as typeof body;
    } catch (error) {
      throw toJesutobitsError({
        code: -32000,
        message: "The dev relay is not reachable",
        data: { code: "runtime.unavailable", message: String(error), retryable: true },
      });
    }
    if (body.error) throw toJesutobitsError(body.error);
    const result = getMethod(method)?.result.safeParse(body.result);
    if (!result?.success) {
      throw toJesutobitsError({ code: -32603, message: `Invalid result for ${method}` });
    }
    return result.data as MethodResult<M>;
  }

  /** The relay plays the Host's credential store for its runtime (`host.secrets.get`). */
  protected override async secretStored(ref: SecretRef, value: string | null): Promise<void> {
    await this.fetchImpl(`${this.url}/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-jesutobits-token": this.token },
      body: JSON.stringify({ ref, value }),
    });
  }

  override onRuntimeEvent(handler: (event: RuntimeEventBase) => void): Unsubscribe {
    return this.relayEvents.add(handler);
  }

  override onRuntimeStatus(handler: (update: RuntimeStatusUpdate) => void): Unsubscribe {
    return this.relayStatus.add(handler);
  }

  close(): void {
    this.abort.abort();
  }

  /** Reads the relay's NDJSON stream of status updates and runtime events. */
  private async stream(): Promise<void> {
    try {
      const response = await this.fetchImpl(`${this.url}/events`, {
        headers: { "x-jesutobits-token": this.token },
        signal: this.abort.signal,
      });
      if (!response.body) throw new Error("no event stream");
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          this.receive(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      }
      this.relayStatus.emit({ status: "failed", detail: "The dev relay closed the event stream" });
    } catch (error) {
      if (this.abort.signal.aborted) return;
      this.relayStatus.emit({ status: "failed", detail: `Dev relay: ${String(error)}` });
    }
  }

  private receive(line: string): void {
    const message = JSON.parse(line) as { kind: string; event?: unknown };
    if (message.kind === "status") {
      const { kind: _kind, ...update } = message;
      const parsed = RuntimeStatusUpdateSchema.safeParse(update);
      if (parsed.success) this.relayStatus.emit(parsed.data);
    } else if (message.kind === "event") {
      const parsed = RuntimeEventBaseSchema.loose().safeParse(message.event);
      if (parsed.success) this.relayEvents.emit(parsed.data);
    }
  }
}
