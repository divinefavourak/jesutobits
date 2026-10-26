import path from "node:path";
import {
  ErrorCodes,
  JesutobitsError,
  MAX_EDITOR_FILE_BYTES,
  type Project,
} from "@jesutobits/protocol";
import { homedir } from "node:os";
import {
  canonicalProjectPath,
  createProjectFolder,
  detectProject,
  detectToolchain,
  FileIndex,
  folderExists,
  searchText,
  prepareWorkspaceFolder,
  WorkspaceService,
  type WatchHandle,
} from "@jesutobits/services";
import type { Logger } from "@jesutobits/shared";
import type { EventBus } from "../events/event-bus.js";
import type { RpcServer } from "../rpc/server.js";
import type { Storage } from "../storage/storage.js";
import { ProjectStore } from "./project-store.js";

export interface ProjectsOptions {
  /** The bundled ripgrep (`--ripgrep`), for `fs.search`. */
  ripgrep?: string | undefined;
  /** Moves a confined absolute path to the OS trash through the Host (ADR-0014). */
  trash: (absolutePath: string) => Promise<void>;
  /** Shows a confined absolute path in the OS file manager through the Host. */
  reveal: (absolutePath: string) => Promise<void>;
  events: EventBus;
  log: Logger;
  /** Resolves once the database is open; rejects if it could not be opened. */
  storage: () => Promise<Storage>;
  now?: () => Date;
}

/** The open project: its files, watcher and quick-open index (one per window, FR-012). */
class ActiveProject {
  private indexing = true;

  private constructor(
    /** Replaced when its row changes (trust, last opened). */
    public project: Project,
    readonly workspace: WorkspaceService,
    readonly index: FileIndex,
    private readonly watcher: WatchHandle,
  ) {
    void index.ready.finally(() => {
      this.indexing = false;
    });
  }

  get isIndexing(): boolean {
    return this.indexing;
  }

  static async open(project: Project, options: ProjectsOptions): Promise<ActiveProject> {
    const log = options.log.child({ projectId: project.id });
    const workspace = await WorkspaceService.open({
      root: project.path,
      log,
      trash: options.trash,
      reveal: options.reveal,
    });
    // Both start in this tick, before the walk reads anything, so no change falls between.
    const index = FileIndex.build(workspace, log);
    const watcher = workspace.watch(
      (batch) => {
        options.events.emit(
          "fs.changed",
          { projectId: project.id, ...batch },
          {
            projectId: project.id,
          },
        );
        void index.apply(batch);
      },
      {
        onError: () =>
          options.events.emit(
            "runtime.warning",
            {
              message:
                "Jesutobits stopped noticing file changes in this project. Reopen the project to refresh.",
              code: "fs.watch_stopped",
            },
            { projectId: project.id },
          ),
      },
    );
    return new ActiveProject(project, workspace, index, watcher);
  }

  close(): void {
    this.watcher.close();
  }
}

/**
 * `projects.*` and `fs.*` (ARCHITECTURE.md section 6.3): recent projects in SQLite, and the
 * active project's files through WorkspaceService only (invariant 2).
 */
/** What the agent needs of the open project. */
export interface ActiveContext {
  project: Project;
  workspace: WorkspaceService;
  index: FileIndex;
}

export class Projects {
  private active: ActiveProject | undefined;
  private readonly now: () => Date;
  private readonly closeListeners = new Set<(projectId: string) => void>();

  constructor(private readonly options: ProjectsOptions) {
    this.now = options.now ?? (() => new Date());
  }

  get activeProject(): Project | undefined {
    return this.active?.project;
  }

  /** The open project with its WorkspaceService and file index, if one is open. */
  activeContext(): ActiveContext | undefined {
    const active = this.active;
    return active && { project: active.project, workspace: active.workspace, index: active.index };
  }

