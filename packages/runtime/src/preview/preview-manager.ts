import { join } from "node:path";
import { ErrorCodes, JesutobitsError, type PreviewStatus } from "@jesutobits/protocol";
import type { Logger } from "@jesutobits/shared";
import { isSecretPatternFile } from "../permissions/secret-patterns.js";
import {
  detectProject,
  freeLoopbackPort,
  startProcess,
  startStaticServer,
  waitForHttp,
  type FileIndex,
  type ProcessHandle,
  type StaticServer,
  type WorkspaceService,
} from "@jesutobits/services";

const MAX_LOG_LINES = 200;
const READY_TIMEOUT_MS = 90_000;
/** What the launcher prints for Jesutobits (packages/preview-launcher). */
const LAUNCHER_PREFIX = "@@jesutobits ";
/** A dev server announcing its address, as Vite, Next, CRA, Flask, Django and most others do. */
const URL_IN_OUTPUT = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)\/?\S*/;
/** "Listening on port 3000", as many backends say it instead. */
const PORT_IN_OUTPUT =
  /\b(?:listening|running|started|serving|server)\b.*\bport\s*:?\s*(\d{2,5})\b/i;
/** A program that printed no address by then is shown as its output instead. */
const QUIET_AFTER_MS = 12_000;

export interface PreviewProject {
  id: string;
  root: string;
  trusted: boolean;
  workspace: WorkspaceService;
  index: FileIndex | undefined;
  /** The start command saved for this project, if any. */
  savedCommand?: string[];
  saveCommand?(command: string[]): void;
}

export interface PreviewManagerOptions {
  /** dist/guest: preview-launcher.js and vite-plugin.mjs (shipped with the extension). */
  guestDir: string | undefined;
  emit(status: PreviewStatus): void;
  /** Masks secrets in dev-server output before it is kept or shown. */
  mask(text: string): string;
  log: Logger;
  /** How long a program may print no address before its output is the preview (tests). */
  quietAfterMs?: number;
}

interface Running {
  projectId: string;
  handle: ProcessHandle | undefined;
  server: StaticServer | undefined;
  publishTimer?: ReturnType<typeof setTimeout> | undefined;
  status: PreviewStatus;
  ready: Promise<PreviewStatus>;
  stopping: boolean;
}

/** What `start` runs: a folder to serve, or a program. `label` is shown as `command`. */
type Plan =
  | { strategy: "static"; staticRoot: string; label: string; detail: string | null }
  | {
      strategy: "vite-react" | "generic" | "command";
      argv: string[];
      label: string | null;
      detail: string | null;
    };

const STOPPED: PreviewStatus = {
  state: "stopped",
  strategy: null,
  command: null,
  url: null,
  detail: null,
  log: [],
};

/**
 * The active project's preview (ROADMAP Phase 4, VISUAL_EDITING.md section 4) on a free
 * loopback port. Vite React projects run through the preview launcher with the
 * visual-editing plugin (ADR-0009); others run their dev or start script; a plain site (an
 * `index.html`) is served by the static server with live reload; anything else runs the
 * start command the user or the agent gave, saved per project. A program that never prints
 * an address (a CLI, a game window) is shown as its output. One preview at a time; it stops
 * with its project.
 */
export class PreviewManager {
  private running: Running | undefined;

  constructor(private readonly options: PreviewManagerOptions) {}

  status(projectId: string | undefined): PreviewStatus {
    return this.running && this.running.projectId === projectId ? this.running.status : STOPPED;
  }

