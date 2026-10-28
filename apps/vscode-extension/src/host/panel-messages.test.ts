import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AppSettingsSchema,
  ErrorCodes,
  UiStateSchema,
  type AppSettings,
  type JesutobitsErrorData,
  type LogLevel,
  type SecretRef,
  type UiState,
} from "@jesutobits/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { RpcCallError, rpcError } from "../runtime/connection.js";
import { handlePanelMessage, type PanelOutcome, type PanelServices } from "./panel-messages.js";

const REF: SecretRef = "provider:openrouter:default";
const SECRET = "sk-or-v1-never-leaves-the-extension";

const dirs: string[] = [];

function tempDir(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "jesutobits-panel-")));
  dirs.push(dir);
  return dir;
}

function setup(
  overrides: Partial<PanelServices> = {},
  initialUiState: UiState = UiStateSchema.parse({}),
) {
  const runtimeCalls: Array<{ method: string; params: unknown }> = [];
  const logs: Array<{ level: LogLevel; message: string }> = [];
  const models: Array<string | null> = [];
  const savedUiStates: UiState[] = [];
  const openedSettings: Array<string | undefined> = [];
  const openedFiles: string[] = [];
  const secretActions: string[] = [];
  const counters = { restarts: 0 };
  const settings: AppSettings = AppSettingsSchema.parse({});
  const storedSecrets = new Map<SecretRef, string>([[REF, SECRET]]);
  let uiState = initialUiState;

  const services: PanelServices = {
    call: async (method, params) => {
      runtimeCalls.push({ method, params });
      return { projects: [] };
    },
    settings: () => settings,
    setDefaultModel: async (modelId) => {
      models.push(modelId);
    },
    uiState: {
      get: () => uiState,
      set: async (state) => {
        uiState = state;
        savedUiStates.push(state);
      },
    },
    secrets: {
      exists: async (ref) => {
        secretActions.push(`exists ${ref}`);
        return storedSecrets.has(ref);
      },
      prompt: async (ref) => {
        secretActions.push(`prompt ${ref}`);
        storedSecrets.set(ref, SECRET);
        return true;
      },
      signIn: async (ref) => {
        secretActions.push(`signIn ${ref}`);
        storedSecrets.set(ref, SECRET);
        return true;
      },
      delete: async (ref) => {
        secretActions.push(`delete ${ref}`);
        storedSecrets.delete(ref);
      },
    },
    restartRuntime: () => {
      counters.restarts += 1;
    },
    openSettings: async (section) => {
      openedSettings.push(section);
    },
    projectRoot: () => undefined,
    openExternal: async () => undefined,
    compose: async () => undefined,
    startProject: async () => undefined,
    navigate: async () => undefined,
    look: {
      get: () => ({ theme: "Lavender dusk", remix: null }),
      setTheme: async () => undefined,
      remix: async () => undefined,
    },
    openFile: async (path) => {
      openedFiles.push(path);
    },
    log: (level, message) => {
      logs.push({ level, message });
    },
    ...overrides,
  };

  return {
    services,
    runtimeCalls,
    logs,
    models,
    savedUiStates,
    openedSettings,
    openedFiles,
    secretActions,
    counters,
    settings,
  };
}

