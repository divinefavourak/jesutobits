// The Jesutobits extension: the Host for the runtime inside VS Code (ADR-0015). It supervises
// the runtime, answers its reverse calls with VS Code APIs, feeds it settings, keeps the
// active project in step with the open folder and Workspace Trust, and hosts the agent panel.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import {
  AppSettingsSchema,
  LogLevelSchema,
  RuntimeEventBaseSchema,
  UiStateSchema,
  type AppSettings,
  type LogLevel,
  type Project,
  type RuntimeStatusUpdate,
  type UiState,
} from "@jesutobits/protocol";
import * as vscode from "vscode";
import type { PanelServices } from "./host/panel-messages.js";
import { createReverseHandler } from "./host/reverse-calls.js";
import { runtimeConfig } from "./host/runtime-config.js";
import { syncProject, type RuntimeCall } from "./host/workspace-project.js";
import { launchSpec } from "./runtime/launch.js";
import { RuntimeSupervisor } from "./runtime/supervisor.js";
import { AGENT_VIEW_ID, AgentViewProvider } from "./vscode/agent-view.js";

/** globalState key for the panel's remembered state (active session per project). */
const UI_STATE_KEY = "jesutobits.uiState";

let supervisor: RuntimeSupervisor | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Jesutobits", { log: true });
  const log = (level: LogLevel, message: string) => output[level](message);
  const dataDir = context.globalStorageUri.fsPath;
  mkdirSync(dataDir, { recursive: true });

  const currentConfig = () => {
    const settings = vscode.workspace.getConfiguration("jesutobits");
    const { config, problem } = runtimeConfig(
      (key) => settings.get(key),
      [context.logUri.fsPath, ...(context.storageUri ? [context.storageUri.fsPath] : [])],
    );
    if (problem) log("warn", `invalid Jesutobits settings, using the defaults: ${problem}`);
    return config;
  };
  const currentSettings = (): AppSettings => AppSettingsSchema.parse(currentConfig().settings);

  let project: Project | null = null;
  const openProject = async (call: RuntimeCall) => {
    try {
      project =
        (await syncProject(
          call,
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          vscode.workspace.isTrusted,
        )) ?? null;
      panel.post({ kind: "project", project });
    } catch (error) {
      log("warn", `could not open the workspace folder as a project: ${String(error)}`);
    }
  };

  const runtime = new RuntimeSupervisor({
    launch: () =>
      launchSpec({
        execPath: process.execPath,
        extensionPath: context.extensionPath,
        dataDir,
        appRoot: vscode.env.appRoot,
      }),
    client: { name: "jesutobits-vscode", version: String(context.extension.packageJSON.version) },
    onRequest: createReverseHandler({
      getSecret: async (ref) => context.secrets.get(ref),
      trash: async (path) => {
        await vscode.workspace.fs.delete(vscode.Uri.file(path), {
          recursive: true,
          useTrash: true,
        });
      },
      reveal: async (path) => {
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(path));
      },
      log,
      homeDir: homedir(),
    }),
    // Settings first, then the project, on the connection itself: both reach the runtime
    // before it is marked Ready and before any panel call.
    onReady: (connection) => {
      void connection.call("runtime.configure", currentConfig(), 10_000).catch((error: unknown) => {
        log("warn", `the runtime did not take the settings: ${String(error)}`);
      });
      void openProject((method, params) => connection.call(method, params, 30_000));
    },
    log,
    onRuntimeLog: (line) => writeRuntimeLog(output, line),
  });
  supervisor = runtime;
  const call: RuntimeCall = (method, params) => runtime.call(method, params);

  const services: PanelServices = {
    call,
    settings: currentSettings,
    setDefaultModel: async (modelId) => {
      await vscode.workspace
        .getConfiguration("jesutobits")
        .update("providers.openrouter.defaultModel", modelId, vscode.ConfigurationTarget.Global);
    },
    uiState: {
      get: (): UiState => {
        const parsed = UiStateSchema.safeParse(context.globalState.get(UI_STATE_KEY) ?? {});
        return parsed.success ? parsed.data : UiStateSchema.parse({});
      },
      set: async (state) => {
        await context.globalState.update(UI_STATE_KEY, state);
      },
    },
    secrets: {
      exists: async (ref) => (await context.secrets.get(ref)) !== undefined,
      prompt: async (ref) => {
        const value = await vscode.window.showInputBox({
          title: "OpenRouter API key",
          prompt: "Kept in the system's credential store; Jesutobits never shows it again.",
          password: true,
          ignoreFocusOut: true,
          validateInput: (text) =>
            text.trim() === "" || [...text.trim()].some((char) => char < " " || char === "\u007f")
              ? "Paste the key on one line."
              : undefined,
        });
        if (value === undefined || value.trim() === "") return false;
        await context.secrets.store(ref, value.trim());
        return true;
      },
      delete: async (ref) => {
        await context.secrets.delete(ref);
      },
    },
    restartRuntime: () => {
      if (runtime.status.status === "failed") runtime.restart();
    },
    openSettings: async () => {
      await vscode.commands.executeCommand("workbench.action.openSettings", "jesutobits");
    },
    projectRoot: () => project?.path,
    openFile: async (path) => {
      await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: true });
    },
    log,
  };
  const panel = new AgentViewProvider(context.extensionUri, services, () => ({
    status: runtime.status,
    project,
  }));

  const status = vscode.window.createStatusBarItem(
    "jesutobits.runtime",
    vscode.StatusBarAlignment.Left,
    0,
  );
  status.name = "Jesutobits Runtime";
  context.subscriptions.push(
    output,
    status,
    vscode.window.registerWebviewViewProvider(AGENT_VIEW_ID, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    {
      dispose: runtime.onStatus((update) => {
        showStatus(status, update);
        panel.post({ kind: "status", update });
      }),
    },
    {
      dispose: runtime.onEvent((event) => {
        const parsed = RuntimeEventBaseSchema.loose().safeParse(event);
        if (parsed.success) panel.post({ kind: "event", event: parsed.data });
      }),
    },
    vscode.commands.registerCommand("jesutobits.restartRuntime", () => runtime.restart()),
    vscode.commands.registerCommand("jesutobits.showLog", () => output.show()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("jesutobits")) return;
      runtime.call("runtime.configure", currentConfig()).catch((error: unknown) => {
        log("warn", `the runtime did not take the settings: ${String(error)}`);
      });
      panel.post({ kind: "settings", settings: currentSettings() });
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void openProject(call)),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void openProject(call)),
  );
  runtime.start();
}

