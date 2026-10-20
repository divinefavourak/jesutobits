// Runtime process entry. Stdout carries the protocol, so nothing else may write to it
// (ADR-0003); log lines go to stderr, which the Host writes to runtime.jsonl.
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { parseLogLevel } from "@jesutobits/shared";
import { createLogger } from "./log/logger.js";
import { SecretRegistry } from "./log/secret-registry.js";
import { createRuntime } from "./runtime.js";

// In the bundle, every imported module has evaluated by the time this line runs.
const mainStartMs = performance.now();

// The Host passes `--stdio --data-dir <dir>` (ADR-0002); unknown arguments are ignored.
const { values: args } = parseArgs({
  options: { stdio: { type: "boolean" }, "data-dir": { type: "string" } },
  strict: false,
});

const secrets = new SecretRegistry();
const log = createLogger({
  write: (line) => process.stderr.write(`${line}\n`),
  level: parseLogLevel(process.env.JESUTOBITS_RUNTIME_LOG),
  secrets,
});

const runtime = createRuntime({
  write: (line) =>
    new Promise<void>((resolve, reject) => {
      process.stdout.write(line, (error) => (error ? reject(error) : resolve()));
    }),
  log,
  dataDir: typeof args["data-dir"] === "string" ? args["data-dir"] : undefined,
  exit: (code) => process.exit(code),
  uptimeMs: () => performance.now(),
  startupMarks: () => ({
    nodeBootstrapMs: performance.nodeTiming.bootstrapComplete,
    mainStartMs,
  }),
});

process.stdin.on("data", (chunk: Buffer) => runtime.receive(chunk));
process.stdin.on("end", () => runtime.endOfInput());
