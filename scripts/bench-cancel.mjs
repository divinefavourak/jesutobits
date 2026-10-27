// Phase 2 acceptance (NFR-025): a cancelled turn reaches `cancelled` within 2 s in at least
// 99 of 100 scripted runs. Drives the built runtime over stdio like the Host: each run sends
// a message, waits for the first text delta of a stream that then stalls, cancels, and times
// how long `turn.cancelled` takes. Half the runs cancel while a tool waits for approval.
// Usage: node scripts/bench-cancel.mjs [--runs 100]   (after `pnpm build:packages`)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "packages", "runtime", "dist", "bundle", "runtime.mjs");
const runsFlag = process.argv.indexOf("--runs");
const runs = runsFlag === -1 ? 100 : Number(process.argv[runsFlag + 1]);
const LIMIT_MS = 2000;

const work = realpathSync.native(mkdtempSync(join(tmpdir(), "jesutobits-bench-cancel-")));
const project = join(work, "project");
mkdirSync(project);
writeFileSync(join(project, "a.txt"), "hello\n");

// Odd requests stream text and stall; even ones ask to delete a file (always an approval).
const lines = [];
for (let i = 0; i < runs; i++) {
  const events =
    i % 2 === 0
      ? [
          { type: "text_delta", text: "Working on it" },
          { type: "stall", ms: 60_000 },
          { type: "finish", reason: "stop" },
        ]
      : [
          { type: "text_delta", text: "Deleting" },
          { type: "tool_call_start", callId: `c${i}`, name: "delete_path" },
          { type: "tool_call_args_delta", callId: `c${i}`, delta: '{"path":"a.txt"}' },
          { type: "tool_call_end", callId: `c${i}` },
          { type: "finish", reason: "tool_calls" },
        ];
  lines.push(JSON.stringify({ step: i, events }));
}
const cassette = join(work, "cancel.jsonl");
writeFileSync(cassette, `${lines.join("\n")}\n`);

const child = spawn(process.execPath, [bundle, "--stdio"], {
  env: { ...process.env, JESUTOBITS_PROVIDER: "scripted", JESUTOBITS_CASSETTE: cassette },
  stdio: ["pipe", "pipe", "ignore"],
});
const pending = new Map();
const waiters = [];
let buffer = "";
let nextId = 1;
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.method === "event") {
      for (const waiter of [...waiters]) {
        if (waiter.match(message.params)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message.params);
        }
      }
    } else if (message.method) {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { value: null } })}\n`,
      );
    } else {
      pending.get(message.id)?.(message);
    }
  }
});
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (reply) =>
      reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result),
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
const waitFor = (match) => new Promise((resolve) => waiters.push({ match, resolve }));

await call("runtime.initialize", {
  protocolVersion: "0.1.0",
  client: { name: "bench-cancel", version: "0" },
});
const { project: opened } = await call("projects.open", { path: project });
await call("projects.setTrust", { id: opened.id, trust: "trusted" });
const { session } = await call("sessions.create", {});

const times = [];
for (let i = 0; i < runs; i++) {
  const sent = waitFor((event) => event.type === "turn.started");
  const { turnId } = await call("agent.sendMessage", {
    sessionId: session.id,
    text: `run ${i}`,
    mode: "agent",
  });
  await sent;
  // Cancel at the moment the turn is visibly busy: streaming, or waiting for approval.
  await waitFor(
    (event) =>
      event.turnId === turnId &&
      (event.type === "model.text_delta" || event.type === "permission.requested") &&
      (i % 2 === 0 ? event.type === "model.text_delta" : event.type === "permission.requested"),
  );
  const cancelled = waitFor((event) => event.turnId === turnId && event.type === "turn.cancelled");
  const started = performance.now();
  await call("agent.cancelTurn", { turnId });
  await cancelled;
  times.push(performance.now() - started);
}

child.stdin.end();
rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

const sorted = [...times].sort((a, b) => a - b);
const within = times.filter((ms) => ms < LIMIT_MS).length;
const pct = (p) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))].toFixed(1);
process.stdout.write(
  `cancel to cancelled over ${runs} runs: p50 ${pct(50)} ms, p95 ${pct(95)} ms, p99 ${pct(99)} ms, max ${sorted.at(-1).toFixed(1)} ms; ${within}/${runs} under ${LIMIT_MS} ms\n`,
);
process.exit(within >= Math.ceil(runs * 0.99) ? 0 : 1);
