import {
  ErrorCodes,
  EVENT_NOTIFICATION_METHOD,
  isProtocolCompatible,
  JesutobitsError,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
} from "@jesutobits/protocol";
import type { Logger } from "@jesutobits/shared";
import { EventBus } from "./events/event-bus.js";
import { LineSplitter } from "./rpc/line-splitter.js";
import { RpcServer } from "./rpc/server.js";
import { RUNTIME_VERSION } from "./version.js";

export interface RuntimeIo {
  /** Writes one NDJSON line to the Host (stdout). Resolves once flushed. */
  write(line: string): Promise<void>;
  /** Structured lines for the Host's runtime log (stderr). */
  log: Logger;
  exit(code: number): void;
  /** Milliseconds since the runtime started. */
  uptimeMs(): number;
  /** Startup marks in milliseconds since the process started (reported by `initialize`). */
  startupMarks(): { nodeBootstrapMs: number; mainStartMs: number };
}

export interface Runtime {
  /** Feeds bytes read from stdin. */
  receive(chunk: Buffer): void;
  /** stdin reached EOF: the Host is gone (ADR-0002, parent-death detection). */
  endOfInput(): void;
  /** Where services emit runtime events. */
  readonly events: EventBus;
}

type LifecycleState = "awaiting_initialize" | "ready" | "shutting_down";

export function createRuntime(io: RuntimeIo): Runtime {
  let state: LifecycleState = "awaiting_initialize";

  const shutdown = (): void => {
    // Later phases cancel the active turn, stop managed processes and flush SQLite here.
    io.exit(0);
  };

  const log = io.log.child({ module: "runtime" });
  const server = new RpcServer({
    send: (line) => io.write(`${line}\n`),
    log: io.log.child({ module: "rpc" }),
    gate(method) {
      if (state === "shutting_down") {
        throw new JesutobitsError(ErrorCodes.runtimeShuttingDown, "The runtime is shutting down");
      }
      if (state === "awaiting_initialize" && method !== "runtime.initialize") {
        throw new JesutobitsError(
          ErrorCodes.runtimeNotInitialized,
          "Call runtime.initialize first",
        );
      }
    },
    onResponded(method) {
      if (method === "runtime.shutdown" && state === "shutting_down") shutdown();
    },
  });

  server.register("runtime.initialize", (params) => {
    if (state !== "awaiting_initialize") {
      throw new JesutobitsError(
        ErrorCodes.runtimeAlreadyInitialized,
        "The runtime is already initialised",
      );
    }
    if (!isProtocolCompatible(params.protocolVersion, PROTOCOL_VERSION)) {
      throw new JesutobitsError(
        ErrorCodes.runtimeProtocolMismatch,
        `Protocol ${params.protocolVersion} is not compatible with runtime protocol ${PROTOCOL_VERSION}`,
        {
          userAction: "reinstall",
          details: { client: params.protocolVersion, runtime: PROTOCOL_VERSION },
        },
      );
    }
    state = "ready";
    return {
      protocolVersion: PROTOCOL_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      nodeVersion: process.version,
      startup: { ...io.startupMarks(), initializeReceivedMs: io.uptimeMs() },
    };
  });

  server.register("runtime.ping", (params) => ({
    uptimeMs: io.uptimeMs(),
    ...(params.echo !== undefined && { echo: params.echo }),
  }));

  const events = new EventBus({
    send: (event) => server.notify(EVENT_NOTIFICATION_METHOD, event),
    log: io.log.child({ module: "events" }),
  });
  server.register("events.replay", (params) => events.replay(params.afterSeq));

  server.register("runtime.shutdown", () => {
    state = "shutting_down";
    return {};
  });

  const report = (error: unknown): void => {
    log.error("failed to handle a message", { err: error });
  };
  const splitter = new LineSplitter(
    MAX_MESSAGE_BYTES,
    (line) => void server.handleLine(line).catch(report),
    () => void server.handleOversize().catch(report),
  );

  return {
    events,
    receive: (chunk) => splitter.push(chunk),
    endOfInput() {
      splitter.end();
      state = "shutting_down";
      shutdown();
    },
  };
}
