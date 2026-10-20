// Spike S3: the preview iframe inside the Tauri Workbench (ROADMAP Phase 0, ADR-0010).
//
// Serves a deliberately hostile "preview" on http://127.0.0.1:5899 and launches the Host
// with the Workbench's PreviewFrameProbe pointed at it. The preview page:
//   - sends a valid bridge.hello, one with a wrong nonce and one that fails the schema;
//   - embeds forger frames from http://127.0.0.1:5898 and http://localhost:5899 that post
//     a hello with the *correct* nonce straight to window.top;
//   - tries every Tauri IPC path it can reach, each trying to log a canary string through
//     the `workbench_log` command; if the canary ever reaches the Host's log, IPC leaked;
//   - tries to read the Workbench DOM and to navigate the Workbench away.
// Pass means: one hello accepted, every forgery rejected, inspect.set delivered with the
// exact origin, no canary in the Host log, no top navigation, no DOM access either way.
//
//   node scripts/spikes/s3-run.mjs --dev                  dev Workbench (Vite on 127.0.0.1:1420)
//   node scripts/spikes/s3-run.mjs --label <name>         a Host built with the probe URL baked in:
//     VITE_JESUTOBITS_PREVIEW_PROBE=http://127.0.0.1:5899/ pnpm --filter @jesutobits/desktop tauri build --debug --no-bundle
// Windows only for now (WebKitGTK and WKWebView runs are open; docs/spikes/S3.md).
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const DEV = process.argv.includes("--dev");
const LABEL = arg("--label", DEV ? "dev" : "build");
const HOST_EXE = arg(
  "--exe",
  join(root, "apps", "desktop", "src-tauri", "target", "debug", "jesutobits-desktop.exe"),
);
const PREVIEW_PORT = 5899;
const FORGER_PORT = 5898;
const PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}/`;
const CANARY = "S3-CANARY";

const previewPage = `<!doctype html><meta charset="utf-8"><title>S3 preview</title>
<p>Hostile preview for Spike S3.</p>
<script type="module">
const q = new URLSearchParams(location.search);
const parentOrigin = q.get("parent");
const nonce = q.get("nonce");
const report = (kind, data) => fetch("/report", { method: "POST", body: JSON.stringify({ kind, ...data }) });

addEventListener("message", (e) => report("received", {
  origin: e.origin, type: e.data?.type, nonceOk: e.data?.nonce === nonce, fromParentOrigin: e.origin === parentOrigin,
}));

const hello = (n, extra) => ({ jesutobits: 1, type: "bridge.hello", nonce: n, ...extra });
parent.postMessage(hello(nonce, { version: "s3-probe", url: location.href }), parentOrigin);
parent.postMessage(hello("f".repeat(32), { version: "s3-probe", url: location.href }), parentOrigin);
parent.postMessage(hello(nonce, {}), parentOrigin);

for (const forger of ["http://127.0.0.1:${FORGER_PORT}", "http://localhost:${PREVIEW_PORT}"]) {
  const f = document.createElement("iframe");
  f.src = forger + "/forger?nonce=" + nonce + "&parent=" + encodeURIComponent(parentOrigin)
    + "&report=" + encodeURIComponent(location.origin + "/report");
  document.body.append(f);
}