  /** Called with a project's ID just before it closes (the agent stops its turns). */
  onClose(listener: (projectId: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  register(server: RpcServer): void {
    server.register("projects.list", async () => {
      const store = await this.store();
      const projects = await Promise.all(
        store.list().map(async (project) => {
          const missing = !(await folderExists(project.path));
          if (missing !== project.missing) store.setMissing(project.id, missing);
          return { ...project, missing };
        }),
      );
      return { projects };
    });

    server.register("projects.open", async (params) => {
      const store = await this.store();
      let project: Project;
      if ("id" in params) {
        project = store.require(params.id);
        if (!(await folderExists(project.path))) {
          store.setMissing(project.id, true);
          throw new JesutobitsError(
            ErrorCodes.fsNotFound,
            `The folder for ${project.name} was not found`,
            {
              details: { projectId: project.id },
            },
          );
        }
      } else {
        const canonicalPath = await canonical(params.path);
        project =
          store.findByPath(canonicalPath) ??
          store.insert({
            path: canonicalPath,
            name: path.basename(canonicalPath) || canonicalPath,
            kind: "project",
            // A folder Jesutobits did not create asks for a decision (FR-006).
            trust: "unknown",
            createdByJesutobits: false,
          });
      }
      await this.activate(project);
      project = store.markOpened(project.id, this.now());
      this.setActiveProject(project);
      return { project, needsTrustDecision: project.trust === "unknown" };
    });

    server.register("projects.create", async (params) => {
      const store = await this.store();
      const folder = await createProjectFolder(params.parentDir, params.name, params.template);
      const canonicalPath = await canonical(folder);
      const existing = store.findByPath(canonicalPath);
      let project =
        existing ??
        store.insert({
          path: canonicalPath,
          name: params.name,
          kind: params.template === "general" ? "general" : "project",
          // Projects Jesutobits creates are trusted (SECURITY.md section 5.4).
          trust: "trusted",
          createdByJesutobits: true,
        });
      if (existing) project = store.setTrust(existing.id, "trusted");
      await this.activate(project);
      project = store.markOpened(project.id, this.now());
      this.setActiveProject(project);
      return { project };
    });

    server.register("projects.prepareWorkspaceFolder", async (params) => {
      const created = await prepareWorkspaceFolder(params.path);
      return { path: await canonical(params.path), created };
    });

    server.register("projects.close", () => {
      this.closeActive();
      return {};
    });

    server.register("projects.setTrust", async (params) => {
      const project = (await this.store()).setTrust(params.id, params.trust);
      if (this.active?.project.id === project.id) this.setActiveProject(project);
      return { project };
    });

    server.register("projects.remove", async (params) => {
      const store = await this.store();
      store.require(params.id);
      if (this.active?.project.id === params.id) this.closeActive();
      store.remove(params.id);
      return {};
    });

    server.register("projects.locate", async (params) => {
      const store = await this.store();
      store.require(params.id);
      const canonicalPath = await canonical(params.path);
      const other = store.findByPath(canonicalPath);
      if (other && other.id !== params.id) {
        throw new JesutobitsError(
          ErrorCodes.fsAlreadyExists,
          `${other.name} already uses that folder`,
          {
            details: { projectId: other.id },
          },
        );
      }
      const project = store.relocate(params.id, canonicalPath, path.basename(canonicalPath));
      return { project };
    });

    server.register("projects.detect", async () => {
      const active = this.requireActive();
      // CSS Modules and Tailwind's CSS import are found through the index; give its first
      // build a moment, but answer without it rather than wait on a huge project.
      await Promise.race([active.index.ready, new Promise((resolve) => setTimeout(resolve, 5000))]);
      return detectProject(active.workspace, active.isIndexing ? undefined : active.index);
    });

    server.register("toolchain.detect", async () => ({
      tools: await detectToolchain({ cwd: homedir() }),
    }));

    server.register("fs.listDir", async (params) => ({
      entries: await this.workspace().listDir(params.path),
    }));

    server.register("fs.stat", async (params) => this.workspace().stat(params.path));

    server.register("fs.readFile", async (params) =>
      this.workspace().readText(params.path, MAX_EDITOR_FILE_BYTES),
    );

    server.register("fs.writeFile", async (params) =>
      this.workspace().writeText(params.path, params.text, { expectedHash: params.expectedHash }),
    );

    server.register("fs.createFile", async (params) =>
      this.workspace().writeText(params.path, "", { expectedHash: null }),
    );

    server.register("fs.createDirectory", async (params) => {
      await this.workspace().createDirectory(params.path);
      return {};
    });

    server.register("fs.rename", async (params) => {
      await this.workspace().rename(params.from, params.to);
      return {};
    });

    server.register("fs.reveal", async (params) => {
      await this.workspace().reveal(params.path);
      return {};
    });

    server.register("fs.trash", async (params) => {
      await this.workspace().trash(params.path);
      return {};
    });

    server.register("fs.search", async (params) => {
      const active = this.requireActive();
      return searchText(
        {
          query: params.query,
          isRegex: params.isRegex,
          caseSensitive: params.caseSensitive,
          limit: params.limit,
          ...(params.glob !== undefined && { glob: params.glob }),
        },
        {
          workspace: active.workspace,
          ripgrep: this.options.ripgrep,
          files: () => active.index.list(),
        },
      );
    });

    server.register("fs.quickOpen", (params) => {
      const active = this.requireActive();
      return {
        results: active.index.query(params.query, params.limit, params.recent),
        indexing: active.isIndexing,
        complete: active.index.complete,
      };
    });
  }

  /** Stops watching the active project (shutdown). */
  closeActive(): void {
    const closing = this.active;
    if (!closing) return;
    for (const listener of this.closeListeners) {
      try {
        listener(closing.project.id);
      } catch (error) {
        this.options.log.error("a project close listener failed", { err: error });
      }
    }
    closing.close();
    this.active = undefined;
  }

  private async activate(project: Project): Promise<void> {
    // Open the new project first, so a failure leaves the current one open.
    const next = await ActiveProject.open(project, this.options);
    if (this.active?.project.id === project.id) {
      // Reopening the same project (after a runtime restart, say) keeps its turns.
      this.active.close();
      this.active = undefined;
    } else {
      this.closeActive();
    }
    this.active = next;
    this.options.log.info("project opened", { projectId: project.id });
  }

  private setActiveProject(project: Project): void {
    if (this.active) this.active.project = project;
  }

  private async store(): Promise<ProjectStore> {
    return new ProjectStore((await this.options.storage()).db);
  }

  private requireActive(): ActiveProject {
    if (!this.active) {
      throw new JesutobitsError(ErrorCodes.fsNoProject, "Open a project first");
    }
    return this.active;
  }

  private workspace(): WorkspaceService {
    return this.requireActive().workspace;
  }
}

async function canonical(input: string): Promise<string> {
  if (!(await folderExists(input))) {
    throw new JesutobitsError(ErrorCodes.fsNotFound, "That folder was not found", {
      details: { path: input },
    });
  }
  return canonicalProjectPath(input);
}
