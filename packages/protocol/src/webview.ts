import { z } from "zod";
import { JesutobitsErrorDataSchema } from "./errors.js";
import { RuntimeEventBaseSchema } from "./events.js";
import { LogLevelSchema, RuntimeStatusUpdateSchema } from "./host.js";
import { ProjectSchema } from "./methods/projects.js";
import { SecretRefSchema } from "./reverse.js";
import { AppSettingsSchema, UiStateSchema } from "./settings.js";

/**
 * Messages between a Jesutobits webview and the VS Code extension (ADR-0015), which replace
 * the Tauri Workbench's IPC. The webview is untrusted UI: the extension checks every message
 * against these schemas, relays `call` only for Workbench-callable runtime methods, and
 * answers `host` only for the operations below (invariant 4, NFR-008).
 */

const CallIdSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** The colour themes the Jesutobits extension contributes (apps/vscode-extension/themes). */
export const StudioThemeSchema = z.enum([
  "Lavender dusk",
  "Matcha",
  "Ocean after hours",
  "Peach tea",
  "Daydream",
  "Paper & sage",
]);
export type StudioTheme = z.infer<typeof StudioThemeSchema>;

const HexColourSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** The four colours of a theme remix, as in the Studio design's theme picker. */
export const RemixSchema = z
  .object({
    accent: HexColourSchema,
    canvas: HexColourSchema,
    surfaces: HexColourSchema,
    text: HexColourSchema,
  })
  .strict();
export type Remix = z.infer<typeof RemixSchema>;

/** Operations the extension itself answers, with their params and results. */
export const WEBVIEW_HOST_OPS = {
  "settings.get": { params: z.object({}).strict(), result: AppSettingsSchema },
  /** Only the keys the panel changes; the extension writes them to VS Code settings. */
  "settings.update": {
    params: z
      .object({
        providers: z
          .object({
            openrouter: z.object({ defaultModel: z.string().min(1).nullable() }).strict(),
          })
          .strict(),
      })
      .strict(),
    result: AppSettingsSchema,
  },
  "uiState.get": { params: z.object({}).strict(), result: UiStateSchema },
  /** Replaces the given top-level keys; `null` removes one. `window` is not the panel's. */
  "uiState.update": {
    params: z.record(z.string().min(1).max(64), z.unknown()),
    result: UiStateSchema,
  },
  "secrets.exists": {
    params: z.object({ ref: SecretRefSchema }).strict(),
    result: z.object({ exists: z.boolean() }),
  },
  /**
   * Asks the user for the key in VS Code's password box, so the key never enters the webview
   * (invariant 3). `stored` is false when the user cancelled.
   */
  "secrets.prompt": {
    params: z.object({ ref: SecretRefSchema }).strict(),
    result: z.object({ stored: z.boolean() }),
  },
  "secrets.delete": {
    params: z.object({ ref: SecretRefSchema }).strict(),
    result: z.object({}),
  },
  /** Starts the runtime again (only acted on from `failed`). */
  "runtime.restart": { params: z.object({}).strict(), result: z.object({}) },
  /**
   * Opens a project file in VS Code's editor. The path is relative to the active project;
   * the extension refuses anything that resolves outside it.
   */
  "ui.openFile": {
    params: z
      .object({
        path: z.string().min(1).max(4096),
        /** 1-based; the editor reveals it when set. */
        line: z.number().int().min(1).optional(),
        column: z.number().int().min(1).optional(),
      })
      .strict(),
    result: z.object({}),
  },
  /**
   * Puts text in the agent panel's message box and focuses it, for the user to finish and
   * send ("Ask the agent about this element", FR-113). Never sends anything by itself.
   */
  "agent.compose": {
    params: z.object({ text: z.string().min(1).max(8000) }).strict(),
    result: z.object({}),
  },
  /** The workspace's look: VS Code's colour theme and a remix of it, if the panel made one. */
  "look.get": {
    params: z.object({}).strict(),
    result: z.object({ theme: z.string(), remix: RemixSchema.nullable() }),
  },
  /** Switches VS Code's colour theme to one of Jesutobits' Studio themes. */
  "look.setTheme": {
    params: z.object({ theme: StudioThemeSchema }).strict(),
    result: z.object({}),
  },
  /**
   * Fine-tunes the current theme's colours (`workbench.colorCustomizations` for that theme
   * only); `null` removes the remix. Only the workspace changes, never the user's project.
   */
  "look.remix": {
    params: z.object({ remix: RemixSchema.nullable() }).strict(),
    result: z.object({}),
  },
  /** Opens a running preview in the user's browser; loopback http URLs only. */
  "ui.openExternal": {
    params: z
      .object({
        url: z
          .string()
          .max(2048)
          .regex(/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}(\/|$)/),
      })
      .strict(),
    result: z.object({}),
  },
  /** Starts the user on a project: VS Code's Open Folder, or Jesutobits: New Project. */
  "ui.startProject": {
    params: z.object({ how: z.enum(["open", "new"]) }).strict(),
    result: z.object({}),
  },
  /** Opens VS Code's Settings editor filtered to Jesutobits' settings. */
  "ui.openSettings": {
    params: z.object({ section: z.string().max(64).optional() }).strict(),
    result: z.object({}),
  },
  log: {
    params: z.object({ level: LogLevelSchema, message: z.string().max(4000) }).strict(),
    result: z.object({}),
  },
} as const;