  /**
   * Starts the preview (or joins the one starting) and resolves once it answers, runs
   * without a page, or fails. A `command` (typed by the user or approved for the agent) is
   * saved for the project and replaces whatever runs.
   */
  async start(
    project: PreviewProject,
    options: { command?: string[] } = {},
  ): Promise<PreviewStatus> {
    if (
      options.command === undefined &&
      this.running?.projectId === project.id &&
      this.running.status.state !== "failed"
    ) {
      return this.running.ready;
    }
    await this.stop();
    if (!project.trusted) {
      throw new JesutobitsError(
        ErrorCodes.previewRestricted,
        "This folder is in Restricted Mode. Trust it to run its dev server.",
      );
    }
    if (options.command) project.saveCommand?.(options.command);
    const plan = await this.plan(project, options.command ?? project.savedCommand);

    const running: Running = {
      projectId: project.id,
      handle: undefined,
      server: undefined,
      status: {
        state: "starting",
        strategy: plan.strategy,
        command: plan.label,
        url: null,
        detail: plan.detail,
        log: [],
      },
      ready: Promise.resolve(STOPPED),
      stopping: false,
    };
    this.running = running;
    this.publish(running);
    const port = await freeLoopbackPort();

    if (plan.strategy === "static") {
      running.ready = (async () => {
        try {
          running.server = await startStaticServer(
            project.workspace,
            plan.staticRoot,
            port,
            (relative) => isSecretPatternFile(relative),
          );
        } catch (error) {
          return this.fail(running, error instanceof Error ? error.message : String(error));
        }
        running.status = { ...running.status, state: "ready", url: running.server.url };
        this.publish(running);
        this.options.log.info("preview ready", { url: running.server.url, strategy: "static" });
        return running.status;
      })();
      return running.ready;
    }

    const viteReact = plan.strategy === "vite-react";
    let announced: (url: string) => void = () => undefined;
    const urlAnnounced = new Promise<string>((resolve) => (announced = resolve));
    const onLine = (raw: string) => {
      // Colour codes would split an address ("localhost:" ESC[1m "5173") and show as junk.
      const line = withoutAnsi(raw);
      if (viteReact && line.startsWith(LAUNCHER_PREFIX)) {
        this.onLauncherMessage(running, line.slice(LAUNCHER_PREFIX.length), announced);
        return;
      }
      const masked = this.options.mask(line);
      running.status = {
        ...running.status,
        log: [...running.status.log, masked].slice(-MAX_LOG_LINES),
      };
      if (running.status.state === "running") this.publishSoon(running);
      if (!viteReact) {
        const url = addressIn(line);
        if (url) announced(url);
      }
    };

    const guest = this.options.guestDir ?? "";
    const argv = viteReact
      ? [
          "node",
          join(guest, "preview-launcher.js"),
          "--root",
          project.root,
          "--port",
          String(port),
          "--plugin",
          join(guest, "vite-plugin.mjs"),
        ]
      : plan.argv;

    running.ready = (async () => {
      try {
        running.handle = await startProcess(argv, {
          cwd: project.root,
          // NO_COLOR: most dev servers then print plain text (the rest is stripped).
          env: { PORT: String(port), HOST: "127.0.0.1", BROWSER: "none", NO_COLOR: "1" },
          onLine,
        });
      } catch (error) {
        return this.fail(running, error instanceof Error ? error.message : String(error));
      }
      void running.handle.exited.then((code) => {
        if (running.stopping || this.running !== running) return;
        this.fail(
          running,
          running.status.state === "running"
            ? `The program finished (exit code ${code ?? "none"}).`
            : `The dev server stopped (exit code ${code ?? "none"}).`,
        );
      });
      const exited = running.handle.exited.then(() => undefined);
      // Vite always announces itself; anything else may never print an address (a CLI, a
      // game window, a quiet backend): after a while its output becomes the preview.
      const quietAfter = this.options.quietAfterMs ?? QUIET_AFTER_MS;
      const quiet = sleep(viteReact ? READY_TIMEOUT_MS : quietAfter).then(() => "quiet" as const);
      const first = await Promise.race([urlAnnounced, exited, quiet]);
      if (running.status.state === "failed" || first === undefined) return running.status;
      if (first === "quiet") {
        if (viteReact) {
          await this.stopRunning(running);
          return this.fail(
            running,
            `The dev server did not report an address within ${READY_TIMEOUT_MS / 1000} s.`,
          );
        }
        running.status = { ...running.status, state: "running" };
        this.publish(running);
        // A server that prints its address later still becomes a page.
        void urlAnnounced.then((url) => this.whenAnswering(running, url));
        return running.status;
      }
      return this.whenAnswering(running, first);
    })();
    return running.ready;
  }

  /** Project files changed: a static site's open pages reload. */
  filesChanged(projectId: string): void {
    if (this.running?.projectId === projectId) this.running.server?.reload();
  }

