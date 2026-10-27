import {
  AppSettingsSchema,
  JesutobitsError,
  UiStateSchema,
  type AppSettings,
  type Project,
  type RuntimeEventBase,
  type RuntimeStatusUpdate,
  type SecretRef,
  type WebviewToHost,
} from "@jesutobits/protocol";
import { describe, expect, it } from "vitest";
import { WebviewHostBridge, type VsCodeApi } from "./webview-host-bridge";

const REF: SecretRef = "provider:openrouter:default";

const PROJECT: Project = {
  id: `prj_${"0123456789ABCDEFGHJKMNPQRSTVWXYZ".slice(0, 26)}`,
  path: "C:\\work\\demo",
  name: "demo",
  kind: "project",
  trust: "unknown",
  createdByJesutobits: false,
  lastOpenedAt: null,
  missing: false,
};

type MessageListener = (event: { data: unknown }) => void;
type Request = Extract<WebviewToHost, { kind: "call" } | { kind: "host" }>;

interface WarningEvent extends RuntimeEventBase {
  message: string;
}

function warning(seq: number): WarningEvent {
  return {
    seq,
    ts: "2026-10-26T10:00:00.000Z",
    type: "runtime.warning",
    message: "The provider was slow",
  };
}

function lastRequest(posted: WebviewToHost[]): Request {
  const message = posted.at(-1);
  if (!message || message.kind === "ready") throw new Error("The bridge posted no request");
  return message;
}

function setup() {
  const posted: WebviewToHost[] = [];
  let listener: MessageListener | undefined;

  const api: VsCodeApi = {
    postMessage: (message) => {
      posted.push(message);
    },
  };
  const target = {
    addEventListener: (_type: string, handler: MessageListener) => {
      listener = handler;
    },
  };
  const bridge = new WebviewHostBridge(api, target as unknown as Pick<Window, "addEventListener">);

  return {
    bridge,
    posted,
    deliver(data: unknown): void {
      listener?.({ data });
    },
    answer(result: unknown): void {
      const message = lastRequest(posted);
      listener?.({ data: { kind: "result", id: message.id, result } });
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<JesutobitsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof JesutobitsError) return error;
    throw error;
  }
  throw new Error("The call should have failed");
}

