// Stand-in runtime for Host lifecycle tests (Spike S1, TESTING_STRATEGY.md section 3.2).
//
// Answers the handshake like the real runtime, then deliberately behaves badly so only the
// Host's job object can clean up: it starts a long-lived grandchild and ignores EOF on
// stdin. It writes {"runtime": pid, "grandchild": pid} to <data-dir>/fake-runtime-pids.json
// once both are running.
//
// Used through the debug-only JESUTOBITS_RUNTIME_ENTRY override. Plain JavaScript with no
// imports beyond Node built-ins, so it runs without a build.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const dataDirIndex = process.argv.indexOf("--data-dir");
const dataDir = dataDirIndex === -1 ? process.cwd() : process.argv[dataDirIndex + 1];

const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const result =
      message.method === "runtime.initialize"
        ? { protocolVersion: message.params.protocolVersion, runtimeVersion: "fake", nodeVersion: process.version }
        : message.method === "runtime.ping"
          ? { uptimeMs: performance.now() }
          : {};
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
    if (message.method === "runtime.initialize") {
      writeFileSync(
        join(dataDir, "fake-runtime-pids.json"),
        JSON.stringify({ runtime: process.pid, grandchild: grandchild.pid }),
      );
    }
  }
});
// Ignore EOF and shutdown: stay alive until killed.
process.stdin.on("end", () => {});
setInterval(() => {}, 1000);
