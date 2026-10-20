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
} from "@jesutobits/protocol";
import { z } from "zod";

export type MethodHandler<M extends MethodName> = (
  params: z.output<(typeof METHODS)[M]["params"]>,
) => MethodResult<M> | Promise<MethodResult<M>>;

export interface RpcServerOptions {
  /** Writes one serialised message; the server appends nothing. Resolves once flushed. */
  send(line: string): Promise<void>;
  /** Unstructured diagnostics for the Host's runtime log (stderr). Never stdout. */
  diagnostic(message: string): void;
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
export class RpcServer {
  private readonly handlers = new Map<MethodName, AnyHandler>();

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
        this.options.diagnostic(`Ignoring notification ${classified.message.method}`);
        return;
      case "success":
      case "failure":
        // Reverse calls (host.*) arrive with Phase 2; until then nothing awaits a response.
        this.options.diagnostic(`Ignoring unexpected response id=${String(classified.message.id)}`);
        return;
      case "request":
        return this.dispatch(
          classified.message.id,
          classified.message.method,
          classified.message.params,
        );
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
        this.options.diagnostic(
          `Handler for ${name} returned an invalid result: ${z.prettifyError(result.error)}`,
        );
        await this.fail(id, RpcErrorCode.InternalError, ErrorCodes.rpcInternal, "Internal error");
        return;
      }

      await this.respond(JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, result: result.data }), id);
      ok = true;
    } catch (error) {
      if (isJesutobitsError(error)) {
        await this.failWith(id, RpcErrorCode.ApplicationError, error.toData());
      } else {
        this.options.diagnostic(
          `Unhandled error in ${name}: ${error instanceof Error ? error.stack : String(error)}`,
        );
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
      this.options.diagnostic(`Response to id=${String(id)} exceeds ${MAX_MESSAGE_BYTES} bytes`);
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
