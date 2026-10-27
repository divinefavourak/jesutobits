// Starts and supervises the runtime (ADR-0002, ADR-0015): the only module that spawns it. A
// port of the Tauri Host's supervisor, without the Job Object.
//
// - Starting: spawn, `runtime.initialize` within 10 s, then Ready.
// - Health pings every 5 s: two misses mark the runtime Degraded, five restart it.
// - An exit nobody asked for is a crash: Restarting, with a 0.5, 1, 2 or 4 s wait
//   (RestartPolicy), then Starting again. The fifth crash within two minutes ends in Failed.
// - A handshake timeout, a protocol mismatch or a failed spawn cannot be fixed by retrying
//   and go straight to Failed.
// - From Failed, only the user's Restart starts it again.
//
// No `vscode` import: the extension passes in how to launch and how to answer reverse calls.
import {
  execFile,
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  ErrorCodes,
  isProtocolCompatible,
  PROTOCOL_VERSION,
  RpcErrorCode,
  type LogLevel,
  type RuntimeStatus,
  type RuntimeStatusUpdate,
} from "@jesutobits/protocol";
import { RpcCallError, rpcError, RuntimeConnection } from "./connection.js";
import { RestartPolicy } from "./restart-policy.js";

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** All in milliseconds, except the counts. */
export interface SupervisorTimings {
  handshake: number;
  pingInterval: number;
  pingTimeout: number;
  missedPingsDegraded: number;
  missedPingsRestart: number;
  backoff: readonly number[];
  crashWindow: number;
  crashesUntilFailed: number;
  shutdownReply: number;
  shutdownExit: number;
}

export const DEFAULT_TIMINGS: SupervisorTimings = {
  handshake: 10_000,
  pingInterval: 5_000,
  pingTimeout: 2_000,
  missedPingsDegraded: 2,
  missedPingsRestart: 5,
  backoff: [500, 1_000, 2_000, 4_000],
  crashWindow: 120_000,
  crashesUntilFailed: 5,
  shutdownReply: 2_000,
  shutdownExit: 5_000,
};

/** Calls from the extension wait this long unless the caller says otherwise. */
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
/** Longer runtime log lines are cut, so one bad line cannot flood the log. */
const MAX_STDERR_LINE_CHARS = 64 * 1024;

export interface SupervisorOptions {
  launch(): LaunchSpec;
  client: { name: string; version: string };
  /** Reverse calls from the runtime (`host.*`). */
  onRequest(method: string, params: unknown): Promise<unknown>;
  /**
   * After every handshake, before the runtime is marked Ready. The extension sends
   * `runtime.configure` here, so it reaches the runtime ahead of any webview call.
   */
  onReady?(connection: RuntimeConnection): void;
  /** The supervisor's own log lines. */
  log(level: LogLevel, message: string): void;
  /** The runtime's stderr, one structured log line at a time. */
  onRuntimeLog?(line: string): void;
  timings?: Partial<SupervisorTimings>;
  spawn?: typeof nodeSpawn;
}

type Request = "restart" | "shutdown";
type Ended =
  | { kind: "crashed"; detail: string }
  | { kind: "fatal"; detail: string }
  | { kind: "restart_requested" }
  | { kind: "shutdown" };

export class RuntimeSupervisor {
  readonly #options: SupervisorOptions;
  readonly #timings: SupervisorTimings;
  readonly #policy: RestartPolicy;
  readonly #statusListeners = new Set<(update: RuntimeStatusUpdate) => void>();
  readonly #eventListeners = new Set<(event: unknown) => void>();
  #status: RuntimeStatusUpdate = { status: "starting" };
  #connection: RuntimeConnection | undefined;
  #pendingRequest: Request | undefined;
  #waiter: ((request: Request) => void) | undefined;
  #shuttingDown = false;
  #done: Promise<void> | undefined;

