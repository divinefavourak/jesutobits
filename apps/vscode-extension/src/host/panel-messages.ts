// What the extension does with a message from the agent panel's webview (ADR-0015). The
// webview is untrusted UI: every message is schema-checked, runtime calls are relayed only
// for Workbench-callable methods, and host operations only for WEBVIEW_HOST_OPS (invariant 4,
// NFR-008, NFR-024).
import {
  ErrorCodes,
  JesutobitsError,
  methodsCallableBy,
  toJesutobitsError,
  UiStateSchema,
  WEBVIEW_HOST_OPS,
  WebviewToHostSchema,
  type AppSettings,
  type HostToWebview,
  type LogLevel,
  type Remix,
  type SecretRef,
  type StudioTheme,
  type UiState,
  type WebviewHostOp,
} from "@jesutobits/protocol";
import { isAbsolute, relative, resolve } from "node:path";
import { RpcCallError } from "../runtime/connection.js";

export interface PanelServices {
  /** A runtime call through the supervisor. */
  call(method: string, params: unknown): Promise<unknown>;
  settings(): AppSettings;
  setDefaultModel(modelId: string | null): Promise<void>;
  uiState: { get(): UiState; set(state: UiState): Promise<void> };
  secrets: {
    exists(ref: SecretRef): Promise<boolean>;
    /** VS Code's password box; false when the user cancelled. */
    prompt(ref: SecretRef): Promise<boolean>;
    /** Sign in with OpenRouter in the browser; false when it was not finished. */
    signIn(ref: SecretRef): Promise<boolean>;
    delete(ref: SecretRef): Promise<void>;
  };
  restartRuntime(): void;
  openSettings(section: string | undefined): Promise<void>;
  /** The active project's folder; undefined with none open. */
  projectRoot(): string | undefined;
  /** Shows an absolute path, already confined to the project, in VS Code's editor. */
  openFile(path: string, position?: { line: number; column: number }): Promise<void>;
  /** Opens an already-checked loopback URL in the user's browser. */
  openExternal(url: string): Promise<void>;
  /** Fills and focuses the agent panel's message box. */
  compose(text: string): Promise<void>;
  /** Goes to one of the Studio's places (ui.navigate). */
  navigate(to: "recent" | "learning" | "look" | "getStarted" | "agent"): Promise<void>;
  /** Runs Open Folder, or Jesutobits: New Project. */
  startProject(how: "open" | "new"): Promise<void>;
  /** The workspace's colour theme and its remix (the panel's theme picker). */
  look: {
    get(): { theme: string; remix: Remix | null };
    setTheme(theme: StudioTheme): Promise<void>;
    remix(remix: Remix | null): Promise<void>;
  };
  log(level: LogLevel, message: string): void;
}

/** "ready" tells the caller to send the current status, project and settings. */
export type PanelOutcome = { kind: "ready" } | HostToWebview | undefined;

const WORKBENCH_METHODS: ReadonlySet<string> = new Set(methodsCallableBy("workbench"));

export async function handlePanelMessage(
  data: unknown,
  services: PanelServices,
): Promise<PanelOutcome> {
  const parsed = WebviewToHostSchema.safeParse(data);
  if (!parsed.success) {
    services.log("warn", "ignored a malformed message from the agent panel");
    return undefined;
  }
  const message = parsed.data;
  if (message.kind === "ready") return { kind: "ready" };

  try {
    const result =
      message.kind === "call"
        ? await relay(message.method, message.params, services)
        : await hostOp(message.op, message.params, services);
    return { kind: "result", id: message.id, result };
  } catch (error) {
    const cause = error instanceof RpcCallError ? error.error : error;
    return { kind: "error", id: message.id, error: toJesutobitsError(cause).toData() };
  }
}

async function relay(method: string, params: unknown, services: PanelServices): Promise<unknown> {
  if (!WORKBENCH_METHODS.has(method)) {
    throw new JesutobitsError(
      ErrorCodes.rpcMethodNotAllowed,
      `${method} is not callable from the agent panel`,
    );
  }
  return services.call(method, params ?? {});
}

async function hostOp(op: string, params: unknown, services: PanelServices): Promise<unknown> {
  if (!Object.hasOwn(WEBVIEW_HOST_OPS, op)) {
    throw new JesutobitsError(ErrorCodes.rpcMethodNotFound, `The extension has no ${op}`);
  }
  const parsed = WEBVIEW_HOST_OPS[op as WebviewHostOp].params.safeParse(params);
  if (!parsed.success) {
    throw new JesutobitsError(ErrorCodes.rpcInvalidParams, `Invalid params for ${op}`);
  }
  const input = parsed.data as Record<string, unknown>;
  switch (op as WebviewHostOp) {
    case "settings.get":
      return services.settings();
    case "settings.update": {
      const patch = input as { providers: { openrouter: { defaultModel: string | null } } };
      await services.setDefaultModel(patch.providers.openrouter.defaultModel);
      return services.settings();
    }
    case "uiState.get":
      return services.uiState.get();
    case "uiState.update": {
      const next: Record<string, unknown> = { ...services.uiState.get() };
      for (const [key, value] of Object.entries(input)) {
        if (key === "window" || key === "schemaVersion") {
          throw new JesutobitsError(
            ErrorCodes.storageInvalidSettings,
            `${key} cannot be changed by the panel`,
          );
        }
        if (value === null) delete next[key];
        else next[key] = value;
      }
      const state = UiStateSchema.safeParse(next);
      if (!state.success) {
        throw new JesutobitsError(ErrorCodes.storageInvalidSettings, "Invalid panel state");
      }
      await services.uiState.set(state.data);
      return state.data;
    }
    case "secrets.exists":
      return { exists: await services.secrets.exists(input.ref as SecretRef) };
    case "secrets.prompt":
      return { stored: await services.secrets.prompt(input.ref as SecretRef) };
    case "secrets.signIn":
      return { stored: await services.secrets.signIn(input.ref as SecretRef) };
    case "secrets.delete":
      await services.secrets.delete(input.ref as SecretRef);
      return {};
    case "runtime.restart":
      services.restartRuntime();
      return {};
    case "ui.openSettings":
      await services.openSettings(input.section as string | undefined);
      return {};
    case "ui.openFile": {
      const root = services.projectRoot();
      if (root === undefined) {
        throw new JesutobitsError(ErrorCodes.fsNoProject, "No project is open");
      }
      const line = input.line as number | undefined;
      await services.openFile(
        confine(root, input.path as string),
        line === undefined
          ? undefined
          : { line, column: (input.column as number | undefined) ?? 1 },
      );
      return {};
    }
    case "ui.openExternal":
      await services.openExternal(input.url as string);
      return {};
    case "agent.compose":
      await services.compose(input.text as string);
      return {};
    case "ui.navigate":
      await services.navigate(input.to as "recent" | "learning" | "look" | "getStarted" | "agent");
      return {};
    case "ui.startProject":
      await services.startProject(input.how as "open" | "new");
      return {};
    case "look.get":
      return services.look.get();
    case "look.setTheme":
      await services.look.setTheme(input.theme as StudioTheme);
      return {};
    case "look.remix":
      await services.look.remix(input.remix as Remix | null);
      return {};
    case "log":
      services.log(input.level as LogLevel, `[panel] ${String(input.message)}`);
      return {};
  }
}

/** `path` (relative to the project) as an absolute path, refused if it leaves `root`. */
function confine(root: string, path: string): string {
  const target = resolve(root, path);
  const inside = relative(resolve(root), target);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new JesutobitsError(ErrorCodes.fsOutsideWorkspace, "The path is outside the project");
  }
  return target;
}