export function deactivate(): Promise<void> | undefined {
  return supervisor?.shutdown();
}

/** Runtime stderr is structured JSON lines (already masked by its SecretRegistry). */
function writeRuntimeLog(output: vscode.LogOutputChannel, line: string): void {
  let level: LogLevel = "info";
  try {
    const parsed = LogLevelSchema.safeParse((JSON.parse(line) as { level?: unknown }).level);
    if (parsed.success) level = parsed.data;
  } catch {
    // Not JSON (a Node warning, say): logged as is.
  }
  output[level](`[runtime] ${line}`);
}

/** The runtime's real state only (invariant 6): no spinner unless it is actually starting. */
function showStatus(item: vscode.StatusBarItem, update: RuntimeStatusUpdate): void {
  const icons: Record<RuntimeStatusUpdate["status"], string> = {
    starting: "$(loading~spin)",
    ready: "$(hubot)",
    degraded: "$(warning)",
    restarting: "$(loading~spin)",
    failed: "$(error)",
  };
  item.text = `${icons[update.status]} Jesutobits`;
  item.tooltip = `Agent runtime: ${update.status}${update.detail ? ` (${update.detail})` : ""}`;
  item.command = update.status === "failed" ? "jesutobits.restartRuntime" : "jesutobits.showLog";
  item.backgroundColor =
    update.status === "failed" ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
  item.show();
}
