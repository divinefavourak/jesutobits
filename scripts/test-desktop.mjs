// `pnpm test:desktop`: the real desktop app through tauri-driver and WebdriverIO
// (TESTING_STRATEGY.md section 2, "Desktop integration"; nightly on Windows and Linux).
//
// Needs, once: `cargo install tauri-driver --locked`, and on Linux webkit2gtk-driver and a
// display (xvfb-run). Needs, per change: `pnpm build:desktop-test` (a debug Host with the
// Workbench built in, so no dev server runs). Each run gets fresh data, config and log
// folders, so it starts as a first run and never touches the user's own.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchWebDriver } from "./fetch-webdriver.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4444;
const app = join(
  root,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "debug",
  process.platform === "win32" ? "jesutobits-desktop.exe" : "jesutobits-desktop",
);
if (!existsSync(app)) {
  throw new Error(`${app} is missing; run pnpm build:desktop-test first`);
}

const nativeDriver = await fetchWebDriver();
const base = realpathSync.native(mkdtempSync(join(tmpdir(), "jesutobits-desktop-")));
const env = {
  ...process.env,
  JESUTOBITS_DATA_DIR: join(base, "data"),
  JESUTOBITS_CONFIG_DIR: join(base, "config"),
  JESUTOBITS_LOG_DIR: join(base, "logs"),
  JESUTOBITS_DESKTOP_APP: app,
  JESUTOBITS_DESKTOP_BASE: base,
  JESUTOBITS_WEBDRIVER_PORT: String(PORT),
};

const driver = spawn(
  process.env.TAURI_DRIVER ?? "tauri-driver",
  ["--port", String(PORT), "--native-driver", nativeDriver],
  { env, stdio: ["ignore", "inherit", "inherit"] },
);
const exited = (child) => new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
const driverExit = exited(driver);

let code = 1;
try {
  await waitForPort(PORT, 20_000);
  const tests = spawn(
    process.execPath,
    ["--test", "--test-reporter=spec", "--test-concurrency=1", "apps/desktop/desktop-tests/"],
    { cwd: root, env, stdio: "inherit" },
  );
  code = await exited(tests);
} finally {
  driver.kill();
  await Promise.race([driverExit, new Promise((resolve) => setTimeout(resolve, 5000))]);
  // On failure the logs stay for the report (the nightly uploads them).
  if (code === 0) rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  else process.stdout.write(`desktop test data and logs kept in ${base}\n`);
}
process.exit(code);

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    if (Date.now() > deadline) throw new Error(`tauri-driver did not listen on ${port}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
