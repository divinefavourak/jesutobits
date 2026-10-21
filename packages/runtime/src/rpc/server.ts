import {
  classifyMessage,
  ErrorCodes,
  getMethod,
  isJesutobitsError,
  JesutobitsError,
  JSONRPC_VERSION,
  MAX_MESSAGE_BYTES,
  RpcErrorCode,
  type JesutobitsErrorData,
  type MethodName,
  type MethodResult,
  type METHODS,
  type RequestId,
  REVERSE_METHODS,
  toJesutobitsError,
  type ReverseMethod,
  type ReverseParams,
  type ReverseResult,
} from "@jesutobits/protocol";
import type { Logger } from "@jesutobits/shared";
import { z } from "zod";

export type MethodHandler<M extends MethodName> = (
  params: z.output<(typeof METHODS)[M]["params"]>,
) => MethodResult<M> | Promise<MethodResult<M>>;

export interface RpcServerOptions {
  /** Writes one serialised message; the server appends nothing. Resolves once flushed. */
  send(line: string): Promise<void>;
  /** Structured log lines for the Host's runtime log (stderr). Never stdout. */
  log: Logger;
  /** Runs before params are parsed. Throw a JesutobitsError to reject the call. */
  gate?(method: MethodName): void;
  /** Called after a response to `method` has been flushed. */
  onResponded?(method: MethodName, ok: boolean): void;
}

type AnyHandler = (params: unknown) => unknown;

/**
 * JSON-RPC 2.0 server for requests from the Host (ADR-0003). Every request is validated
 * against its schema in `@jesutobits/protocol` before a handler runs (NFR-024), and every
 * result is validated before it is sent.
 */
/** How long a reverse call may take before it fails with `rpc.timeout`. */
const REVERSE_CALL_TIMEOUT_MS = 30_000;