  constructor(options: SupervisorOptions) {
    this.#options = options;
    this.#timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.#policy = new RestartPolicy(
      this.#timings.backoff,
      this.#timings.crashWindow,
      this.#timings.crashesUntilFailed,
    );
  }

  get status(): RuntimeStatusUpdate {
    return this.#status;
  }

  /** Called with the current status at once, then on every change. */
  onStatus(listener: (update: RuntimeStatusUpdate) => void): () => void {
    this.#statusListeners.add(listener);
    listener(this.#status);
    return () => this.#statusListeners.delete(listener);
  }

  /** Runtime events (`event` notifications), unvalidated. */
  onEvent(listener: (event: unknown) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  start(): void {
    this.#done ??= this.#supervise();
  }

  /** Stops the running runtime (if any) and starts a fresh one; from Failed, forgets past crashes. */
  restart(): void {
    if (!this.#done) return this.start();
    this.#request("restart");
  }

  /** Calls a runtime method. Fails with `runtime.unavailable` unless the runtime is up. */
  call(method: string, params: unknown, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
    const up = this.#status.status === "ready" || this.#status.status === "degraded";
    if (!this.#connection || !up) {
      return Promise.reject(
        new RpcCallError(
          rpcError(
            RpcErrorCode.ApplicationError,
            ErrorCodes.runtimeUnavailable,
            `The runtime is ${this.#status.status}`,
          ),
        ),
      );
    }
    return this.#connection.call(method, params, timeoutMs);
  }

  /** Asks the runtime to shut down, kills it if it does not exit in time, and stops supervising. */
  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    this.#request("shutdown");
    await this.#done;
  }

  #request(request: Request): void {
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      waiter(request);
    } else if (this.#pendingRequest !== "shutdown") {
      this.#pendingRequest = request;
    }
  }

  /** The next restart or shutdown request. A later call replaces an unanswered earlier one. */
  #nextRequest(): Promise<Request> {
    const pending = this.#pendingRequest;
    if (pending) {
      this.#pendingRequest = undefined;
      return Promise.resolve(pending);
    }
    return new Promise((resolve) => {
      this.#waiter = resolve;
    });
  }

  #setStatus(status: RuntimeStatus, detail?: string): void {
    if (this.#status.status === status && this.#status.detail === detail) return;
    this.#status = detail === undefined ? { status } : { status, detail };
    for (const listener of this.#statusListeners) listener(this.#status);
  }

  async #supervise(): Promise<void> {
    for (;;) {
      const ended = await this.#runOnce(this.#nextRequest());
      this.#connection = undefined;
      if (ended.kind === "shutdown" || this.#shuttingDown) return;
      if (ended.kind === "restart_requested") continue;

      let failure = ended.detail;
      if (ended.kind === "crashed") {
        const decision = this.#policy.onCrash(performance.now());
        if (decision.kind === "restart") {
          this.#options.log("warn", `${ended.detail}; restarting in ${decision.afterMs} ms`);
          this.#setStatus("restarting", ended.detail);
          const wait = sleep(decision.afterMs);
          const woke = await Promise.race([this.#nextRequest(), wait.promise]);
          wait.cancel();
          if (woke === "shutdown") return;
          continue;
        }
        failure = `${ended.detail}. It stopped ${decision.crashes} times in two minutes, so it was not restarted again.`;
      }
      this.#options.log("error", failure);
      this.#setStatus("failed", failure);
      if ((await this.#nextRequest()) === "shutdown") return;
      this.#policy.reset();
    }
  }

  async #runOnce(requested: Promise<Request>): Promise<Ended> {
    this.#setStatus("starting");
    const spec = this.#options.launch();
    const spawn = this.#options.spawn ?? nodeSpawn;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(spec.command, spec.args, { env: spec.env, stdio: "pipe", windowsHide: true });
    } catch (error) {
      return { kind: "fatal", detail: `The runtime could not be started: ${errorMessage(error)}` };
    }
    const exited = new Promise<Ended>((resolve) => {
      child.once("error", (error) =>
        resolve({ kind: "fatal", detail: `The runtime could not be started: ${error.message}` }),
      );
      child.once("exit", (code, signal) =>
        resolve({
          kind: "crashed",
          detail: `The runtime stopped unexpectedly (${code === null ? `signal ${signal}` : `exit code ${code}`})`,
        }),
      );
    });
    this.#forwardStderr(child);
    const connection = new RuntimeConnection(child.stdin, child.stdout, {
      onEvent: (event) => {
        for (const listener of this.#eventListeners) listener(event);
      },
      onRequest: (method, params) => this.#options.onRequest(method, params),
      onProtocolError: (message) => this.#options.log("warn", message),
    });
    const onExit = (ended: Ended): Ended => {
      connection.close("The runtime stopped");
      return this.#shuttingDown ? { kind: "shutdown" } : ended;
    };

    // Handshake.
    const startedAt = performance.now();
    const handshake = await Promise.race([
      connection
        .call(
          "runtime.initialize",
          { protocolVersion: PROTOCOL_VERSION, client: this.#options.client },
          this.#timings.handshake,
        )
        .then(
          (result) => ({ kind: "answered" as const, result }),
          (error: unknown) => ({ kind: "refused" as const, error }),
        ),
      exited.then((ended) => ({ kind: "exited" as const, ended })),
      requested.then((request) => ({ kind: "requested" as const, request })),
    ]);
    if (handshake.kind === "exited") return onExit(handshake.ended);
    if (handshake.kind === "requested") {
      await this.#kill(child, exited);
      connection.close("The runtime was stopped");
      return handshake.request === "shutdown"
        ? { kind: "shutdown" }
        : { kind: "restart_requested" };
    }
    if (handshake.kind === "refused") {
      const error = handshake.error;
      const code = error instanceof RpcCallError ? error.error.data?.code : undefined;
      if (code === ErrorCodes.runtimeUnavailable) return onExit(await exited);
      await this.#kill(child, exited);
      connection.close("The runtime was stopped");
      return {
        kind: "fatal",
        detail:
          code === ErrorCodes.rpcTimeout
            ? `The runtime did not answer the handshake within ${this.#timings.handshake / 1000} s`
            : `The runtime refused the handshake: ${errorMessage(error)}`,
      };
    }
    const runtimeProtocol = readString(handshake.result, "protocolVersion");
    if (runtimeProtocol === undefined || !isProtocolCompatible(runtimeProtocol, PROTOCOL_VERSION)) {
      await this.#kill(child, exited);
      connection.close("The runtime was stopped");
      return {
        kind: "fatal",
        detail: `The runtime speaks protocol ${runtimeProtocol ?? "unknown"}, the extension ${PROTOCOL_VERSION}`,
      };
    }
    this.#options.log(
      "info",
      `runtime ${readString(handshake.result, "runtimeVersion") ?? "?"} on Node ${readString(handshake.result, "nodeVersion") ?? "?"} ready in ${Math.round(performance.now() - startedAt)} ms`,
    );
    this.#connection = connection;
    this.#options.onReady?.(connection);
    this.#setStatus("ready");

    // Health pings until the runtime exits or someone asks for a restart or shutdown.
    let missed = 0;
    for (;;) {
      const tick = sleep(this.#timings.pingInterval);
      const next = await Promise.race([
        exited.then((ended) => ({ kind: "exited" as const, ended })),
        requested.then((request) => ({ kind: "requested" as const, request })),
        tick.promise.then(() => ({ kind: "tick" as const })),
      ]);
      tick.cancel();
      if (next.kind === "exited") return onExit(next.ended);
      if (next.kind === "requested") {
        if (next.request === "shutdown") {
          await this.#stopGracefully(child, connection, exited);
          return { kind: "shutdown" };
        }
        await this.#kill(child, exited);
        connection.close("The runtime was restarted");
        return { kind: "restart_requested" };
      }
      try {
        await connection.call("runtime.ping", {}, this.#timings.pingTimeout);
        missed = 0;
        this.#setStatus("ready");
      } catch {
        // The pipe closed while the ping was out: the exit branch reports it next time round.
        if (connection.closed) continue;
        missed += 1;
        if (missed >= this.#timings.missedPingsRestart) {
          await this.#kill(child, exited);
          connection.close("The runtime stopped answering");
          return {
            kind: "crashed",
            detail: `The runtime stopped answering (${missed} health checks missed)`,
          };
        }
        if (missed >= this.#timings.missedPingsDegraded) {
          this.#setStatus("degraded", `${missed} health checks missed`);
        }
      }
    }
  }

  async #stopGracefully(
    child: ChildProcessWithoutNullStreams,
    connection: RuntimeConnection,
    exited: Promise<Ended>,
  ): Promise<void> {
    try {
      await connection.call("runtime.shutdown", {}, this.#timings.shutdownReply);
    } catch {
      // Not answering is handled by the exit wait below.
    }
    const wait = sleep(this.#timings.shutdownExit);
    const outcome = await Promise.race([exited.then(() => "exited" as const), wait.promise]);
    wait.cancel();
    if (outcome !== "exited") {
      this.#options.log(
        "warn",
        `the runtime did not exit within ${this.#timings.shutdownExit / 1000} s of shutdown; killing it`,
      );
      await this.#kill(child, exited);
    }
    connection.close("The runtime shut down");
  }

  /** Kills the runtime and everything it started, and waits (up to 2 s) for it to exit. */
  async #kill(child: ChildProcessWithoutNullStreams, exited: Promise<Ended>): Promise<void> {
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32" && child.pid !== undefined) {
        // No Job Object any more (ADR-0015): taskkill /T takes the runtime's children too.
        execFile("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true }, () =>
          child.kill(),
        );
      } else {
        child.kill("SIGKILL");
      }
    }
    const wait = sleep(2_000);
    await Promise.race([exited, wait.promise]);
    wait.cancel();
  }

  #forwardStderr(child: ChildProcessWithoutNullStreams): void {
    let buffer = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, Math.min(newline, MAX_STDERR_LINE_CHARS));
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== "") this.#options.onRuntimeLog?.(line);
      }
      if (buffer.length > MAX_STDERR_LINE_CHARS) {
        this.#options.onRuntimeLog?.(buffer.slice(0, MAX_STDERR_LINE_CHARS));
        buffer = "";
      }
    });
  }
}

function sleep(ms: number): { promise: Promise<void>; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
