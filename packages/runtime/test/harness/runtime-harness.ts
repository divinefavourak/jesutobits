// RuntimeHarness (TESTING_STRATEGY.md section 3.2): spawns the bundled runtime with Node and
// talks NDJSON JSON-RPC over pipes, exactly as the Host does (ADR-0003).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, type MethodName, type MethodParams } from "@jesutobits/protocol";

const ENTRY = fileURLToPath(new URL("../../dist/bundle/runtime.mjs", import.meta.url));

export interface RpcReply {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: { code: string } };
}

export class RuntimeHarness {
  readonly stderr: string[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, (reply: RpcReply) => void>();
  private buffer = "";
  private nextId = 1;
  readonly exited: Promise<number | null>;

  private constructor() {
    this.child = spawn(process.execPath, [ENTRY], { stdio: "pipe" });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
    this.exited = new Promise((resolve) => this.child.on("exit", (code) => resolve(code)));
  }

  static start(): RuntimeHarness {
    return new RuntimeHarness();
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

  /** Closes stdin, as happens when the Host dies. */
  closeStdin(): void {
    this.child.stdin.end();
  }

  kill(): void {
    this.child.kill();
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      // Anything on stdout that is not a JSON-RPC message is a protocol violation.
      const reply = JSON.parse(line) as RpcReply;
      const resolve = this.pending.get(String(reply.id));
      if (!resolve) throw new Error(`Unexpected message on stdout: ${line}`);
      this.pending.delete(String(reply.id));
      resolve(reply);
    }
  }
}
