// The Jesutobits extension: the Host for the runtime inside VS Code (ADR-0015). It supervises
// the runtime, answers its reverse calls with VS Code APIs, feeds it settings, keeps the
// active project in step with the open folder and Workspace Trust, and hosts the agent panel.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import {
  AppSettingsSchema,
  CompanionSkinSchema,
  LogLevelSchema,
  previewStatusEvent,
  RuntimeEventBaseSchema,
  UiStateSchema,
  type AppSettings,
  type LogLevel,
  type ModelInfo,
  type Project,
  type RuntimeStatusUpdate,
  type SecretRef,
  type UiState,
} from "@jesutobits/protocol";
import * as vscode from "vscode";
import { readRemix, withRemix } from "./host/look.js";
import type { PanelServices } from "./host/panel-messages.js";
import { createReverseHandler } from "./host/reverse-calls.js";
import { runtimeConfig } from "./host/runtime-config.js";
import { syncProject, type RuntimeCall } from "./host/workspace-project.js";
import { launchSpec } from "./runtime/launch.js";
import { RpcCallError } from "./runtime/connection.js";
import { RuntimeSupervisor } from "./runtime/supervisor.js";
import { AGENT_VIEW_ID, AgentViewProvider } from "./vscode/agent-view.js";
import { PreviewPanel } from "./vscode/preview-panel.js";
import { registerPresetStatus } from "./vscode/studio-commands.js";

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
  const currentSettings = (): AppSettings => {
    const skin = CompanionSkinSchema.safeParse(
      vscode.workspace.getConfiguration("jesutobits").get("companion.skin"),
    );
    return AppSettingsSchema.parse({
      ...currentConfig().settings,
      companion: { skin: skin.success ? skin.data : "buddy" },
    });
  };
  const openRouterRef = (): SecretRef =>
    `provider:openrouter:${currentSettings().providers.openrouter.profile}`;

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
    // A section names one setting (`jesutobits.…`), which Settings then shows on its own.
    openSettings: async (section) => {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        section?.startsWith("jesutobits.") ? `@id:${section}` : "jesutobits",
      );
    },
    projectRoot: () => project?.path,
    openFile: async (path, position) => {
      const at = position && new vscode.Position(position.line - 1, position.column - 1);
      await vscode.window.showTextDocument(vscode.Uri.file(path), {
        preview: true,
        ...(at && { selection: new vscode.Range(at, at) }),
      });
    },
    openExternal: async (url) => {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    },
    compose: async (text) => {
      panel.compose(text);
      await vscode.commands.executeCommand(`${AGENT_VIEW_ID}.focus`);
    },
    startProject: async (how) => {
      await vscode.commands.executeCommand(
        how === "open" ? "workbench.action.files.openFolder" : "jesutobits.newProject",
      );
    },
    look: {
      get: () => {
        const theme = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme", "");
        return { theme, remix: readRemix(colorCustomizations(), theme) };
      },
      setTheme: async (theme) => {
        await vscode.workspace
          .getConfiguration("workbench")
          .update("colorTheme", theme, vscode.ConfigurationTarget.Global);
      },
      remix: async (remix) => {
        const workbench = vscode.workspace.getConfiguration("workbench");
        const theme = workbench.get<string>("colorTheme", "");
        await workbench.update(
          "colorCustomizations",
          withRemix(colorCustomizations(), theme, remix),
          vscode.ConfigurationTarget.Global,
        );
      },
    },
    log,
  };
  const panel = new AgentViewProvider(context.extensionUri, services, () => ({
    status: runtime.status,
    project,
  }));
  const preview = new PreviewPanel(context.extensionUri, services, () => runtime.status);
  const startPreview = async () => {
    preview.show();
    try {
      await runtime.call("preview.start", {}, 150_000);
    } catch (error) {
      void vscode.window.showErrorMessage(`The preview could not start: ${errorText(error)}`);
    }
  };

  const status = vscode.window.createStatusBarItem(
    "jesutobits.runtime",
    vscode.StatusBarAlignment.Left,
    0,
  );
  status.name = "Jesutobits Runtime";
  registerPresetStatus(context);
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
        preview.post({ kind: "status", update });
      }),
    },
    {
      dispose: runtime.onEvent((event) => {
        const parsed = RuntimeEventBaseSchema.loose().safeParse(event);
        if (!parsed.success) return;
        panel.post({ kind: "event", event: parsed.data });
        preview.post({ kind: "event", event: parsed.data });
        // The agent started a preview: show it.
        const started = previewStatusEvent.payload.safeParse(parsed.data);
        if (started.success && started.data.status.state === "starting" && !preview.isOpen) {
          preview.show();
        }
      }),
    },
    context.secrets.onDidChange(() => panel.post({ kind: "secretsChanged" })),
    vscode.commands.registerCommand("jesutobits.restartRuntime", () => runtime.restart()),
    vscode.commands.registerCommand("jesutobits.showLog", () => output.show()),
    vscode.commands.registerCommand("jesutobits.openAgent", async () => {
      await vscode.commands.executeCommand(`${AGENT_VIEW_ID}.focus`);
    }),
    // True when a key was stored (the welcome popup shows the new state).
    vscode.commands.registerCommand("jesutobits.setApiKey", () =>
      services.secrets.prompt(openRouterRef()),
    ),
    // For the welcome popup: whether a key is stored, never the key (invariant 3).
    vscode.commands.registerCommand("jesutobits.hasApiKey", () =>
      services.secrets.exists(openRouterRef()),
    ),
    // For the welcome popup's first idea: fills the agent's message box; the user sends it.
    vscode.commands.registerCommand("jesutobits.compose", (text: unknown) =>
      typeof text === "string" && text.trim()
        ? services.compose(text.slice(0, 8000))
        : vscode.commands.executeCommand(`${AGENT_VIEW_ID}.focus`),
    ),
    vscode.commands.registerCommand("jesutobits.openPreview", startPreview),
    vscode.commands.registerCommand("jesutobits.getStarted", getStarted),
    vscode.commands.registerCommand("jesutobits.changeLook", async () => {
      await vscode.commands.executeCommand(`${AGENT_VIEW_ID}.focus`);
      panel.openLook();
    }),
    vscode.commands.registerCommand("jesutobits.chooseModel", () =>
      chooseModel(call, services.setDefaultModel, log),
    ),
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

