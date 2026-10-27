import { join } from "node:path";
import { ErrorCodes, JesutobitsError, type PreviewStatus } from "@jesutobits/protocol";
import type { Logger } from "@jesutobits/shared";
import {
  detectProject,
  freeLoopbackPort,
  startProcess,
  waitForHttp,
  type FileIndex,
  type ProcessHandle,
  type WorkspaceService,
} from "@jesutobits/services";

const MAX_LOG_LINES = 200;
const READY_TIMEOUT_MS = 90_000;
/** What the launcher prints for Jesutobits (packages/preview-launcher). */
const LAUNCHER_PREFIX = "@@jesutobits ";
/** A dev server announcing its address, as Vite, Next, CRA and most others do. */
const URL_IN_OUTPUT = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)\/?\S*/;

export interface PreviewProject {
  id: string;
  root: string;
  trusted: boolean;
  workspace: WorkspaceService;
  index: FileIndex | undefined;
}

export interface PreviewManagerOptions {
  /** dist/guest: preview-launcher.js and vite-plugin.mjs (shipped with the extension). */
  guestDir: string | undefined;
  emit(status: PreviewStatus): void;
  /** Masks secrets in dev-server output before it is kept or shown. */
  mask(text: string): string;
  log: Logger;
}

interface Running {
  projectId: string;
  handle: ProcessHandle | undefined;
  status: PreviewStatus;
  ready: Promise<PreviewStatus>;
  stopping: boolean;
}

const STOPPED: PreviewStatus = {
  state: "stopped",
  strategy: null,
  url: null,
  detail: null,
  log: [],
};

/**
 * The active project's preview (ROADMAP Phase 4, VISUAL_EDITING.md section 4): its dev server
 * on a free loopback port. Vite React projects run through the preview launcher with the
 * visual-editing plugin (ADR-0009); anything else runs its dev or start script. One preview at
 * a time; it stops with its project.
 */
export class PreviewManager {
  private running: Running | undefined;

  constructor(private readonly options: PreviewManagerOptions) {}

  status(projectId: string | undefined): PreviewStatus {
    return this.running && this.running.projectId === projectId ? this.running.status : STOPPED;
  }

  /** Starts the preview (or joins the one starting) and resolves once it answers or fails. */
  async start(project: PreviewProject): Promise<PreviewStatus> {
    if (this.running?.projectId === project.id && this.running.status.state !== "failed") {
      return this.running.ready;
    }
    await this.stop();
    if (!project.trusted) {
      throw new JesutobitsError(
        ErrorCodes.previewRestricted,
        "This folder is in Restricted Mode. Trust it to run its dev server.",
      );
    }
    const detection = await detectProject(project.workspace, project.index);
    const viteReact =
      detection.previewStrategy === "vite-react" &&
      detection.visualEditing.level !== "unavailable" &&
      this.options.guestDir !== undefined;
    const script =
      detection.scripts.dev !== undefined
        ? "dev"
        : detection.scripts.start !== undefined
          ? "start"
          : undefined;
    if (!viteReact && script === undefined) {
      throw new JesutobitsError(
        ErrorCodes.previewUnavailable,
        "This project has no dev or start script to preview.",
      );
    }

    const running: Running = {
      projectId: project.id,
      handle: undefined,
      status: {
        state: "starting",
        strategy: viteReact ? "vite-react" : "generic",
        url: null,
        detail: viteReact ? null : detection.visualEditing.reason,
        log: [],
      },
      ready: Promise.resolve(STOPPED),
      stopping: false,
    };
    this.running = running;
    this.publish(running);

    const port = await freeLoopbackPort();
    let announced: (url: string) => void = () => undefined;
    const urlAnnounced = new Promise<string>((resolve) => (announced = resolve));
    const onLine = (line: string) => {
      if (viteReact && line.startsWith(LAUNCHER_PREFIX)) {
        this.onLauncherMessage(running, line.slice(LAUNCHER_PREFIX.length), announced);
        return;
      }
      const masked = this.options.mask(line);
      running.status = {
        ...running.status,
        log: [...running.status.log, masked].slice(-MAX_LOG_LINES),
      };
      if (!viteReact) {
        const match = URL_IN_OUTPUT.exec(line);
        if (match) announced(match[0].replace("localhost", "127.0.0.1"));
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
      : [detection.packageManager?.name ?? "npm", "run", script!];

    running.ready = (async () => {
      try {
        running.handle = await startProcess(argv, {
          cwd: project.root,
          env: { PORT: String(port), HOST: "127.0.0.1", BROWSER: "none" },
          onLine,
        });
      } catch (error) {
        return this.fail(running, error instanceof Error ? error.message : String(error));
      }
      void running.handle.exited.then((code) => {
        if (running.stopping || this.running !== running) return;
        this.fail(running, `The dev server stopped (exit code ${code ?? "none"}).`);
      });
      const exited = running.handle.exited.then(() => undefined);
      const url = await Promise.race([
        urlAnnounced,
        exited,
        sleep(READY_TIMEOUT_MS).then(() => undefined),
      ]);
      if (running.status.state === "failed") return running.status;
      if (url === undefined) {
        await this.stopRunning(running);
        return this.fail(
          running,
          `The dev server did not report an address within ${READY_TIMEOUT_MS / 1000} s.`,
        );
      }
      try {
        await waitForHttp(url, READY_TIMEOUT_MS);
      } catch (error) {
        await this.stopRunning(running);
        return this.fail(running, error instanceof Error ? error.message : String(error));
      }
      running.status = { ...running.status, state: "ready", url };
      this.publish(running);
      this.options.log.info("preview ready", { url, strategy: running.status.strategy });
      return running.status;
    })();
    return running.ready;
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
    await running.handle?.stop();
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
