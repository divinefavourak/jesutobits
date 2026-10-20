// Spike S1: no orphan processes after the Host is force-killed (ROADMAP Phase 0, NFR-010).
//
// Each trial starts the debug Host with fixtures/bin/fake-runtime.mjs, which starts a
// grandchild and ignores stdin EOF, so only the job object can clean up. The Host is then
// killed with TerminateProcess (`taskkill /F`, what Task Manager's End task does), and the
// runtime and grandchild must be gone within the deadline.
//
//   node scripts/spikes/s1-orphans.mjs [--trials 10] [--control]
//
// --control disables the job object (debug builds only) and expects survivors, which shows
// the test can see an orphan at all. Survivors are killed afterwards either way.
// Windows only. Needs `cargo build` in apps/desktop/src-tauri and `pnpm fetch:sidecars`.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("This spike runs on Windows only");

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hostExe = join(
  root,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "debug",
  "jesutobits-desktop.exe",
);
const fakeRuntime = join(root, "fixtures", "bin", "fake-runtime.mjs");

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const trials = Number(arg("--trials", "10"));
const control = process.argv.includes("--control");
const DEATH_DEADLINE_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const forceKill = (pid) => {
  try {
    execFileSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
  } catch {
    // Already gone.
  }
};

async function waitFor(check, timeoutMs, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await sleep(intervalMs);
  }
}

async function trial(number) {
  const dataDir = mkdtempSync(join(tmpdir(), "jesutobits-s1-"));
  const env = {
    ...process.env,
    JESUTOBITS_RUNTIME_ENTRY: fakeRuntime,
    JESUTOBITS_DATA_DIR: dataDir,
  };
  if (control) env.JESUTOBITS_DISABLE_JOB_OBJECT = "1";
  const host = spawn(hostExe, [], { env, stdio: "ignore" });

  try {
    const pids = await waitFor(() => {
      try {
        return JSON.parse(readFileSync(join(dataDir, "fake-runtime-pids.json"), "utf8"));
      } catch {
        return undefined;
      }
    }, 30_000);
    if (!pids) throw new Error("the fake runtime never reported its pids");
    if (!isAlive(pids.runtime) || !isAlive(pids.grandchild)) throw new Error("tree not running");

    const killedAt = performance.now();
    forceKill(host.pid);
    const runtimeGone = await waitFor(() => !isAlive(pids.runtime), DEATH_DEADLINE_MS, 10);
    const runtimeMs = performance.now() - killedAt;
    const grandchildGone = await waitFor(() => !isAlive(pids.grandchild), DEATH_DEADLINE_MS, 10);
    const totalMs = performance.now() - killedAt;

    const survivors = [
      ...(runtimeGone ? [] : [`runtime ${pids.runtime}`]),
      ...(grandchildGone ? [] : [`grandchild ${pids.grandchild}`]),
    ];
    for (const pid of [pids.runtime, pids.grandchild]) forceKill(pid);
    return {
      trial: number,
      survivors,
      runtimeMs: Math.round(runtimeMs),
      allGoneMs: Math.round(totalMs),
    };
  } finally {
    forceKill(host.pid);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const results = [];
for (let i = 1; i <= trials; i++) {
  const result = await trial(i);
  results.push(result);
  process.stdout.write(
    `trial ${i}: ${result.survivors.length ? `SURVIVORS ${result.survivors.join(", ")}` : `clean, tree gone in ${result.allGoneMs} ms`}\n`,
  );
}

const orphaned = results.filter((r) => r.survivors.length > 0).length;
process.stdout.write(
  `${JSON.stringify({ mode: control ? "control (job object disabled)" : "job object", trials, orphaned })}\n`,
);
// Normal mode passes with zero orphans; control mode passes when every trial orphaned.
process.exit(control ? (orphaned === trials ? 0 : 1) : orphaned === 0 ? 0 : 1);
