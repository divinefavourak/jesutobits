// JSON-RPC 2.0 over the runtime's stdio (ADR-0003): one message per line. Calls out, events
// and reverse calls in. No `vscode` import, so it is tested against the real runtime on Node.
import type { Readable, Writable } from "node:stream";
import {
  classifyMessage,
  ErrorCodes,
  JSONRPC_VERSION,
  MAX_MESSAGE_BYTES,
  RpcErrorCode,
  type JesutobitsErrorCode,
  type RpcErrorObject,
} from "@jesutobits/protocol";

/** A call that failed; `error` is the JSON-RPC error object, with a JesutobitsError in `data`. */
export class RpcCallError extends Error {
  constructor(readonly error: RpcErrorObject) {
    super(error.message);
    this.name = "RpcCallError";
  }
}

/** A JSON-RPC error object whose `data` is a JesutobitsError, as the runtime sends them. */
export function rpcError(
  code: number,
  errorCode: JesutobitsErrorCode,
  message: string,
): RpcErrorObject {
  return { code, message, data: { code: errorCode, message, retryable: false } };
}

export interface ConnectionHandlers {
  /** An `event` notification's params (a runtime event, validated by whoever renders it). */
  onEvent(event: unknown): void;
  /** A reverse call (`host.*`). Throw an `RpcCallError` to answer with an error. */
  onRequest(method: string, params: unknown): Promise<unknown>;
  /** A line that is not valid JSON-RPC; logged, never fatal. */
  onProtocolError(message: string): void;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: RpcCallError): void;
  timer: NodeJS.Timeout;
}

export class RuntimeConnection {
  readonly #stdin: Writable;
  readonly #handlers: ConnectionHandlers;
  readonly #pending = new Map<string, Pending>();
  #nextId = 1;
  #buffer = "";
  /** Set while dropping the rest of a line that went over MAX_MESSAGE_BYTES. */
  #skippingLine = false;
  #closed = false;

  constructor(stdin: Writable, stdout: Readable, handlers: ConnectionHandlers) {
    this.#stdin = stdin;
    this.#handlers = handlers;
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => this.#receive(chunk));
    stdout.on("close", () => this.close("The runtime closed its output"));
    // A write after the runtime exited fails here; the exit is reported by the supervisor.
    stdin.on("error", () => this.close("The runtime's input closed"));
  }

  get closed(): boolean {
    return this.#closed;
  }

  call(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(
        new RpcCallError(
          rpcError(
            RpcErrorCode.ApplicationError,
            ErrorCodes.runtimeUnavailable,
            "The runtime is not running",
          ),
        ),
      );
    }
    const id = `ext-${this.#nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new RpcCallError(
            rpcError(
              RpcErrorCode.ApplicationError,
              ErrorCodes.rpcTimeout,
              `${method} did not reply in time`,
            ),
          ),
        );
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ jsonrpc: JSONRPC_VERSION, id, method, params });
    });
  }

  /** Fails every call still waiting; later calls fail at once. */
  close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new RpcCallError(
          rpcError(RpcErrorCode.ApplicationError, ErrorCodes.runtimeUnavailable, reason),
        ),
      );
    }
    this.#pending.clear();
  }

  #write(message: object): void {
    if (this.#closed) return;
    this.#stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    let newline: number;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (this.#skippingLine) {
        this.#skippingLine = false;
        continue;
      }
      if (line.trim() !== "") this.#handleLine(line);
    }
    // Characters, not bytes: a cheap upper bound that never cuts a valid message short.
    if (this.#buffer.length > MAX_MESSAGE_BYTES) {
      this.#handlers.onProtocolError(`Dropped a runtime message over ${MAX_MESSAGE_BYTES} bytes`);
      this.#buffer = "";
      this.#skippingLine = true;
    }
  }

  #handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.#handlers.onProtocolError("The runtime wrote a line that is not JSON");
      return;
    }
    const classified = classifyMessage(value);
    switch (classified.kind) {
      case "notification":
        if (classified.message.method === "event")
          this.#handlers.onEvent(classified.message.params);
        return;
      case "request":
        void this.#answer(
          classified.message.id,
          classified.message.method,
          classified.message.params,
        );
        return;
      case "success":
      case "failure": {
        const id = String(classified.message.id);
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        if (classified.kind === "success") pending.resolve(classified.message.result);
        else pending.reject(new RpcCallError(classified.message.error));
        return;
      }
      case "invalid":
        this.#handlers.onProtocolError(`Invalid message from the runtime: ${classified.issues}`);
    }
  }

  async #answer(id: string | number, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.#handlers.onRequest(method, params);
      this.#write({ jsonrpc: JSONRPC_VERSION, id, result });
    } catch (error) {
      const rpc =
        error instanceof RpcCallError
          ? error.error
          : rpcError(
              RpcErrorCode.InternalError,
              ErrorCodes.rpcInternal,
              error instanceof Error ? error.message : String(error),
            );
      this.#write({ jsonrpc: JSONRPC_VERSION, id, error: rpc });
    }
  }
}
