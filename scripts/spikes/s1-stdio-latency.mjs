// Spike S1 baseline: round-trip latency of `runtime.ping` straight over stdio to the bundled
// runtime, with no Host or webview in between. Subtracting this from the Workbench
// measurement isolates what the Host relay and webview IPC add (NFR-006).
//
//   node scripts/spikes/s1-stdio-latency.mjs [--samples 1000]
// Needs `pnpm build:runtime`.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(root, "packages", "runtime", "dist", "bundle", "runtime.mjs");
const samplesIndex = process.argv.indexOf("--samples");
const SAMPLES = samplesIndex === -1 ? 1000 : Number(process.argv[samplesIndex + 1]);

const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "inherit"] });
child.stdout.setEncoding("utf8");
let buffer = "";
const waiting = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const reply = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    waiting.get(reply.id)?.(reply);
    waiting.delete(reply.id);
  }
});

let nextId = 1;
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1];

await call("runtime.initialize", {
  protocolVersion: "0.1.0",
  client: { name: "s1", version: "0" },
});
const results = [];
for (const bytes of [16, 1024, 65_536]) {
  const echo = "x".repeat(bytes);
  for (let i = 0; i < 50; i++) await call("runtime.ping", { echo });
  const durations = [];
  for (let i = 0; i < SAMPLES; i++) {
    const start = performance.now();
    await call("runtime.ping", { echo });
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  const round = (ms) => Number(ms.toFixed(3));
  results.push({
    bytes,
    samples: SAMPLES,
    p50: round(percentile(durations, 50)),
    p95: round(percentile(durations, 95)),
    p99: round(percentile(durations, 99)),
    max: round(durations[durations.length - 1]),
  });
}
child.stdin.end();
process.stdout.write(`${JSON.stringify({ path: "direct stdio (no Host)", results })}\n`);