export class RpcServer {
  private readonly handlers = new Map<MethodName, AnyHandler>();
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void; method: string }
  >();
  private nextRequestId = 1;

  constructor(private readonly options: RpcServerOptions) {}

  register<M extends MethodName>(method: M, handler: MethodHandler<M>): void {
    if (this.handlers.has(method)) throw new Error(`Handler for ${method} already registered`);
    this.handlers.set(method, handler as AnyHandler);
  }

  /** Handles one NDJSON line. Resolves after any response has been flushed. */
  async handleLine(line: string): Promise<void> {
    if (line.trim() === "") return;

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return this.fail(null, RpcErrorCode.ParseError, ErrorCodes.rpcParseError, "Invalid JSON");
    }

    const classified = classifyMessage(value);
    switch (classified.kind) {
      case "invalid":
        return this.fail(
          classified.id,
          RpcErrorCode.InvalidRequest,
          ErrorCodes.rpcInvalidRequest,
          "Invalid JSON-RPC message",
          { issues: classified.issues },
        );
      case "notification":
        this.options.log.warn("ignoring a notification", { method: classified.message.method });
        return;
      case "success":
      case "failure": {
        const id = String(classified.message.id);
        const waiting = this.pending.get(id);
        if (!waiting) {
          this.options.log.warn("ignoring an unexpected response", { id });
          return;
        }
        this.pending.delete(id);
        if (classified.kind === "success") waiting.resolve(classified.message.result);
        else waiting.reject(toJesutobitsError(classified.message.error));
        return;
      }
      case "request":
        return this.dispatch(
          classified.message.id,
          classified.message.method,
          classified.message.params,
        );
    }
  }

  /**
   * Sends a notification (runtime events). Never throws: an oversized or failed write is
   * logged and dropped, and events stay replayable from the EventBus.
   */
  notify(method: string, params: unknown): void {
    const line = JSON.stringify({ jsonrpc: JSONRPC_VERSION, method, params });
    if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) {
      this.options.log.error("dropped a notification over the message limit", {
        method,
        maxBytes: MAX_MESSAGE_BYTES,
      });
      return;
    }
    this.options.send(line).catch((error: unknown) => {
      this.options.log.error("could not send a notification", { method, err: error });
    });
  }

  /**
   * Calls a Host method (a reverse call, ADR-0014) and waits for its reply. The result is
   * checked against the method's schema; Host errors reject with a JesutobitsError.
   */
  async request<M extends ReverseMethod>(
    method: M,
    params: ReverseParams<M>,
    timeoutMs = REVERSE_CALL_TIMEOUT_MS,
  ): Promise<ReverseResult<M>> {
    const id = `r-${this.nextRequestId++}`;
    const reply = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new JesutobitsError(ErrorCodes.rpcTimeout, `${method} did not reply in time`, {
            retryable: true,
          }),
        );
      }, timeoutMs);
    });
    try {
      await this.options.send(JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, method, params }));
      const raw = await Promise.race([reply, timeout]);
      const result = REVERSE_METHODS[method].result.safeParse(raw);
      if (!result.success) {
        throw new JesutobitsError(ErrorCodes.rpcInternal, `Invalid result from ${method}`);
      }
      return result.data as ReverseResult<M>;
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  /** Fails every reverse call still waiting (the Host is gone). */
  failPending(reason: string): void {
    for (const [id, waiting] of this.pending) {
      waiting.reject(
        new JesutobitsError(ErrorCodes.runtimeUnavailable, `${waiting.method}: ${reason}`),
      );
      this.pending.delete(id);
    }
  }

  /** Reports a line the splitter dropped for exceeding MAX_MESSAGE_BYTES. */
  async handleOversize(): Promise<void> {
    return this.fail(
      null,
      RpcErrorCode.InvalidRequest,
      ErrorCodes.rpcMessageTooLarge,
      `Message exceeds ${MAX_MESSAGE_BYTES} bytes`,
    );
  }

  private async dispatch(id: RequestId, name: string, rawParams: unknown): Promise<void> {
    const method = getMethod(name);
    const handler = method && this.handlers.get(method.name as MethodName);
    if (!method || !handler) {
      return this.fail(
        id,
        RpcErrorCode.MethodNotFound,
        ErrorCodes.rpcMethodNotFound,
        `Unknown method ${name}`,
      );
    }
    const methodName = method.name as MethodName;

    let ok = false;
    try {
      this.options.gate?.(methodName);

      const params = method.params.safeParse(rawParams ?? {});
      if (!params.success) {
        await this.fail(
          id,
          RpcErrorCode.InvalidParams,
          ErrorCodes.rpcInvalidParams,
          `Invalid params for ${name}`,
          {
            issues: z.prettifyError(params.error),
          },
        );
        return;
      }

      const result = method.result.safeParse(await handler(params.data));
      if (!result.success) {
        this.options.log.error("a handler returned an invalid result", {
          method: name,
          issues: z.prettifyError(result.error),
        });
        await this.fail(id, RpcErrorCode.InternalError, ErrorCodes.rpcInternal, "Internal error");
        return;
      }

      await this.respond(JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, result: result.data }), id);
      ok = true;
    } catch (error) {
      if (isJesutobitsError(error)) {
        await this.failWith(id, RpcErrorCode.ApplicationError, error.toData());
      } else {
        this.options.log.error("unhandled error in a handler", { method: name, err: error });
        await this.fail(id, RpcErrorCode.InternalError, ErrorCodes.rpcInternal, "Internal error");
      }
    } finally {
      this.options.onResponded?.(methodName, ok);
    }
  }

  private fail(
    id: RequestId | null,
    code: number,
    errorCode: JesutobitsErrorData["code"],
    message: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const data = new JesutobitsError(errorCode, message, details ? { details } : {}).toData();
    return this.failWith(id, code, data);
  }

  private failWith(id: RequestId | null, code: number, data: JesutobitsErrorData): Promise<void> {
    return this.respond(
      JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id,
        error: { code, message: data.message, data },
      }),
      id,
    );
  }

  private async respond(line: string, id: RequestId | null): Promise<void> {
    if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) {
      // Methods page large payloads themselves; reaching this is a bug in the method.
      this.options.log.error("a response exceeds the message limit", {
        id: String(id),
        maxBytes: MAX_MESSAGE_BYTES,
      });
      return this.fail(
        id,
        RpcErrorCode.InternalError,
        ErrorCodes.rpcMessageTooLarge,
        "Response too large",
      );
    }
    await this.options.send(line);
  }
}
