// Development-only stand-in for the Host relay (DEVELOPMENT_SETUP.md section 3): lets the
// Workbench in a normal browser (`pnpm dev:web --runtime`) and browser E2E tests talk to a
// real runtime. It is never shipped.
//
// Like the Host, it spawns the runtime bundle, hand-shakes, and relays only Workbench-callable
// methods (packages/protocol/generated/methods.json). It listens on 127.0.0.1 only, requires
// a random token in the `x-jesutobits-token` header, and allows one browser origin.
//
//   POST /rpc     {"method", "params"} -> {"result"} or {"error"} (a JSON-RPC error object)
//   GET  /events  NDJSON stream: {"kind":"status",...} and {"kind":"event","event":{...}}
//
//   node scripts/dev-relay.mjs [--port 1421] [--data-dir <dir>] [--origin http://127.0.0.1:1420]
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(root, "packages", "runtime", "dist", "bundle", "runtime.mjs");
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const CALL_TIMEOUT_MS = 60_000;

function readAllowlist() {
  const methods = JSON.parse(
    readFileSync(join(root, "packages", "protocol", "generated", "methods.json"), "utf8"),
  );
  return { workbench: new Set(methods.workbench), protocolVersion: methods.protocolVersion };
}

function rpcError(code, errorCode, message) {
  return { code, message, data: { code: errorCode, message, retryable: false } };
}

/**
 * Starts the runtime and the relay. Resolves once both are ready, with the URL, the token and
 * a `close()` that shuts the runtime down.
 */
export async function startRelay({
  port = 0,
  dataDir = join(root, "node_modules", ".cache", "jesutobits-dev-web"),
  origin = "http://127.0.0.1:1420",
  token = randomBytes(24).toString("hex"),
  quiet = false,
} = {}) {
  const { workbench, protocolVersion } = readAllowlist();
  mkdirSync(dataDir, { recursive: true });

  const child = spawn(process.execPath, [BUNDLE, "--stdio", "--data-dir", dataDir], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;
  let status = { status: "starting" };
  let buffer = "";

  const broadcast = (message) => {
    const line = `${JSON.stringify(message)}\n`;
    for (const listener of listeners) listener.write(line);
  };
  const setStatus = (next) => {
    status = next;
    broadcast({ kind: "status", ...next });
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line);
      if (message.method === "event" && message.id === undefined) {
        broadcast({ kind: "event", event: message.params });
      } else if (pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  // Runtime log lines are visible while developing.
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (!quiet) process.stderr.write(`[runtime] ${chunk}`);
  });
  child.on("exit", (code) => {
    for (const resolve of pending.values()) {
      resolve({ error: rpcError(-32000, "runtime.unavailable", "The runtime stopped") });
    }
    pending.clear();
    setStatus({ status: "failed", detail: `The runtime exited (code ${code})` });
  });

  const call = (method, params) =>
    new Promise((resolve) => {
      const id = `relay-${nextId++}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: rpcError(-32000, "rpc.timeout", `${method} did not reply in time`) });
      }, CALL_TIMEOUT_MS);
      pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  const handshake = await call("runtime.initialize", {
    protocolVersion,
    client: { name: "jesutobits-dev-relay", version: "0.0.0" },
  });
  if (handshake.error) {
    child.kill();
    throw new Error(`Runtime handshake failed: ${handshake.error.message}`);
  }
  setStatus({ status: "ready" });

  const server = createServer((request, response) => {
    const cors = {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "content-type, x-jesutobits-token",
      "access-control-allow-methods": "GET, POST",
      vary: "origin",
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors).end();
      return;
    }
    const send = (code, body) => {
      response.writeHead(code, { ...cors, "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.headers["x-jesutobits-token"] !== token) {
      send(401, { error: rpcError(-32600, "rpc.invalid_request", "Missing or wrong relay token") });
      return;
    }
    if (request.method === "GET" && request.url === "/events") {
      response.writeHead(200, {
        ...cors,
        "content-type": "application/x-ndjson",
        "cache-control": "no-store",
      });
      response.write(`${JSON.stringify({ kind: "status", ...status })}\n`);
      listeners.add(response);
      request.on("close", () => listeners.delete(response));
      return;
    }
    if (request.method === "POST" && request.url === "/rpc") {
      let size = 0;
      const chunks = [];
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) request.destroy();
        else chunks.push(chunk);
      });
      request.on("end", async () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          send(400, { error: rpcError(-32700, "rpc.parse_error", "Invalid JSON") });
          return;
        }
        if (typeof body?.method !== "string" || !workbench.has(body.method)) {
          send(200, {
            error: rpcError(
              -32601,
              "rpc.method_not_allowed",
              `${body?.method} is not callable from the Workbench`,
            ),
          });
          return;
        }
        const reply = await call(body.method, body.params ?? {});
        send(200, reply.error ? { error: reply.error } : { result: reply.result });
      });
      return;
    }
    send(404, { error: rpcError(-32601, "rpc.method_not_found", "Unknown relay route") });
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    token,
    async close() {
      for (const listener of listeners) listener.end();
      server.close();
      if (child.exitCode === null) {
        await call("runtime.shutdown", {});
        await new Promise((resolve) =>
          child.exitCode === null ? child.on("exit", resolve) : resolve(),
        );
      }
    },
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const arg = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
  };
  const relay = await startRelay({
    port: Number(arg("--port", "1421")),
    dataDir: arg("--data-dir", undefined),
    origin: arg("--origin", "http://127.0.0.1:1420"),
  });
  process.stdout.write(`${JSON.stringify({ url: relay.url, token: relay.token })}\n`);
  const stop = () => void relay.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
