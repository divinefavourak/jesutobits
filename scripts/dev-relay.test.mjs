// scripts/dev-relay.mjs against the real runtime bundle (needs `pnpm build:runtime`).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRelay } from "./dev-relay.mjs";

let relay;
let base;

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "jesutobits-relay-"));
  mkdirSync(join(base, "project", "src"), { recursive: true });
  writeFileSync(join(base, "project", "src", "a.ts"), "export {};\n");
  relay = await startRelay({ dataDir: join(base, "data"), quiet: true });
}, 20_000);

afterAll(async () => {
  await relay?.close();
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const rpc = (method, params, token = relay.token) =>
  fetch(`${relay.url}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-jesutobits-token": token },
    body: JSON.stringify({ method, params }),
  });

describe("dev relay", () => {
  it("listens on 127.0.0.1 only", () => {
    expect(relay.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("relays Workbench methods to the runtime", async () => {
    const opened = await (await rpc("projects.open", { path: join(base, "project") })).json();
    expect(opened.result.project.name).toBe("project");
    const listed = await (await rpc("fs.listDir", { path: "src" })).json();
    expect(listed.result.entries.map((e) => e.name)).toEqual(["a.ts"]);
  });

  it("refuses a missing or wrong token", async () => {
    expect((await rpc("runtime.ping", {}, "wrong")).status).toBe(401);
  });

  it("refuses methods the Workbench may not call", async () => {
    const body = await (await rpc("runtime.shutdown", {})).json();
    expect(body.error.data.code).toBe("rpc.method_not_allowed");
  });

  it("allows only the configured browser origin", async () => {
    const response = await fetch(`${relay.url}/rpc`, { method: "OPTIONS" });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:1420");
  });

  it("streams the status and runtime events as NDJSON", async () => {
    const abort = new AbortController();
    const response = await fetch(`${relay.url}/events`, {
      headers: { "x-jesutobits-token": relay.token },
      signal: abort.signal,
    });
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const first = await reader.read();
    expect(JSON.parse(first.value.split("\n")[0])).toEqual({ kind: "status", status: "ready" });

    writeFileSync(join(base, "project", "src", "b.ts"), "export {};\n");
    let text = "";
    for (let i = 0; i < 50 && !text.includes("fs.changed"); i++) {
      const next = await reader.read();
      text += next.value ?? "";
    }
    expect(text).toContain('"type":"fs.changed"');
    abort.abort();
  });
});

describe("dev relay reverse calls", () => {
  it("refuses Host-only operations at once instead of letting them time out", async () => {
    const started = Date.now();
    const body = await (await rpc("fs.trash", { path: "src/a.ts" })).json();
    expect(body.error.data.code).toBe("fs.trash_failed");
    expect(body.error.data.details.reason).toMatch(/needs the desktop app/);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
