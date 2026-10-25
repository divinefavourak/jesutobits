// Stand-in runtime for Host lifecycle tests (Spike S1, TESTING_STRATEGY.md section 3.2).
//
// Answers the handshake like the real runtime. By default it then deliberately behaves
// badly so only the Host's job object can clean up: it starts a long-lived grandchild and
// ignores EOF on stdin and `runtime.shutdown`. It writes {"runtime": pid, "grandchild": pid}
// to <data-dir>/fake-runtime-pids.json once both are running (scripts/spikes/s1-orphans.mjs).
//
// Flags for the supervisor's restart tests (apps/desktop/src-tauri/src/runtime_supervisor):
//   --cooperative           no grandchild; exit 0 on stdin EOF and on runtime.shutdown
//   --crash-at-init <n>     exit 3 before answering anything, on the first n starts
//   --crash-after-ready <n> exit 4 shortly after the handshake, on the first n starts
//   --ignore-pings          never answer runtime.ping
//   --silent                never answer anything (handshake timeout)
//   --protocol <version>    answer initialize with this protocol version
// Starts are counted in <data-dir>/fake-runtime-starts, so the counts span restarts.
//
// Used through the debug-only JESUTOBITS_RUNTIME_ENTRY override, or spawned directly by
// tests. Plain JavaScript with no imports beyond Node built-ins, so it runs without a build.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const flag = (name) => process.argv.includes(name);
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const dataDir = option("--data-dir") ?? process.cwd();
const cooperative = flag("--cooperative");

const startsFile = join(dataDir, "fake-runtime-starts");
let starts = 0;
try {
  starts = Number(readFileSync(startsFile, "utf8")) || 0;
} catch {
  // First start.
}
starts += 1;
writeFileSync(startsFile, String(starts));

if (starts <= Number(option("--crash-at-init") ?? 0)) {
  process.stderr.write(`fake runtime: crashing at init (start ${starts})\n`);
  process.exit(3);
}
const crashAfterReady = starts <= Number(option("--crash-after-ready") ?? 0);

const grandchild = cooperative
  ? undefined
  : spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });

const reply = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.id === undefined || flag("--silent")) continue;
    switch (message.method) {
      case "runtime.initialize":
        reply(message.id, {
          protocolVersion: option("--protocol") ?? message.params.protocolVersion,
          runtimeVersion: "fake",
          nodeVersion: process.version,
        });
        if (grandchild) {
          writeFileSync(
            join(dataDir, "fake-runtime-pids.json"),
            JSON.stringify({ runtime: process.pid, grandchild: grandchild.pid }),
          );
        }
        if (crashAfterReady) setTimeout(() => process.exit(4), 50);
        break;
      case "runtime.ping":
        if (!flag("--ignore-pings")) reply(message.id, { uptimeMs: performance.now() });
        break;
      case "runtime.shutdown":
        reply(message.id, {});
        if (cooperative) setTimeout(() => process.exit(0), 10);
        break;
      default:
        reply(message.id, {});
    }
  }
});
process.stdin.on("end", () => {
  if (cooperative) process.exit(0);
  // Otherwise ignore EOF and stay alive until killed.
});
setInterval(() => {}, 1000);