function errorOf(outcome: PanelOutcome): JesutobitsErrorData {
  if (outcome?.kind !== "error") {
    throw new Error(`The panel answered ${JSON.stringify(outcome)}`);
  }
  return outcome.error;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("handlePanelMessage", () => {
  it("ignores a message it does not recognise", async () => {
    const { services, logs } = setup();

    await expect(handlePanelMessage({ kind: "nope" }, services)).resolves.toBeUndefined();

    expect(logs).toEqual([{ level: "warn", message: expect.stringContaining("malformed") }]);
  });

  it("ignores a call without an id", async () => {
    const { services, logs, runtimeCalls } = setup();

    const outcome = await handlePanelMessage(
      { kind: "call", method: "projects.list", params: {} },
      services,
    );

    expect(outcome).toBeUndefined();
    expect(logs).toEqual([{ level: "warn", message: expect.stringContaining("malformed") }]);
    expect(runtimeCalls).toEqual([]);
  });

  it("asks for the current state when the panel is ready", async () => {
    const { services } = setup();

    await expect(handlePanelMessage({ kind: "ready" }, services)).resolves.toEqual({
      kind: "ready",
    });
  });

  it("relays a runtime call the Workbench may make", async () => {
    const { services, runtimeCalls } = setup();

    const outcome = await handlePanelMessage(
      { kind: "call", id: 7, method: "projects.list", params: {} },
      services,
    );

    expect(runtimeCalls).toEqual([{ method: "projects.list", params: {} }]);
    expect(outcome).toEqual({ kind: "result", id: 7, result: { projects: [] } });
  });

  it("refuses a runtime method the panel may not call", async () => {
    const { services, runtimeCalls } = setup();

    const shutdown = await handlePanelMessage(
      { kind: "call", id: 1, method: "runtime.shutdown", params: {} },
      services,
    );
    const configure = await handlePanelMessage(
      { kind: "call", id: 2, method: "runtime.configure", params: {} },
      services,
    );

    expect(errorOf(shutdown).code).toBe(ErrorCodes.rpcMethodNotAllowed);
    expect(errorOf(configure).code).toBe(ErrorCodes.rpcMethodNotAllowed);
    expect(runtimeCalls).toEqual([]);
  });

  it("reports a runtime failure with the runtime's error", async () => {
    const { services } = setup({
      call: async () => {
        throw new RpcCallError(rpcError(-32000, ErrorCodes.fsNotFound, "gone"));
      },
    });

    const outcome = await handlePanelMessage(
      { kind: "call", id: 3, method: "projects.list", params: {} },
      services,
    );

    const error = errorOf(outcome);
    expect(error.code).toBe("fs.not_found");
    expect(error.message).toBe("gone");
  });

  it("refuses a host operation the extension does not have", async () => {
    const { services } = setup();

    const outcome = await handlePanelMessage(
      { kind: "host", id: 1, op: "ui.explode", params: {} },
      services,
    );

    expect(errorOf(outcome).code).toBe(ErrorCodes.rpcMethodNotFound);
  });

  it("refuses host params that do not match the operation", async () => {
    const { services, secretActions } = setup();

    const outcome = await handlePanelMessage(
      { kind: "host", id: 1, op: "secrets.exists", params: { ref: "x" } },
      services,
    );

    expect(errorOf(outcome).code).toBe(ErrorCodes.rpcInvalidParams);
    expect(secretActions).toEqual([]);
  });

  it("stores the chosen default model and answers with settings", async () => {
    const { services, models, settings } = setup();

    const outcome = await handlePanelMessage(
      {
        kind: "host",
        id: 1,
        op: "settings.update",
        params: { providers: { openrouter: { defaultModel: "openai/gpt-5" } } },
      },
      services,
    );

    expect(models).toEqual(["openai/gpt-5"]);
    expect(outcome).toEqual({ kind: "result", id: 1, result: settings });
  });

  it("refuses a settings patch with keys the panel does not own", async () => {
    const { services, models } = setup();

    const outcome = await handlePanelMessage(
      {
        kind: "host",
        id: 1,
        op: "settings.update",
        params: { providers: { openrouter: { defaultModel: null, profile: "other" } } },
      },
      services,
    );

    expect(errorOf(outcome).code).toBe(ErrorCodes.rpcInvalidParams);
    expect(models).toEqual([]);
  });

  it("merges the panel's state into the keys it did not mention", async () => {
    const { services, savedUiStates } = setup(
      {},
      UiStateSchema.parse({ activeSessionId: "ses_a", layout: { sidebar: "open" } }),
    );

    const outcome = await handlePanelMessage(
      {
        kind: "host",
        id: 1,
        op: "uiState.update",
        params: { layout: { sidebar: "closed" }, onboarding: "done" },
      },
      services,
    );

    const expected = UiStateSchema.parse({
      schemaVersion: 1,
      window: null,
      activeSessionId: "ses_a",
      layout: { sidebar: "closed" },
      onboarding: "done",
    });
    expect(outcome).toEqual({ kind: "result", id: 1, result: expected });
    expect(savedUiStates).toEqual([expected]);
  });

  it("removes a UI state key sent as null", async () => {
    const { services, savedUiStates } = setup(
      {},
      UiStateSchema.parse({ activeSessionId: "ses_a" }),
    );

    const outcome = await handlePanelMessage(
      { kind: "host", id: 1, op: "uiState.update", params: { activeSessionId: null } },
      services,
    );

    if (outcome?.kind !== "result") throw new Error("The panel did not answer");
    expect(outcome.result).toEqual(UiStateSchema.parse({}));
    expect(savedUiStates).toEqual([UiStateSchema.parse({})]);
  });

  it("refuses to change the panel's window or schema version", async () => {
    const { services, savedUiStates } = setup();

    const window = await handlePanelMessage(
      { kind: "host", id: 1, op: "uiState.update", params: { window: null } },
      services,
    );
    const version = await handlePanelMessage(
      { kind: "host", id: 2, op: "uiState.update", params: { schemaVersion: 2 } },
      services,
    );

    expect(errorOf(window).code).toBe(ErrorCodes.storageInvalidSettings);
    expect(errorOf(version).code).toBe(ErrorCodes.storageInvalidSettings);
    expect(savedUiStates).toEqual([]);
  });

  it("checks whether a key is stored without sending it back", async () => {
    const { services, secretActions } = setup();

    const outcome = await handlePanelMessage(
      { kind: "host", id: 1, op: "secrets.exists", params: { ref: REF } },
      services,
    );

    expect(secretActions).toEqual([`exists ${REF}`]);
    expect(outcome).toEqual({ kind: "result", id: 1, result: { exists: true } });
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it("asks for a key in the extension and deletes it on request", async () => {
    const { services, secretActions } = setup();

    const prompted = await handlePanelMessage(
      { kind: "host", id: 1, op: "secrets.prompt", params: { ref: REF } },
      services,
    );
    const deleted = await handlePanelMessage(
      { kind: "host", id: 2, op: "secrets.delete", params: { ref: REF } },
      services,
    );

    expect(secretActions).toEqual([`prompt ${REF}`, `delete ${REF}`]);
    expect(prompted).toEqual({ kind: "result", id: 1, result: { stored: true } });
    expect(deleted).toEqual({ kind: "result", id: 2, result: {} });
    expect(JSON.stringify([prompted, deleted])).not.toContain(SECRET);
  });

  it("signs in with OpenRouter in the extension; the webview only learns that it worked", async () => {
    const { services, secretActions } = setup();

    const outcome = await handlePanelMessage(
      { kind: "host", id: 1, op: "secrets.signIn", params: { ref: REF } },
      services,
    );

    expect(secretActions).toEqual([`signIn ${REF}`]);
    expect(outcome).toEqual({ kind: "result", id: 1, result: { stored: true } });
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it("restarts the runtime and opens settings at a section", async () => {
    const { services, counters, openedSettings } = setup();

    await handlePanelMessage({ kind: "host", id: 1, op: "runtime.restart", params: {} }, services);
    const outcome = await handlePanelMessage(
      { kind: "host", id: 2, op: "ui.openSettings", params: { section: "jesutobits.providers" } },
      services,
    );

    expect(counters.restarts).toBe(1);
    expect(openedSettings).toEqual(["jesutobits.providers"]);
    expect(outcome).toEqual({ kind: "result", id: 2, result: {} });
  });

  it("writes panel logs with a prefix", async () => {
    const { services, logs } = setup();

    await handlePanelMessage(
      { kind: "host", id: 1, op: "log", params: { level: "info", message: "hello" } },
      services,
    );

    expect(logs).toEqual([{ level: "info", message: "[panel] hello" }]);
  });

  it("refuses to open a file when no project is open", async () => {
    const { services, openedFiles } = setup();

    const outcome = await handlePanelMessage(
      { kind: "host", id: 1, op: "ui.openFile", params: { path: "src/a.ts" } },
      services,
    );

    expect(errorOf(outcome).code).toBe(ErrorCodes.fsNoProject);
    expect(openedFiles).toEqual([]);
  });

  it("opens a project file at its absolute path", async () => {
    const root = tempDir();
    const { services, openedFiles } = setup({ projectRoot: () => root });

    const outcome = await handlePanelMessage(
      { kind: "host", id: 1, op: "ui.openFile", params: { path: "src/a.ts" } },
      services,
    );

    expect(openedFiles).toEqual([join(root, "src", "a.ts")]);
    expect(outcome).toEqual({ kind: "result", id: 1, result: {} });
  });

  it("refuses a file outside the project", async () => {
    const root = tempDir();
    const { services, openedFiles } = setup({ projectRoot: () => root });

    const paths = ["../outside.txt", resolve(root, "..", "elsewhere.txt"), "."];
    for (const [index, path] of paths.entries()) {
      const outcome = await handlePanelMessage(
        { kind: "host", id: index + 1, op: "ui.openFile", params: { path } },
        services,
      );

      expect(errorOf(outcome).code).toBe(ErrorCodes.fsOutsideWorkspace);
    }
    expect(openedFiles).toEqual([]);
  });

  it("switches to a Studio theme and remixes it, refusing anything else", async () => {
    const calls: unknown[] = [];
    const { services } = setup({
      look: {
        get: () => ({ theme: "Matcha", remix: null }),
        setTheme: async (theme) => void calls.push(theme),
        remix: async (remix) => void calls.push(remix),
      },
    });
    const remix = { accent: "#c5b1f7", canvas: "#17161c", surfaces: "#201e26", text: "#f2eff7" };

    const send = (id: number, op: string, params: unknown) =>
      handlePanelMessage({ kind: "host", id, op, params }, services);
    expect(await send(1, "look.get", {})).toEqual({
      kind: "result",
      id: 1,
      result: { theme: "Matcha", remix: null },
    });
    expect(await send(2, "look.setTheme", { theme: "Peach tea" })).toEqual({
      kind: "result",
      id: 2,
      result: {},
    });
    expect(await send(3, "look.remix", { remix })).toEqual({ kind: "result", id: 3, result: {} });
    expect(await send(4, "look.remix", { remix: null })).toEqual({
      kind: "result",
      id: 4,
      result: {},
    });

    for (const [id, op, params] of [
      [5, "look.setTheme", { theme: "Some Extension Theme" }],
      [6, "look.remix", { remix: { ...remix, accent: "red; background: url(x)" } }],
      [7, "look.remix", { remix: { ...remix, extra: "#000000" } }],
    ] as const) {
      expect(errorOf(await send(id, op, params)).code).toBe(ErrorCodes.rpcInvalidParams);
    }
    expect(calls).toEqual(["Peach tea", remix, null]);
  });
});