const results = {};
async function attempt(name, fn) {
  try { results[name] = { ok: true, value: String(await fn()).slice(0, 300) }; }
  catch (e) { results[name] = { ok: false, error: String(e?.message ?? e).slice(0, 300) }; }
  await report("attempt", { name, result: results[name] });
}
const log = (suffix) => ({ level: "info", message: "${CANARY}-" + suffix });
const ipcHeaders = { "Content-Type": "application/json", "Tauri-Callback": "1", "Tauri-Error": "2", "Tauri-Invoke-Key": "guess" };
await attempt("frameTauriInternals", () => typeof window.__TAURI_INTERNALS__);
await attempt("frameInvoke", () => window.__TAURI_INTERNALS__.invoke("workbench_log", log("frame-invoke")));
// Our own commands and the core:default plugin commands granted to the Workbench.
const commands = {
  rpcCall: ["rpc_call", { method: "runtime.ping", params: {} }],
  runtimeSubscribe: ["runtime_subscribe", {}],
  appVersion: ["plugin:app|version", {}],
  eventEmit: ["plugin:event|emit", { event: "${CANARY}", payload: "${CANARY}-emit" }],
  webviewPosition: ["plugin:webview|webview_position", { label: "main" }],
  pathResolve: ["plugin:path|resolve_directory", { directory: 1 }],
  // Window-affecting commands last, after everything else has been reported.
  windowTitle: ["plugin:window|set_title", { label: "main", value: "${CANARY}" }],
  windowMinimize: ["plugin:window|minimize", { label: "main" }],
};
for (const [name, [cmd, args]] of Object.entries(commands)) {
  await attempt("cmd:" + name, () => window.__TAURI_INTERNALS__.invoke(cmd, args));
}
await attempt("ipcFetchLog", async () => {
  const r = await fetch("http://ipc.localhost/workbench_log", { method: "POST", headers: ipcHeaders, body: JSON.stringify(log("ipc-fetch")) });
  return r.status + " " + (await r.text());
});
await attempt("ipcFetchRpc", async () => {
  const r = await fetch("http://ipc.localhost/rpc_call", { method: "POST", headers: ipcHeaders, body: JSON.stringify({ method: "runtime.ping", params: {} }) });
  return r.status + " " + (await r.text());
});
await attempt("ipcFetchNoCors", async () => {
  await fetch("http://ipc.localhost/workbench_log", { method: "POST", mode: "no-cors", body: JSON.stringify(log("ipc-no-cors")) });
  return "sent";
});
await attempt("chromeWebview", () => {
  if (!window.chrome?.webview) return "absent";
  window.chrome.webview.postMessage(JSON.stringify({ cmd: "workbench_log", callback: 1, error: 2, payload: log("webview") }));
  return "posted";
});
await attempt("parentDocument", () => window.parent.document.title);
await attempt("topTauriInternals", () => typeof window.top.__TAURI_INTERNALS__);
await attempt("topInvoke", () => window.top.__TAURI_INTERNALS__.invoke("workbench_log", log("top-invoke")));
report("ipc", { results });