/** The default model (FR-022): tools-capable models first, the rest marked Ask-only. */
async function chooseModel(
  call: RuntimeCall,
  save: (modelId: string) => Promise<void>,
  log: (level: LogLevel, message: string) => void,
): Promise<void> {
  let models: ModelInfo[];
  try {
    ({ models } = (await call("models.list", { refresh: false })) as { models: ModelInfo[] });
  } catch (error) {
    log("warn", `could not list models: ${String(error)}`);
    void vscode.window.showErrorMessage(
      "Jesutobits could not list OpenRouter's models. Check the API key and the connection.",
    );
    return;
  }
  const byName = (a: ModelInfo, b: ModelInfo) => a.displayName.localeCompare(b.displayName);
  const item = (model: ModelInfo): vscode.QuickPickItem & { id: string } => ({
    id: model.id,
    label: model.displayName,
    description: model.id,
    detail: [
      `${model.contextWindow.toLocaleString("en")} tokens`,
      model.pricing &&
        `USD ${model.pricing.inputPerMTok} / ${model.pricing.outputPerMTok} per million`,
      !model.capabilities.tools && "Ask mode only (no tools)",
    ]
      .filter(Boolean)
      .join(" · "),
  });
  const withTools = models.filter((model) => model.capabilities.tools).sort(byName);
  const without = models.filter((model) => !model.capabilities.tools).sort(byName);
  const picked = await vscode.window.showQuickPick(
    [
      ...withTools.map(item),
      ...(without.length > 0
        ? [{ label: "Ask mode only", kind: vscode.QuickPickItemKind.Separator, id: "" }]
        : []),
      ...without.map(item),
    ],
    { title: "Default model for new sessions", matchOnDescription: true, matchOnDetail: true },
  );
  if (picked?.id) await save(picked.id);
}

function errorText(error: unknown): string {
  if (error instanceof RpcCallError) return error.error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * The welcome popup is part of the Jesutobits app (jesutobits-ide patch 003); in plain VS Code,
 * where the extension is developed, the walkthrough stands in for it.
 */
async function getStarted(): Promise<void> {
  const commands = await vscode.commands.getCommands(true);
  if (commands.includes(WELCOME_POPUP_COMMAND)) {
    await vscode.commands.executeCommand(WELCOME_POPUP_COMMAND);
  } else {
    await vscode.commands.executeCommand(
      "workbench.action.openWalkthrough",
      "jesutobits.jesutobits#jesutobits.start",
      false,
    );
  }
}

/** Registered by the Jesutobits app's core (jesutobits-ide patch 003). */
const WELCOME_POPUP_COMMAND = "workbench.action.jesutobitsWelcome";

/** The user's `workbench.colorCustomizations` (global), which a theme remix adds to. */
function colorCustomizations(): Record<string, unknown> {
  const inspected = vscode.workspace
    .getConfiguration("workbench")
    .inspect<Record<string, unknown>>("colorCustomizations");
  return { ...(inspected?.globalValue ?? {}) };
}