describe("WebviewHostBridge", () => {
  it("tells the extension the panel is listening", () => {
    const { posted } = setup();

    expect(posted).toEqual([{ kind: "ready" }]);
  });

  it("relays a runtime call and resolves its result", async () => {
    const { bridge, posted, deliver } = setup();

    const result = bridge.rpc("projects.list", {});

    expect(posted).toEqual([
      { kind: "ready" },
      { kind: "call", id: 1, method: "projects.list", params: {} },
    ]);

    deliver({ kind: "result", id: 1, result: { projects: [] } });

    await expect(result).resolves.toEqual({ projects: [] });
  });

  it("rejects a result that does not match the method's schema", async () => {
    const { bridge, deliver } = setup();

    const result = bridge.rpc("projects.list", {});
    deliver({ kind: "result", id: 1, result: { projects: "x" } });

    const error = await rejection(result);
    expect(error.code).toBe("rpc.internal");
  });

  it("rejects with the error the extension sent", async () => {
    const { bridge, deliver } = setup();

    const result = bridge.rpc("projects.list", {});
    deliver({
      kind: "error",
      id: 1,
      error: { code: "fs.not_found", message: "gone", retryable: false },
    });

    const error = await rejection(result);
    expect(error.code).toBe("fs.not_found");
    expect(error.message).toBe("gone");
  });

  it("checks whether a key is stored", async () => {
    const { bridge, posted, answer } = setup();

    const result = bridge.secrets.exists(REF);

    expect(lastRequest(posted)).toEqual({
      kind: "host",
      id: 1,
      op: "secrets.exists",
      params: { ref: REF },
    });

    answer({ exists: true });

    await expect(result).resolves.toBe(true);
  });

  it("asks the extension for a key without seeing it", async () => {
    const { bridge, posted, answer } = setup();

    const result = bridge.secrets.prompt(REF);

    expect(lastRequest(posted)).toEqual({
      kind: "host",
      id: 1,
      op: "secrets.prompt",
      params: { ref: REF },
    });

    answer({ stored: true });

    await expect(result).resolves.toBe(true);
  });

  it("opens a project file", async () => {
    const { bridge, posted, answer } = setup();

    const result = bridge.openFile("src/a.ts");

    expect(lastRequest(posted)).toEqual({
      kind: "host",
      id: 1,
      op: "ui.openFile",
      params: { path: "src/a.ts" },
    });

    answer({});

    await expect(result).resolves.toBeUndefined();
  });

  it("opens the settings editor at a section", async () => {
    const { bridge, posted, answer } = setup();

    const result = bridge.openSettings("jesutobits.providers");

    expect(lastRequest(posted)).toEqual({
      kind: "host",
      id: 1,
      op: "ui.openSettings",
      params: { section: "jesutobits.providers" },
    });

    answer({});

    await expect(result).resolves.toBeUndefined();
  });

  it("sends a settings patch and answers with the new settings", async () => {
    const { bridge, posted, answer } = setup();
    const patch = { providers: { openrouter: { defaultModel: "openai/gpt-5" } } };

    const result = bridge.settings.update(patch);

    expect(lastRequest(posted)).toEqual({
      kind: "host",
      id: 1,
      op: "settings.update",
      params: patch,
    });

    const settings = AppSettingsSchema.parse({});
    answer(settings);

    await expect(result).resolves.toEqual(settings);
  });

  it("sends a patch to the panel's UI state", async () => {
    const { bridge, posted, answer } = setup();
    const patch = { activeSessionId: "ses_a" };

    const result = bridge.uiState.update(patch);

    expect(lastRequest(posted)).toEqual({
      kind: "host",
      id: 1,
      op: "uiState.update",
      params: patch,
    });

    const state = UiStateSchema.parse(patch);
    answer(state);

    await expect(result).resolves.toEqual(state);
  });

  it("passes status, project and settings changes to subscribers", () => {
    const { bridge, deliver } = setup();
    const statuses: RuntimeStatusUpdate[] = [];
    const projects: Array<Project | null> = [];
    const settings: AppSettings[] = [];

    bridge.onRuntimeStatus((update) => statuses.push(update));
    bridge.onProject((project) => projects.push(project));
    bridge.settings.onChange((value) => settings.push(value));

    deliver({ kind: "status", update: { status: "ready" } });
    deliver({ kind: "project", project: null });
    const current = AppSettingsSchema.parse({});
    deliver({ kind: "settings", settings: current });

    expect(statuses).toEqual([{ status: "ready" }]);
    expect(projects).toEqual([null]);
    expect(settings).toEqual([current]);
  });

  it("replays the last status and project to a late subscriber", () => {
    const { bridge, deliver } = setup();
    const statuses: RuntimeStatusUpdate[] = [];
    const projects: Array<Project | null> = [];

    deliver({ kind: "status", update: { status: "starting" } });
    deliver({ kind: "project", project: PROJECT });

    bridge.onRuntimeStatus((update) => statuses.push(update));
    bridge.onProject((project) => projects.push(project));

    expect(statuses).toEqual([{ status: "starting" }]);
    expect(projects).toEqual([PROJECT]);
  });

  it("does not replay events to a late subscriber", () => {
    const { bridge, deliver } = setup();
    const events: RuntimeEventBase[] = [];

    deliver({ kind: "event", event: warning(1) });
    bridge.onRuntimeEvent((event) => events.push(event));

    expect(events).toEqual([]);

    deliver({ kind: "event", event: warning(2) });

    expect(events).toEqual([warning(2)]);
  });

  it("tells key subscribers that a secret changed, until they unsubscribe", () => {
    const { bridge, deliver } = setup();
    let first = 0;
    let second = 0;
    bridge.secrets.onChange(() => (first += 1));
    const unsubscribe = bridge.secrets.onChange(() => (second += 1));

    deliver({ kind: "secretsChanged" });
    unsubscribe();
    deliver({ kind: "secretsChanged" });

    expect(first).toBe(2);
    expect(second).toBe(1);
  });

  it("ignores messages it cannot read", async () => {
    const { bridge, deliver } = setup();

    const result = bridge.rpc("projects.list", {});

    expect(() => {
      deliver("not a message");
      deliver({ kind: "result" });
      deliver({ kind: "result", id: 99, result: { projects: [] } });
    }).not.toThrow();

    deliver({ kind: "result", id: 1, result: { projects: [] } });

    await expect(result).resolves.toEqual({ projects: [] });
  });
});