  /** How to run this project: a saved or given command wins over what detection finds. */
  private async plan(project: PreviewProject, command: string[] | undefined): Promise<Plan> {
    if (command) {
      return { strategy: "command", argv: command, label: command.join(" "), detail: null };
    }
    const detection = await detectProject(project.workspace, project.index);
    if (
      detection.previewStrategy === "vite-react" &&
      detection.visualEditing.level !== "unavailable" &&
      this.options.guestDir !== undefined
    ) {
      return { strategy: "vite-react", argv: [], label: null, detail: null };
    }
    const script =
      detection.scripts.dev !== undefined
        ? "dev"
        : detection.scripts.start !== undefined
          ? "start"
          : undefined;
    if (script) {
      const argv = [detection.packageManager?.name ?? "npm", "run", script];
      return {
        strategy: "generic",
        argv,
        label: argv.join(" "),
        detail: detection.visualEditing.reason,
      };
    }
    if (detection.previewStrategy === "static" && detection.staticRoot != null) {
      return {
        strategy: "static",
        staticRoot: detection.staticRoot,
        label: detection.staticRoot === "" ? "." : detection.staticRoot,
        detail: null,
      };
    }
    throw new JesutobitsError(
      ErrorCodes.previewUnavailable,
      "Jesutobits does not know how to start this project yet. Type the command that starts it in the preview panel (for example python app.py), or ask the agent to start the preview.",
    );
  }

  /** The program announced an address: show it once it answers. */
  private async whenAnswering(running: Running, url: string): Promise<PreviewStatus> {
    try {
      await waitForHttp(url, READY_TIMEOUT_MS);
    } catch (error) {
      if (running.status.state === "running") return running.status;
      await this.stopRunning(running);
      return this.fail(running, error instanceof Error ? error.message : String(error));
    }
    if (this.running !== running || running.stopping) return running.status;
    running.status = { ...running.status, state: "ready", url };
    this.publish(running);
    this.options.log.info("preview ready", { url, strategy: running.status.strategy });
    return running.status;
  }

  /** Output of a page-less program, at most four times a second. */
  private publishSoon(running: Running): void {
    if (running.publishTimer) return;
    running.publishTimer = setTimeout(() => {
      running.publishTimer = undefined;
      if (this.running === running) this.publish(running);
    }, 250);
    running.publishTimer.unref();
  }

  async stop(): Promise<PreviewStatus> {
    const running = this.running;
    if (!running) return STOPPED;
    this.running = undefined;
    await this.stopRunning(running);
    this.options.emit(STOPPED);
    return STOPPED;
  }

  /** Stops the preview if it belongs to `projectId` (the project is closing). */
  async closeProject(projectId: string): Promise<void> {
    if (this.running?.projectId === projectId) await this.stop();
  }

  private async stopRunning(running: Running): Promise<void> {
    running.stopping = true;
    if (running.publishTimer) clearTimeout(running.publishTimer);
    await Promise.all([running.handle?.stop(), running.server?.close()]);
  }

  private onLauncherMessage(running: Running, json: string, announced: (url: string) => void) {
    let message: { event?: string; url?: string; message?: string };
    try {
      message = JSON.parse(json) as typeof message;
    } catch {
      return;
    }
    if (message.event === "ready" && typeof message.url === "string") {
      announced(message.url.replace("localhost", "127.0.0.1"));
    } else if (message.event === "error") {
      this.fail(running, message.message ?? "The preview launcher failed.");
    }
  }

  private fail(running: Running, detail: string): PreviewStatus {
    running.status = {
      ...running.status,
      state: "failed",
      url: null,
      detail: this.options.mask(detail),
    };
    if (this.running === running) this.publish(running);
    this.options.log.warn("preview failed", { detail: running.status.detail });
    return running.status;
  }

  private publish(running: Running): void {
    this.options.emit(running.status);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/** ANSI escape sequences: colours and cursor moves (CSI), and titles and links (OSC). */
const ANSI =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** A line as text: escape sequences removed. */
export function withoutAnsi(line: string): string {
  return line.replace(ANSI, "");
}

/** The loopback address a line announces, if any. */
function addressIn(line: string): string | undefined {
  const url = URL_IN_OUTPUT.exec(line);
  if (url) return url[0].replace(/localhost|0\.0\.0\.0/, "127.0.0.1");
  const port = PORT_IN_OUTPUT.exec(line);
  return port ? `http://127.0.0.1:${port[1]}/` : undefined;
}
