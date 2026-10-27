import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_VERSION,
  type RuntimeStatus,
  type RuntimeStatusUpdate,
} from "@jesutobits/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcCallError, type RuntimeConnection } from "./connection.js";
import { runtimeEnv } from "./launch.js";
import { RuntimeSupervisor, type LaunchSpec, type SupervisorTimings } from "./supervisor.js";

const CLIENT = { name: "test-host", version: "0.0.0" };
const BUNDLE = fileURLToPath(
  new URL("../../../../packages/runtime/dist/bundle/runtime.mjs", import.meta.url),
);

const supervisors: RuntimeSupervisor[] = [];
const dirs: string[] = [];

function tempDir(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "jesutobits-ext-")));
  dirs.push(dir);
  return dir;
}

function eachLaunch(spec: LaunchSpec): () => LaunchSpec {
  return () => spec;
}

function realLaunch(dataDir: string): () => LaunchSpec {
  return eachLaunch({
    command: process.execPath,
    args: [BUNDLE, "--stdio", "--data-dir", dataDir],
    env: runtimeEnv(process.env),
  });
}

function fakeLaunch(script: string): () => LaunchSpec {
  return eachLaunch({
    command: process.execPath,
    args: ["-e", script],
    env: runtimeEnv(process.env),
  });
}

function trackingSpawn(children: ChildProcess[]): typeof spawn {
  const tracking = (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => {
    const child = spawn(command, args, options);
    children.push(child);
    return child;
  };
  return tracking as unknown as typeof spawn;
}

interface Capture {
  supervisor: RuntimeSupervisor;
  statuses: RuntimeStatusUpdate[];
  runtimeLogs: string[];
  requests: Array<{ method: string; params: unknown }>;
  ready: RuntimeConnection[];
}

function startRuntime(options: {
  launch: () => LaunchSpec;
  timings?: Partial<SupervisorTimings>;
  spawn?: typeof spawn;
}): Capture {
  const statuses: RuntimeStatusUpdate[] = [];
  const runtimeLogs: string[] = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  const ready: RuntimeConnection[] = [];
  const supervisor = new RuntimeSupervisor({
    launch: options.launch,
    client: CLIENT,
    onRequest: async (method, params) => {
      requests.push({ method, params });
      return { value: "sk-test-secret" };
    },
    onReady: (connection) => ready.push(connection),
    log: () => {},
    onRuntimeLog: (line) => runtimeLogs.push(line),
    ...(options.timings !== undefined ? { timings: options.timings } : {}),
    ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
  });
  supervisor.onStatus((update) => statuses.push(update));
  supervisors.push(supervisor);
  supervisor.start();
  return { supervisor, statuses, runtimeLogs, requests, ready };
}

async function waitForStatus(
  statuses: RuntimeStatusUpdate[],
  status: RuntimeStatus,
  timeout = 6_000,
): Promise<void> {
  await vi.waitFor(() => expect(statuses.map((update) => update.status)).toContain(status), {
    timeout,
    interval: 10,
  });
}

const FAKE_PRELUDE = `
const reply = (id, result) => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
};
const INITIALIZED = {
  protocolVersion: ${JSON.stringify(PROTOCOL_VERSION)},
  runtimeVersion: "x",
  nodeVersion: "x",
};
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() === "") continue;
    const message = JSON.parse(line);
`;

function fakeRuntime(onMessage: string): string {
  return `${FAKE_PRELUDE}    ${onMessage}\n  }\n});\n`;
}

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.shutdown();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!existsSync(BUNDLE))("RuntimeSupervisor with the real runtime", () => {
  it("reaches ready, answers calls and shuts down without failing", async () => {
    const capture = startRuntime({ launch: realLaunch(tempDir()) });

    await waitForStatus(capture.statuses, "ready", 8_000);

    expect(capture.statuses.map((update) => update.status)).toEqual(["starting", "ready"]);
    expect(await capture.supervisor.call("projects.list", {})).toEqual({ projects: [] });
    expect(capture.ready).toHaveLength(1);
    expect(typeof capture.ready[0]?.call).toBe("function");

    await capture.supervisor.shutdown();

    expect(capture.statuses.some((update) => update.status === "failed")).toBe(false);
  });

  it("restarts a runtime that crashes", async () => {
    const children: ChildProcess[] = [];
    const capture = startRuntime({
      launch: realLaunch(tempDir()),
      spawn: trackingSpawn(children),
      timings: { backoff: [50] },
    });
    await waitForStatus(capture.statuses, "ready", 8_000);
    expect(children).toHaveLength(1);

    children[0]?.kill();
    await waitForStatus(capture.statuses, "restarting");
    await vi.waitFor(() => expect(capture.ready).toHaveLength(2), { timeout: 8_000, interval: 20 });

    expect(children).toHaveLength(2);
    expect(capture.statuses.some((update) => update.status === "failed")).toBe(false);
  });

  it("starts a fresh runtime when the user restarts from ready", async () => {
    const children: ChildProcess[] = [];
    const capture = startRuntime({
      launch: realLaunch(tempDir()),
      spawn: trackingSpawn(children),
    });
    await waitForStatus(capture.statuses, "ready", 8_000);

    capture.supervisor.restart();
    await vi.waitFor(() => expect(capture.ready).toHaveLength(2), { timeout: 8_000, interval: 20 });

    expect(children).toHaveLength(2);
    expect(capture.statuses.some((update) => update.status === "restarting")).toBe(false);
  });
});

