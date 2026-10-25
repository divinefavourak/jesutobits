// `pnpm dev:web [--runtime] [vite options]`: the Workbench in a normal browser
// (DEVELOPMENT_SETUP.md section 3). Without --runtime it runs against MockHostBridge alone;
// with --runtime it also starts scripts/dev-relay.mjs and points the Workbench at it, so
// projects and files are real. Other arguments go to Vite, for example `--port 1440` (E2E).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startRelay } from "./dev-relay.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps", "desktop");
// Vite's exports do not include its bin, but they do include package.json.
const vitePackage = createRequire(join(desktop, "package.json")).resolve("vite/package.json");
const vite = join(dirname(vitePackage), JSON.parse(readFileSync(vitePackage, "utf8")).bin.vite);

const env = { ...process.env };
let relay;
if (process.argv.includes("--runtime")) {
  relay = await startRelay();
  env.VITE_JESUTOBITS_RELAY = `${relay.url}#${relay.token}`;
  process.stdout.write(`dev relay: ${relay.url} (runtime ready)\n`);
}

const viteArgs = process.argv.slice(2).filter((arg) => arg !== "--runtime");
const child = spawn(process.execPath, [vite, ...viteArgs], { cwd: desktop, env, stdio: "inherit" });
const stop = async (code) => {
  await relay?.close();
  process.exit(code ?? 0);
};
child.on("exit", (code) => void stop(code));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
