// Startup benchmark (NFR-001, NFR-002; TESTING_STRATEGY.md section 2, "Performance").
//
// Launches a built Host several times with fresh data, config and log folders, reads the
// Host's own timing lines from host.jsonl, closes the window as a user would, and checks
// the medians against the budgets: Workbench interactive under 3 s after the Host starts,
// runtime `initialize` answered within 2 s of spawn.
//
//   node scripts/bench-startup.mjs [--runs 5] [--build release|debug]
//
// The first launch after a build pays for cold disk caches; the report shows every run.
// Windows only for now (closing the window uses CloseMainWindow).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("bench-startup runs on Windows only for now");

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const runs = Number(arg("--runs", "5"));
const build = arg("--build", "release");
const BUDGET_INTERACTIVE_MS = 3000;
const BUDGET_INITIALIZE_MS = 2000;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe = join(root, "apps", "desktop", "src-tauri", "target", build, "jesutobits-desktop.exe");
if (!existsSync(exe)) throw new Error(`${exe} is missing; build it first`);

const results = [];
for (let run = 1; run <= runs; run += 1) {
  const base = mkdtempSync(join(tmpdir(), "jesutobits-bench-"));
  const logs = join(base, "logs");
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      JESUTOBITS_DATA_DIR: join(base, "data"),
      JESUTOBITS_CONFIG_DIR: join(base, "config"),
      JESUTOBITS_LOG_DIR: logs,
    },
    stdio: "ignore",
  });
  const timings = await waitForTimings(join(logs, "host.jsonl"), 30_000);
  close(child.pid);
  await new Promise((resolve) => child.on("exit", resolve));
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  results.push(timings);
  process.stdout.write(
    `run ${run}: workbench interactive ${timings.interactive} ms, runtime initialize ${timings.initialize} ms\n`,
  );
}

const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const interactive = median(results.map((r) => r.interactive));
const initialize = median(results.map((r) => r.initialize));
const ok = interactive < BUDGET_INTERACTIVE_MS && initialize < BUDGET_INITIALIZE_MS;
process.stdout.write(
  `${JSON.stringify({ build, runs, medianInteractiveMs: interactive, medianInitializeMs: initialize, budgetInteractiveMs: BUDGET_INTERACTIVE_MS, budgetInitializeMs: BUDGET_INITIALIZE_MS, ok })}\n`,
);
process.exit(ok ? 0 : 1);

/** Polls the Host log until both startup lines are there. */
async function waitForTimings(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      // Not written yet.
    }
    const interactive = /workbench interactive (\d+) ms after Host start/.exec(text)?.[1];
    // From spawn to the handshake answered, as the Host measures it.
    const initialize = /runtime ready in (\d+) ms/.exec(text)?.[1];
    if (interactive && initialize) {
      return { interactive: Number(interactive), initialize: Number(initialize) };
    }
    if (Date.now() > deadline) throw new Error(`no startup timing in ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Closes the window the way a user does, so the Host shuts the runtime down cleanly. */
function close(pid) {
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() }`,
  ]);
}