export type WebviewHostOp = keyof typeof WEBVIEW_HOST_OPS;
export type WebviewHostParams<Op extends WebviewHostOp> = z.input<
  (typeof WEBVIEW_HOST_OPS)[Op]["params"]
>;
export type WebviewHostResult<Op extends WebviewHostOp> = z.output<
  (typeof WEBVIEW_HOST_OPS)[Op]["result"]
>;

export const WebviewToHostSchema = z.discriminatedUnion("kind", [
  /** The webview loaded and listens; the extension sends status and project. */
  z.object({ kind: z.literal("ready") }).strict(),
  /** A runtime method, relayed only if Workbench-callable. */
  z
    .object({
      kind: z.literal("call"),
      id: CallIdSchema,
      method: z.string().min(1).max(64),
      params: z.unknown(),
    })
    .strict(),
  /** One of WEBVIEW_HOST_OPS. */
  z
    .object({
      kind: z.literal("host"),
      id: CallIdSchema,
      op: z.string().min(1).max(64),
      params: z.unknown(),
    })
    .strict(),
]);
export type WebviewToHost = z.infer<typeof WebviewToHostSchema>;

export const HostToWebviewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("result"), id: CallIdSchema, result: z.unknown() }).strict(),
  z
    .object({ kind: z.literal("error"), id: CallIdSchema, error: JesutobitsErrorDataSchema })
    .strict(),
  /** Loose: each event type's own fields pass through to its reducer, which validates them. */
  z.object({ kind: z.literal("event"), event: RuntimeEventBaseSchema.loose() }).strict(),
  z.object({ kind: z.literal("status"), update: RuntimeStatusUpdateSchema }).strict(),
  /** The active project changed, or was opened again after a runtime restart. */
  z.object({ kind: z.literal("project"), project: ProjectSchema.nullable() }).strict(),
  z.object({ kind: z.literal("settings"), settings: AppSettingsSchema }).strict(),
  /** A stored secret was set or removed (never which value): the panel checks again. */
  z.object({ kind: z.literal("secretsChanged") }).strict(),
  /** Text for the agent panel's message box (`agent.compose`); the user sends it. */
  z.object({ kind: z.literal("compose"), text: z.string().max(8000) }).strict(),
  /** Open the theme picker (Jesutobits: Change the Look). */
  z.object({ kind: z.literal("openLook") }).strict(),
]);
export type HostToWebview = z.infer<typeof HostToWebviewSchema>;
