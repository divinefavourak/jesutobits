// Runtime process entry. Stdout carries the protocol, so nothing else may write to it
// (ADR-0003); diagnostics go to stderr, which the Host writes to the runtime log.
import { performance } from "node:perf_hooks";
import { createRuntime } from "./runtime.js";

// In the bundle, every imported module has evaluated by the time this line runs.
const mainStartMs = performance.now();

const runtime = createRuntime({
  write: (line) =>
    new Promise<void>((resolve, reject) => {
      process.stdout.write(line, (error) => (error ? reject(error) : resolve()));
    }),
  diagnostic: (message) => {
    process.stderr.write(`${message}\n`);
  },
  exit: (code) => process.exit(code),
  uptimeMs: () => performance.now(),
  startupMarks: () => ({
    nodeBootstrapMs: performance.nodeTiming.bootstrapComplete,
    mainStartMs,
  }),
});

process.stdin.on("data", (chunk: Buffer) => runtime.receive(chunk));
process.stdin.on("end", () => runtime.endOfInput());