setTimeout(async () => {
  await attempt("topNavigation", () => { window.top.location.href = location.origin + "/navigated"; return "assigned"; });
  report("navigation", { result: results.topNavigation });
}, 4000);
</script>`;

const forgerPage = `<!doctype html><meta charset="utf-8"><script type="module">
const q = new URLSearchParams(location.search);
top.postMessage({ jesutobits: 1, type: "bridge.hello", nonce: q.get("nonce"), version: "forged", url: location.href }, q.get("parent"));
fetch(q.get("report"), { method: "POST", mode: "no-cors", body: JSON.stringify({ kind: "forged", from: location.origin }) });
</script>`;

const navigatedPage = `<!doctype html><script>fetch("/report", { method: "POST", body: JSON.stringify({ kind: "top-navigated" }) });</script>`;

const reports = [];
function serve(port, routes) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = new URL(req.url, "http://x").pathname;
      if (path === "/report" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            reports.push(JSON.parse(body));
          } catch {
            reports.push({ kind: "unparseable", body });
          }
          res.end();
        });
        return;
      }
      const page = routes[path];
      res.writeHead(page ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      res.end(page ?? "not found");
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const servers = [
  await serve(PREVIEW_PORT, {
    "/": previewPage,
    "/forger": forgerPage,
    "/navigated": navigatedPage,
  }),
  await serve(FORGER_PORT, { "/forger": forgerPage }),
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const killTree = (pid) => {
  try {
    execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
  } catch {
    // Already gone.
  }
};

let vite;
if (DEV) {
  // Vite's JS entry with this Node: no pnpm on PATH needed, no shell.
  const desktop = join(root, "apps", "desktop");
  vite = spawn(process.execPath, [join(desktop, "node_modules", "vite", "bin", "vite.js")], {
    cwd: desktop,
    env: { ...process.env, VITE_JESUTOBITS_PREVIEW_PROBE: PREVIEW_URL },
    stdio: "ignore",
  });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch("http://127.0.0.1:1420/").then(
      () => true,
      () => false,
    );
    if (!up) await sleep(500);
  }
  if (!up) {
    killTree(vite.pid);
    for (const server of servers) server.close();
    throw new Error("The Workbench dev server did not start on http://127.0.0.1:1420");
  }
}

const hostLog = [];
const host = spawn(HOST_EXE, [], { stdio: ["ignore", "ignore", "pipe"] });
host.stderr.setEncoding("utf8");
let partial = ""; // Lines can be split across chunks.
host.stderr.on("data", (chunk) => {
  const lines = (partial + chunk).split(/\r?\n/);
  partial = lines.pop();
  hostLog.push(...lines.filter(Boolean));
});

let summary;
for (let i = 0; i < 120 && !summary; i++) {
  await sleep(500);
  const line = hostLog.find((l) => l.includes("[s3] "));
  if (line) summary = JSON.parse(line.slice(line.indexOf("[s3] ") + 5));
}
await sleep(3000); // Let late frame reports arrive.
killTree(host.pid);
if (vite) killTree(vite.pid);
for (const server of servers) server.close();

// Built from per-attempt reports, so a stalled page still shows how far it got.
const ipc = Object.fromEntries(
  reports.filter((r) => r.kind === "attempt").map((r) => [r.name, r.result]),
);
const inspect = reports.find((r) => r.kind === "received" && r.type === "inspect.set");
const forged = reports.filter((r) => r.kind === "forged").length;
const failed = (name) => ipc[name] && !ipc[name].ok;
const notInternals = (name) => failed(name) || ipc[name]?.value === "undefined";

const checks = {
  "Workbench got the bridge.hello": summary?.hellosAccepted === 1,
  "wrong nonce rejected": summary?.rejected.nonce >= 1,
  "malformed message rejected": summary?.rejected.schema >= 1,
  [`all ${forged} forged messages rejected (other window)`]:
    forged === 2 && summary?.rejected.source >= forged,
  "inspect.set reached the frame from the exact Workbench origin":
    inspect?.fromParentOrigin === true &&
    inspect?.nonceOk === true &&
    inspect?.origin === summary?.workbenchOrigin,
  "Workbench cannot read the frame's document": summary?.frameDocumentReadable === false,
  "frame cannot read the Workbench document": failed("parentDocument"),
  "no __TAURI_INTERNALS__ invoke from the frame":
    notInternals("frameTauriInternals") || failed("frameInvoke"),
  "every app and core:default command refused from the frame": Object.keys(ipc)
    .filter((name) => name.startsWith("cmd:"))
    .every((name) => failed(name) || notInternals("frameTauriInternals")),
  "no IPC through window.top": failed("topTauriInternals") && failed("topInvoke"),
  "canary never reached the Host log": !hostLog.some((l) => l.includes(CANARY)),
  "Workbench not navigated away": !reports.some((r) => r.kind === "top-navigated"),
};

process.stdout.write(
  `\nSpike S3 (${LABEL}), Workbench origin ${summary?.workbenchOrigin ?? "?"}\n`,
);
for (const [name, ok] of Object.entries(checks))
  process.stdout.write(`  ${ok ? "PASS" : "FAIL"}  ${name}\n`);
process.stdout.write(`\nWorkbench summary: ${JSON.stringify(summary)}\n`);
process.stdout.write(`Frame IPC attempts: ${JSON.stringify(ipc, null, 2)}\n`);
process.stdout.write(
  `Top navigation: ${JSON.stringify(reports.find((r) => r.kind === "navigation")?.result)}\n`,
);
const leaked = hostLog.filter((l) => l.includes(CANARY));
if (leaked.length) process.stdout.write(`LEAKED: ${leaked.join("\n")}\n`);
const passed = Object.values(checks).every(Boolean);
if (!passed) {
  process.stdout.write(
    `\nHost log:\n${hostLog.join("\n")}\nFrame reports: ${JSON.stringify(reports)}\n`,
  );
}
process.exit(passed ? 0 : 1);
