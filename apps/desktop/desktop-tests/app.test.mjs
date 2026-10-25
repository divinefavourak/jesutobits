// Desktop integration (TESTING_STRATEGY.md section 2): the real Host, runtime and webview,
// driven through tauri-driver. Run with `pnpm test:desktop` (scripts/test-desktop.mjs sets
// the app path and fresh data folders). One app session; the tests run in order.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { remote } from "webdriverio";

const base = process.env.JESUTOBITS_DESKTOP_BASE;
const dataDir = process.env.JESUTOBITS_DATA_DIR;
let browser;

before(async () => {
  browser = await remote({
    hostname: "127.0.0.1",
    port: Number(process.env.JESUTOBITS_WEBDRIVER_PORT ?? 4444),
    logLevel: "warn",
    capabilities: { "tauri:options": { application: process.env.JESUTOBITS_DESKTOP_APP } },
  });
});

after(async () => {
  await browser?.deleteSession();
});

/** The status bar's runtime status text. */
const runtimeStatus = () => browser.$("footer [role=status]").getText();

/** PIDs of this run's runtime processes, found by the data folder on their command line. */
function runtimePids() {
  if (process.platform === "win32") {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='jesutobits-node.exe'\" | " +
          `Where-Object { $_.CommandLine -like '*${dataDir}*' } | ForEach-Object { $_.ProcessId }`,
      ],
      { encoding: "utf8" },
    );
    return out.split(/\s+/).filter(Boolean).map(Number);
  }
  try {
    const out = execFileSync("pgrep", ["-f", "--", `--data-dir ${dataDir}`], { encoding: "utf8" });
    return out.split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function killProcess(pid) {
  if (process.platform === "win32") execFileSync("taskkill", ["/F", "/PID", String(pid)]);
  else process.kill(pid, "SIGKILL");
}

test("a first run starts in onboarding with the runtime ready (J-01, NFR-001)", async () => {
  const welcome = await browser.$("h1=Welcome to Jesutobits");
  await welcome.waitForDisplayed({ timeout: 20_000 });
  await browser.waitUntil(async () => (await runtimeStatus()) === "Ready", {
    timeout: 20_000,
    timeoutMsg: "the runtime never reported Ready",
  });

  // The Host logs how long the cold start took; debug builds are slower than the 3 s
  // budget, which is measured on a release build (Phase 1 acceptance).
  const log = readFileSync(join(base, "logs", "host.jsonl"), "utf8");
  const interactive = /workbench interactive (\d+) ms after Host start/.exec(log);
  assert.ok(interactive, "the Host logged the startup timing");
  process.stdout.write(`# workbench interactive ${interactive[1]} ms (debug build)\n`);
});

test("the Host relays only Workbench methods (NFR-008, ADR-0003)", async () => {
  const outcome = await browser.execute(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke("rpc_call", {
        method: "runtime.shutdown",
        params: {},
      });
      return "allowed";
    } catch (error) {
      return JSON.stringify(error);
    }
  });
  assert.match(outcome, /rpc\.method_not_allowed/);
  // And the runtime is still there.
  assert.equal(await runtimeStatus(), "Ready");
});

test("a crashed runtime restarts and the Workbench recovers (NFR-009)", async () => {
  const before = runtimePids();
  assert.equal(before.length, 1, `one runtime for this run, found ${before.join(", ")}`);
  killProcess(before[0]);

  await browser.waitUntil(
    async () => {
      const now = runtimePids();
      return now.length === 1 && now[0] !== before[0] && (await runtimeStatus()) === "Ready";
    },
    { timeout: 30_000, interval: 250, timeoutMsg: "the runtime did not come back Ready" },
  );
  const log = readFileSync(join(base, "logs", "host.jsonl"), "utf8");
  assert.match(log, /stopped unexpectedly/);
});

test("closing the window leaves no runtime behind (NFR-010)", async () => {
  await browser.deleteSession();
  browser = undefined;
  const deadline = Date.now() + 10_000;
  while (runtimePids().length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.deepEqual(runtimePids(), []);
});
