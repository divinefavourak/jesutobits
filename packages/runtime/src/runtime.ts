import {
  ErrorCodes,
  EVENT_NOTIFICATION_METHOD,
  isProtocolCompatible,
  JesutobitsError,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
} from "@jesutobits/protocol";
import type { Logger } from "@jesutobits/shared";
import { AgentService, type AgentEnvironment } from "./agent/agent-service.js";
import { RuntimeConfig } from "./config.js";
import { EventBus } from "./events/event-bus.js";
import { SecretRegistry } from "./log/secret-registry.js";
import { LineSplitter } from "./rpc/line-splitter.js";
import { PreviewManager } from "./preview/preview-manager.js";
import { registerPreview } from "./preview/preview-rpc.js";
import { Projects } from "./projects/projects.js";
import { RpcServer } from "./rpc/server.js";
import { openStorage, type Storage } from "./storage/storage.js";
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
  /** The app data dir from `--data-dir`; without it the database lives in memory. */
  dataDir: string | undefined;
  /** The registry the logger masks with; events and model requests use it too. */
  secrets?: SecretRegistry;
  /** Provider and search settings from the environment and arguments. */
  agent?: AgentEnvironment;
}

export interface Runtime {
  /** Feeds bytes read from stdin. */
  receive(chunk: Buffer): void;
  /** stdin reached EOF: the Host is gone (ADR-0002, parent-death detection). */
  endOfInput(): void;
  /** Where services emit runtime events. */
  readonly events: EventBus;
  /** The settings from the Host's latest `runtime.configure`. */
  readonly config: RuntimeConfig;
}

type LifecycleState = "awaiting_initialize" | "ready" | "shutting_down";

export function createRuntime(io: RuntimeIo): Runtime {
  let state: LifecycleState = "awaiting_initialize";
  let storage: Storage | undefined;
  // Settles once the database is open (just after the handshake); handlers that need it wait.
  let storageOpened: (storage: Storage) => void = () => undefined;
  let storageFailed: (error: unknown) => void = () => undefined;
  const storageReady = new Promise<Storage>((resolve, reject) => {
    storageOpened = resolve;
    storageFailed = reject;
  });
  storageReady.catch(() => undefined); // Callers see the rejection; nothing else must.
  const log = io.log.child({ module: "runtime" });

  const shutdown = (): void => {
    agent.stopAll();
    // The dev server goes with the runtime; exit only once it is stopped.
    void previews.stop().finally(() => {
      try {
        projects.closeActive();
        storage?.close();
      } catch (error) {
        log.error("could not close the database", { err: error });
      }
      io.exit(0);
    });
  };
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
    onResponded(method, ok) {
      if (method === "runtime.shutdown" && state === "shutting_down") shutdown();
      // After the reply is flushed, so migrations never delay the handshake (NFR-002).
      if (method === "runtime.initialize" && ok) startStorage();
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

  const config = new RuntimeConfig();
  server.register("runtime.configure", (params) => {
    config.update(params);
    log.info("settings received", { appDirs: params.appDirs.length });
    return {};
  });

  server.register("runtime.ping", (params) => ({
    uptimeMs: io.uptimeMs(),
    ...(params.echo !== undefined && { echo: params.echo }),
  }));

  const secrets = io.secrets ?? new SecretRegistry();
  const events = new EventBus({
    send: (event) => server.notify(EVENT_NOTIFICATION_METHOD, event),
    log: io.log.child({ module: "events" }),
    mask: (value) => secrets.maskValue(value),
  });
  server.register("events.replay", (params) => events.replay(params.afterSeq));

  const projects = new Projects({
    trash: async (path) => {
      await server.request("host.fs.trash", { path });
    },
    reveal: async (path) => {
      await server.request("host.os.reveal", { path });
    },
    events,
    log: io.log.child({ module: "projects" }),
    storage: () => storageReady,
    ripgrep: io.agent?.ripgrep,
  });
  projects.register(server);

  const previews = new PreviewManager({
    guestDir: io.agent?.guest,
    emit: (status) => events.emit("preview.status", { status }),
    mask: (text) => secrets.mask(text),
    log: io.log.child({ module: "preview" }),
  });
  registerPreview(server, projects, previews);
  projects.onClose((projectId) => void previews.closeProject(projectId));

  const agent = new AgentService({
    events,
    projects,
    storage: () => storageReady,
    config,
    secrets,
    fetchSecret: async (ref) => (await server.request("host.secrets.get", { ref })).value,
    log: io.log.child({ module: "agent" }),
    dataDir: io.dataDir,
    env: io.agent ?? {},
    previews,
  });
  agent.register(server);

  /** Opens the database; problems become events the Workbench shows (DATA_AND_PERSISTENCE.md 6.1). */
  function startStorage(): void {
    try {
      storage = openStorage({ dir: io.dataDir, log: io.log.child({ module: "storage" }) });
    } catch (error) {
      log.error("could not open the database", { err: error });
      const unavailable = new JesutobitsError(
        ErrorCodes.storageUnavailable,
        "Jesutobits could not open its database. Projects and sessions cannot be saved.",
        { userAction: "report" },
      );
      storageFailed(unavailable);
      events.emit("runtime.error", { error: unavailable.toData() });
      return;
    }
    storageOpened(storage);
    for (const notice of storage.notices) {
      events.emit("runtime.warning", { message: notice.message, code: notice.code });
    }
    agent.recover().catch((error: unknown) => {
      log.error("could not recover interrupted turns", { err: error });
    });
  }

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
    config,
    receive: (chunk) => splitter.push(chunk),
    endOfInput() {
      splitter.end();
      server.failPending("the Host is gone");
      state = "shutting_down";
      shutdown();
    },
  };
}
