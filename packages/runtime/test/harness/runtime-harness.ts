// RuntimeHarness (TESTING_STRATEGY.md section 3.2): spawns the bundled runtime with Node and
// talks NDJSON JSON-RPC over pipes, exactly as the Host does (ADR-0003).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, type MethodName, type MethodParams } from "@jesutobits/protocol";

const ENTRY = fileURLToPath(new URL("../../dist/bundle/runtime.mjs", import.meta.url));

export interface RpcReply {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: { code: string } };
}

export interface HarnessOptions {
  /** Passed as `--data-dir`, as the Host does. */
  dataDir?: string;
}

export class RuntimeHarness {
  readonly stderr: string[] = [];
  /** `event` notifications received, in order (runtime events, ADR-0003). */
  readonly events: Array<Record<string, unknown>> = [];
  /** Reverse calls the runtime made, in order; the harness answers them like the Host. */
  readonly reverseCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  /** Set to make the next reverse calls fail with this message. */
  failReverseCalls: string | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, (reply: RpcReply) => void>();
  private buffer = "";
  private nextId = 1;
  readonly exited: Promise<number | null>;

  private constructor(options: HarnessOptions) {
    const args = options.dataDir === undefined ? [] : ["--data-dir", options.dataDir];
    this.child = spawn(process.execPath, [ENTRY, "--stdio", ...args], { stdio: "pipe" });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
    this.exited = new Promise((resolve) => this.child.on("exit", (code) => resolve(code)));
  }

  /** Without `dataDir` the runtime keeps its database in memory. */
  static start(options: HarnessOptions = {}): RuntimeHarness {
    return new RuntimeHarness(options);
  }

  call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<RpcReply> {
    const id = `t-${this.nextId++}`;
    const reply = new Promise<RpcReply>((resolve) => this.pending.set(id, resolve));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return reply;
  }

  initialize(): Promise<RpcReply> {
    return this.call("runtime.initialize", {
      protocolVersion: PROTOCOL_VERSION,
      client: { name: "runtime-harness", version: "0.0.0" },
    });
  }

  /** Writes one line as is, for malformed or unusual input. */
  sendRaw(line: string): void {
    this.child.stdin.write(`${line}\n`);
  }

  /** Stderr split into lines, each parsed as a JSON log line (ARCHITECTURE.md section 10). */
  logLines(): Array<Record<string, unknown>> {
    return this.stderr
      .join("")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /** Closes stdin, as happens when the Host dies. */
  closeStdin(): void {
    this.child.stdin.end();
  }

  kill(): void {
    this.child.kill();
  }

  /**
   * Plays the Host's part: `host.fs.trash` deletes the path (no real trash in tests) and
   * `host.os.reveal` only records the call.
   */
  private answerReverseCall(
    id: RpcReply["id"],
    method: string,
    params: Record<string, unknown>,
  ): void {
    this.reverseCalls.push({ method, params });
    const reply = (body: Record<string, unknown>) =>
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
    if (this.failReverseCalls) {
      reply({
        error: {
          code: -32000,
          message: this.failReverseCalls,
          data: { code: "fs.trash_failed", message: this.failReverseCalls, retryable: false },
        },
      });
    } else if (method === "host.fs.trash") {
      rmSync(String(params.path), { recursive: true, force: true });
      reply({ result: {} });
    } else if (method === "host.os.reveal") {
      reply({ result: {} });
    } else {
      reply({
        error: {
          code: -32601,
          message: `no ${method}`,
          data: { code: "rpc.method_not_found", message: `no ${method}`, retryable: false },
        },
      });
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      // Anything on stdout that is not a JSON-RPC message is a protocol violation.
      const message = JSON.parse(line) as RpcReply & { method?: string; params?: unknown };
      if (message.method === "event" && message.id === undefined) {
        this.events.push(message.params as Record<string, unknown>);
        continue;
      }
      if (message.method !== undefined && message.id !== undefined) {
        this.answerReverseCall(
          message.id,
          message.method,
          message.params as Record<string, unknown>,
        );
        continue;
      }
      const reply = message;
      const resolve = this.pending.get(String(reply.id));
      if (!resolve) throw new Error(`Unexpected message on stdout: ${line}`);
      this.pending.delete(String(reply.id));
      resolve(reply);
    }
  }
}