describe("RuntimeSupervisor", () => {
  it("refuses calls before the runtime is ready", async () => {
    const supervisor = new RuntimeSupervisor({
      launch: fakeLaunch("process.stdin.resume();"),
      client: CLIENT,
      onRequest: async () => ({}),
      log: () => {},
    });
    supervisors.push(supervisor);

    const error = await supervisor.call("projects.list", {}).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RpcCallError);
    expect(error instanceof RpcCallError ? error.error.data?.code : undefined).toBe(
      "runtime.unavailable",
    );
  });

  it("fails when the handshake times out, and starts again on a restart", async () => {
    const capture = startRuntime({
      launch: fakeLaunch("process.stdin.resume();"),
      timings: { handshake: 300, shutdownReply: 200, shutdownExit: 200 },
    });

    await waitForStatus(capture.statuses, "failed");
    expect(capture.statuses.at(-1)?.detail).toContain("handshake");

    capture.supervisor.restart();

    await vi.waitFor(() => expect(capture.statuses.at(-1)?.status).toBe("starting"), {
      timeout: 3_000,
      interval: 20,
    });
  });

  it("fails when the runtime speaks another protocol", async () => {
    const capture = startRuntime({
      launch: fakeLaunch(
        fakeRuntime(
          `if (message.method === "runtime.initialize") reply(message.id, { protocolVersion: "9.0.0", runtimeVersion: "x", nodeVersion: "x" });`,
        ),
      ),
    });

    await waitForStatus(capture.statuses, "failed");

    expect(capture.statuses.at(-1)?.detail).toContain("protocol");
  });

  it("goes degraded and then restarts a runtime that stops answering pings", async () => {
    const capture = startRuntime({
      launch: fakeLaunch(
        fakeRuntime(`if (message.method === "runtime.initialize") reply(message.id, INITIALIZED);`),
      ),
      timings: {
        pingInterval: 50,
        pingTimeout: 50,
        missedPingsDegraded: 2,
        missedPingsRestart: 4,
        backoff: [50],
        shutdownReply: 200,
        shutdownExit: 200,
      },
    });

    await waitForStatus(capture.statuses, "degraded");
    await waitForStatus(capture.statuses, "restarting");

    expect(capture.statuses.some((update) => update.status === "failed")).toBe(false);
  });

  it("stops restarting a runtime that crashes every time", async () => {
    const capture = startRuntime({
      launch: fakeLaunch("process.exit(3);"),
      timings: { backoff: [10], crashesUntilFailed: 3 },
    });

    await waitForStatus(capture.statuses, "failed");

    expect(capture.statuses.at(-1)?.detail).toContain("3 times");
  });

  it("answers a reverse call and logs the reply it gets", async () => {
    const capture = startRuntime({
      launch: fakeLaunch(
        fakeRuntime(`
    if (message.method === "runtime.initialize") {
      reply(message.id, INITIALIZED);
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "r1", method: "host.secrets.get", params: { ref: "provider:openrouter:default" } }) + "\\n");
    } else if (message.id === "r1") {
      process.stderr.write("host replied " + JSON.stringify(message) + "\\n");
    }`),
      ),
      timings: { shutdownReply: 200, shutdownExit: 200 },
    });

    await vi.waitFor(() => expect(capture.requests).toHaveLength(1), {
      timeout: 5_000,
      interval: 20,
    });
    expect(capture.requests[0]).toEqual({
      method: "host.secrets.get",
      params: { ref: "provider:openrouter:default" },
    });

    await vi.waitFor(
      () => expect(capture.runtimeLogs.some((line) => line.includes("sk-test-secret"))).toBe(true),
      { timeout: 5_000, interval: 20 },
    );
  });
});
