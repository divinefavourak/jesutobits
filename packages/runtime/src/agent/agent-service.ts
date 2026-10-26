import { homedir } from "node:os";
import { join } from "node:path";
import {
  ErrorCodes,
  JesutobitsError,
  TRANSIENT_EVENT_TYPES,
  isFinalTurnState,
  type EventCorrelation,
  type EventPayload,
  type EventType,
  type ModelInfo,
  type Session,
  type SecretRef,
} from "@jesutobits/protocol";
import { searchText, type WorkspaceService } from "@jesutobits/services";
import type { Logger } from "@jesutobits/shared";
import { Checkpoints } from "../checkpoints/checkpoints.js";
import { systemClock, type Clock } from "../clock.js";
import type { RuntimeConfig } from "../config.js";
import { ContextBuilder } from "../context/context-builder.js";
import { TokenEstimator } from "../context/token-estimator.js";
import type { EventBus } from "../events/event-bus.js";
import type { SecretRegistry } from "../log/secret-registry.js";
import { PermissionBroker } from "../permissions/broker.js";
import { policyColumn } from "../permissions/policy.js";
import { CredentialClient } from "../providers/credentials.js";
import { ModelCache } from "../providers/model-cache.js";
import { OpenRouterProvider, OPENROUTER_BASE_URL } from "../providers/openrouter/openrouter.js";
import { ProviderCaller } from "../providers/provider-caller.js";
import { readCassetteFile } from "../providers/scripted/cassette-file.js";
import { SCRIPTED_MODEL, ScriptedProvider } from "../providers/scripted/scripted-provider.js";
import type { ModelProvider } from "../providers/types.js";
import type { ActiveContext, Projects } from "../projects/projects.js";
import { ProjectStore } from "../projects/project-store.js";
import type { RpcServer } from "../rpc/server.js";
import { SessionStore } from "../sessions/session-store.js";
import { FileBlobStore, MemoryBlobStore, type BlobStore } from "../storage/blob-store.js";
import type { Storage } from "../storage/storage.js";
import type { ReadTracker } from "../tools/common/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolRunner } from "../tools/runner.js";
import { AgentTurn } from "./agent-turn.js";
import { PROMPT_VERSION } from "./prompts/system.js";

export interface AgentEnvironment {
  /** `JESUTOBITS_PROVIDER`: `scripted` replays `cassette` instead of calling OpenRouter. */
  provider?: string | undefined;
  cassette?: string | undefined;
  /** `JESUTOBITS_OPENROUTER_URL`: a local mock server for tests; loopback URLs only. */
  openRouterUrl?: string | undefined;
  /** The bundled ripgrep (`--ripgrep`); without it text search uses the JS fallback. */
  ripgrep?: string | undefined;
}

export interface AgentServiceOptions {
  events: EventBus;
  projects: Projects;
  storage(): Promise<Storage>;
  config: RuntimeConfig;
  secrets: SecretRegistry;
  /** `host.secrets.get`. */
  fetchSecret(ref: SecretRef): Promise<string | null>;
  log: Logger;
  /** Where checkpoint blobs go; in memory without one. */
  dataDir: string | undefined;
  env: AgentEnvironment;
  clock?: Clock;
  /** Tests inject a provider directly. */
  provider?: ModelProvider;
}

/** Used when the provider's list does not know the model (offline, a new model). */
function unknownModel(id: string): ModelInfo {
  return {
    id,
    displayName: id,
    contextWindow: 64_000,
    maxOutputTokens: 8192,
    capabilities: {
      tools: true,
      toolChoice: true,
      parallelToolCalls: false,
      vision: false,
      structuredOutputs: false,
      reasoning: false,
    },
    source: "override",
  };
}

/** True for http(s) URLs on this machine only, so tests cannot redirect a real key elsewhere. */
function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * The agent's RPC surface (ARCHITECTURE.md section 6.3: sessions, agent, permissions,
 * checkpoints, models) and the turns running for the active project.
 */
export class AgentService {
  private readonly clock: Clock;
  private readonly provider: ModelProvider;
  private readonly credentials: CredentialClient | undefined;
  private readonly caller: ProviderCaller;
  private readonly registry = new ToolRegistry();
  private readonly estimator = new TokenEstimator();
  private readonly contextBuilder: ContextBuilder;
  private readonly turns = new Map<string, AgentTurn>();
  private readonly reads = new Map<string, Map<string, string>>();
  private readonly touched = new Map<string, Set<string>>();
  private mapCache: { projectId: string; counter: number; map: string | undefined } | undefined;
  private parts: Promise<Parts> | undefined;

  constructor(private readonly options: AgentServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.contextBuilder = new ContextBuilder(this.estimator);
    const scripted = options.env.provider === "scripted";
    if (options.provider) {
      this.provider = options.provider;
    } else if (scripted) {
      this.provider = new ScriptedProvider(
        options.env.cassette ? readCassetteFile(options.env.cassette) : [],
        { clock: this.clock },
      );
    } else {
      this.credentials = new CredentialClient(
        `provider:openrouter:${options.config.settings.providers.openrouter.profile}` as SecretRef,
        options.fetchSecret,
        options.secrets,
      );
      const url = options.env.openRouterUrl;
      const credentials = this.credentials;
      this.provider = new OpenRouterProvider({
        getCredential: () => credentials.get(),
        baseUrl: url && isLoopback(url) ? url : OPENROUTER_BASE_URL,
        clock: this.clock,
        get attribution() {
          return options.config.settings.privacy.providerAttributionHeaders;
        },
      });
    }
    this.caller = new ProviderCaller({
      provider: this.provider,
      clock: this.clock,
      ...(this.credentials && {
        invalidateCredential: () => this.credentials?.invalidate(),
      }),
    });
  }

  register(server: RpcServer): void {
    // Sessions.
    server.register("sessions.list", async (params) => {
      const { store, project } = await this.forProject();
      return { sessions: store.list(project.id, params.includeArchived) };
    });
    server.register("sessions.create", async (params) => {
      const { store, project } = await this.forProject();
      const modelId = params.modelId ?? this.defaultModel();
      const session = store.create(project.id, {
        providerId: this.provider.id,
        modelId,
        ...(params.title !== undefined && { title: params.title }),
      });
      return { session };
    });
    server.register("sessions.get", async (params) => {
      const { store, project } = await this.forProject();
      const session = store.require(project.id, params.id);
      const live = this.liveTurnOf(session.id);
      return {
        session,
        activeTurn:
          live && live.currentState ? { turnId: live.id as never, state: live.currentState } : null,
      };
    });
    server.register("sessions.history", async (params) => {
      const { store, project } = await this.forProject();
      store.require(project.id, params.id);
      return store.history(params.id, params.after, params.limit);
    });
    server.register("sessions.rename", async (params) => {
      const { store, project } = await this.forProject();
      return {
        session: this.updated(store.update(project.id, params.id, { title: params.title })),
      };
    });
    server.register("sessions.archive", async (params) => {
      const { store, project } = await this.forProject();
      return {
        session: this.updated(store.update(project.id, params.id, { archived: params.archived })),
      };
    });
    server.register("sessions.delete", async (params) => {
      const { store, project, checkpoints } = await this.forProject();
      if (this.liveTurnOf(params.id))
        throw this.turnState("Stop the turn before deleting the session");
      store.delete(project.id, params.id);
      this.reads.delete(params.id);
      this.touched.delete(params.id);
      checkpoints.sweep();
      return {};
    });

    // The agent.
    server.register("agent.sendMessage", async (params) => {
      const { store, project } = await this.forProject();
      const session = store.require(project.id, params.sessionId);
      this.assertIdle(session.id);
      const model = await this.modelInfo(session.modelId);
      if (params.mode === "agent" && !model.capabilities.tools) {
        throw new JesutobitsError(
          ErrorCodes.providerModelUnsupported,
          `${model.displayName} cannot use tools, so it can only answer in Ask mode`,
          { userAction: "open_settings", details: { modelId: model.id } },
        );
      }
      if (session.title === "New session" && store.messages(session.id).length === 0) {
        this.updated(
          store.update(project.id, session.id, {
            title: titleFrom(this.options.secrets.mask(params.text)),
          }),
        );
      }
      const record = store.createTurn({
        sessionId: session.id,
        mode: params.mode,
        modelId: session.modelId,
        promptVersion: PROMPT_VERSION,
      });
      const message = store.appendMessage(session.id, {
        turnId: record.id,
        role: "user",
        message: { role: "user", content: [{ type: "text", text: params.text }] },
      });
      this.emit(
        "turn.started",
        {
          mode: params.mode,
          modelId: session.modelId,
          message: { id: message.id as never, text: params.text },
        },
        { projectId: project.id, sessionId: session.id, turnId: record.id },
      );
      await this.start(record.id, session, params.mode, model);
      return { turnId: record.id as never };
    });
    server.register("agent.retryTurn", async (params) => {
      const { store, project } = await this.forProject();
      const old = this.ownTurn(store, project.id, params.turnId);
      if (old.state !== "failed" && old.state !== "interrupted") {
        throw this.turnState("Only a failed or interrupted turn can be retried");
      }
      const session = store.require(project.id, old.sessionId);
      this.assertIdle(session.id);
      const model = await this.modelInfo(session.modelId);
      const record = store.createTurn({
        sessionId: session.id,
        mode: old.mode,
        modelId: session.modelId,
        promptVersion: PROMPT_VERSION,
        retryOf: old.id,
      });
      this.emit(
        "turn.started",
        { mode: old.mode, modelId: session.modelId, retryOf: old.id as never },
        { projectId: project.id, sessionId: session.id, turnId: record.id },
      );
      await this.start(record.id, session, old.mode, model);
      return { turnId: record.id as never };
    });
    server.register("agent.cancelTurn", (params) => {
      this.turns.get(params.turnId)?.cancel();
      return {};
    });
    server.register("agent.pauseTurn", (params) => {
      this.liveTurn(params.turnId).pause();
      return {};
    });
    server.register("agent.resumeTurn", (params) => {
      if (!this.liveTurn(params.turnId).resumeTurn())
        throw this.turnState("The turn is not paused");
      return {};
    });
    server.register("agent.answerQuestion", (params) => {
      for (const turn of this.turns.values()) {
        if (turn.answer(params.questionId, params.answer)) return {};
      }
      throw new JesutobitsError(
        ErrorCodes.runtimeQuestionNotPending,
        "That question is no longer waiting for an answer",
        { details: { questionId: params.questionId } },
      );
    });
    server.register("agent.setModel", async (params) => {
      const { store, project } = await this.forProject();
      return {
        session: this.updated(
          store.update(project.id, params.sessionId, { modelId: params.modelId }),
        ),
      };
    });

    // Permissions.
    server.register("permissions.respond", async (params) => {
      const { broker } = await this.parts_();
      broker.respond(params.permissionId, params.decision, params.message);
      return {};
    });
    server.register("permissions.listRules", async () => {
      const { broker, project } = await this.forProject();
      return { rules: broker.listRules(project.id) };
    });
    server.register("permissions.removeRule", async (params) => {
      const { broker, project } = await this.forProject();
      broker.removeRule(project.id, params.id);
      return {};
    });
    server.register("permissions.getPolicy", async () => {
      const { projectStore, project } = await this.forProject();
      return {
        preset: projectStore.policyPreset(project.id),
        restricted: project.trust !== "trusted",
      };
    });
    server.register("permissions.setPolicy", async (params) => {
      const { projectStore, project } = await this.forProject();
      projectStore.setPolicyPreset(project.id, params.preset);
      return { preset: params.preset, restricted: project.trust !== "trusted" };
    });

    // Checkpoints (ADR-0012).
    server.register("checkpoints.listForTurn", async (params) => {
      const { store, project, checkpoints, context } = await this.forProject();
      this.ownTurn(store, project.id, params.turnId);
      return { files: await checkpoints.list(context.workspace, params.turnId) };
    });
    server.register("checkpoints.revertTurn", async (params) => {
      const { store, project, checkpoints, context } = await this.forProject();
      this.ownTurn(store, project.id, params.turnId);
      if (this.turns.has(params.turnId)) throw this.turnState("Stop the turn before reverting it");
      return checkpoints.revert(context.workspace, params.turnId, { force: params.force });
    });
    server.register("checkpoints.revertFile", async (params) => {
      const { store, project, checkpoints, context } = await this.forProject();
      this.ownTurn(store, project.id, params.turnId);
      if (this.turns.has(params.turnId)) throw this.turnState("Stop the turn before reverting it");
      const { relative } = await context.workspace.resolve(params.path);
      return checkpoints.revert(context.workspace, params.turnId, {
        paths: [relative],
        force: params.force ? [relative] : [],
      });
    });

    // Models.
    server.register("models.list", async (params) => this.listModels(params.refresh));
    server.register("models.testConnection", async () => {
      // The user may have just saved a new key.
      this.credentials?.invalidate();
      const result = await this.provider.testConnection();
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    });

    this.options.projects.onClose((projectId) => {
      for (const turn of this.turns.values()) {
        if (this.turnProject.get(turn.id) === projectId) turn.cancel();
      }
    });
  }

  /**
   * After the database opens: turns that were live when the runtime died are marked
   * interrupted (FR-041), their approvals withdrawn, and stray checkpoint blobs swept.
   */
  async recover(): Promise<void> {
    const { store, checkpoints } = await this.parts_();
    for (const turn of store.interruptLiveTurns()) {
      this.emit("turn.interrupted", {}, turn);
      this.options.log.info("turn interrupted by a restart", { turnId: turn.turnId });
    }
    const removed = checkpoints.sweep();
    if (removed > 0) this.options.log.info("checkpoint blobs swept", { removed });
  }

  /** Shutdown: stop every turn; their stores record the cancellation. */
  stopAll(): void {
    for (const turn of this.turns.values()) turn.cancel();
  }

  // Internals.

  private readonly turnProject = new Map<string, string>();

  private async start(
    turnId: string,
    session: Session,
    mode: "agent" | "ask",
    model: ModelInfo,
  ): Promise<void> {
    const parts = await this.parts_();
    const context = this.requireContext();
    const { project } = context;
    const reads = this.readsOf(session.id);
    let touched = this.touched.get(session.id);
    if (!touched) {
      touched = new Set();
      this.touched.set(session.id, touched);
    }
    const settings = this.options.config.settings;
    const turn = new AgentTurn(
      {
        store: parts.store,
        emit: (type, payload, correlation) => this.emit(type, payload, correlation),
        caller: this.caller,
        contextBuilder: this.contextBuilder,
        estimator: this.estimator,
        registry: this.registry,
        runner: parts.runner,
        checkpoints: parts.checkpoints,
        workspace: context.workspace,
        files: context.index,
        settings,
        prohibited: this.prohibited(),
        secrets: this.options.secrets,
        clock: this.clock,
        log: this.options.log.child({ turnId }),
        model,
        project: {
          id: project.id,
          name: project.name,
          root: project.path,
          kind: project.kind,
          trusted: project.trust === "trusted",
        },
        reads,
        touched,
        projectMap: () => this.projectMap(context),
        searchText: (query, signal) =>
          searchText(query, {
            workspace: context.workspace,
            ripgrep: this.options.env.ripgrep,
            files: () => context.index.list(),
            signal,
          }),
      },
      turnId,
      session.id,
      mode,
      session.costUsd,
    );
    this.turns.set(turnId, turn);
    this.turnProject.set(turnId, project.id);
    void turn.run().finally(() => {
      this.turns.delete(turnId);
      this.turnProject.delete(turnId);
      const updated = parts.store.get(project.id, session.id);
      if (updated) this.updated(updated);
    });
  }

  private emit<T extends EventType>(
    type: T,
    payload: EventPayload<T>,
    correlation: EventCorrelation = {},
  ): void {
    this.options.events.emit(type, payload, correlation);
  }

  private updated(session: Session): Session {
    this.emit(
      "session.updated",
      { session },
      { projectId: session.projectId, sessionId: session.id },
    );
    return session;
  }

  private defaultModel(): string {
    const configured = this.options.config.settings.providers.openrouter.defaultModel;
    if (configured) return configured;
    if (this.provider instanceof ScriptedProvider) return SCRIPTED_MODEL.id;
    throw new JesutobitsError(
      ErrorCodes.providerNoModel,
      "Choose a model in Settings > Models & providers first",
      {
        userAction: "open_settings",
      },
    );
  }

  private async listModels(
    refresh: boolean,
  ): Promise<{ models: ModelInfo[]; fetchedAt: string | null }> {
    const { storage } = await this.parts_();
    const cache = new ModelCache(storage.db, this.clock);
    const cached = refresh ? undefined : cache.get(this.provider.id);
    if (cached) return cached;
    let models: ModelInfo[];
    try {
      models = await this.provider.listModels();
    } catch (error) {
      const message =
        error && typeof error === "object" && "message" in error
          ? String(error.message)
          : "The model list could not be loaded";
      throw new JesutobitsError(ErrorCodes.providerUnavailable, message, {
        retryable: true,
        userAction: "retry",
      });
    }
    return cache.put(this.provider.id, models);
  }

  private async modelInfo(modelId: string): Promise<ModelInfo> {
    try {
      const { models } = await this.listModels(false);
      return models.find((model) => model.id === modelId) ?? unknownModel(modelId);
    } catch {
      // Offline or no key yet: the turn itself reports the provider's error.
      return unknownModel(modelId);
    }
  }

  private prohibited() {
    return {
      appDirs: [
        ...(this.options.dataDir ? [this.options.dataDir] : []),
        ...this.options.config.appDirs,
      ],
      home: homedir(),
    };
  }

  private readsOf(sessionId: string): ReadTracker {
    let map = this.reads.get(sessionId);
    if (!map) {
      map = new Map();
      this.reads.set(sessionId, map);
    }
    const reads = map;
    return {
      get: (path) => reads.get(path),
      set: (path, hash) => void reads.set(path, hash),
      forget: (path) => void reads.delete(path),
    };
  }

  /** A depth-2 tree of the project, refreshed when enough files changed (section 4.1). */
  private async projectMap(context: ActiveContext): Promise<string | undefined> {
    const counter = context.workspace.changeCounter;
    const cached = this.mapCache;
    if (cached && cached.projectId === context.project.id && counter - cached.counter < 20)
      return cached.map;
    const map = await buildProjectMap(context.workspace).catch(() => undefined);
    this.mapCache = { projectId: context.project.id, counter, map };
    return map;
  }

  private assertIdle(sessionId: string): void {
    if (this.liveTurnOf(sessionId)) {
      throw new JesutobitsError(
        ErrorCodes.runtimeTurnActive,
        "The agent is still working in this session. Stop it or wait for it to finish.",
        { details: { sessionId } },
      );
    }
  }

  private liveTurnOf(sessionId: string): AgentTurn | undefined {
    return [...this.turns.values()].find((turn) => turn.sessionId === sessionId);
  }

  private liveTurn(turnId: string): AgentTurn {
    const turn = this.turns.get(turnId);
    if (!turn || (turn.currentState && isFinalTurnState(turn.currentState))) {
      throw this.turnState("That turn is not running");
    }
    return turn;
  }

  private ownTurn(store: SessionStore, projectId: string, turnId: string) {
    const turn = store.turn(turnId);
    if (!turn || store.projectOfTurn(turnId) !== projectId) {
      throw new JesutobitsError(ErrorCodes.runtimeTurnNotFound, "That turn does not exist", {
        details: { turnId },
      });
    }
    return turn;
  }

  private turnState(message: string): JesutobitsError {
    return new JesutobitsError(ErrorCodes.runtimeTurnState, message);
  }

  private requireContext(): ActiveContext {
    const context = this.options.projects.activeContext();
    if (!context) throw new JesutobitsError(ErrorCodes.fsNoProject, "Open a project first");
    return context;
  }

  private async forProject() {
    const parts = await this.parts_();
    const context = this.requireContext();
    return { ...parts, context, project: context.project };
  }

  /** The database-backed parts, made once the database is open. */
  private parts_(): Promise<Parts> {
    this.parts ??= this.options.storage().then((storage) => this.makeParts(storage));
    return this.parts;
  }

  private makeParts(storage: Storage): Parts {
    const db = storage.db;
    const store = new SessionStore(db, undefined, (value) => this.options.secrets.maskValue(value));
    const projectStore = new ProjectStore(db);
    const blobs: BlobStore = this.options.dataDir
      ? new FileBlobStore(join(this.options.dataDir, "checkpoints"))
      : new MemoryBlobStore();
    const checkpoints = new Checkpoints(db, blobs);
    const broker = new PermissionBroker({
      db,
      emit: (type, payload, correlation) => {
        this.emit(type, payload, correlation);
        const turnId = correlation.turnId;
        if (turnId)
          this.turns
            .get(turnId)
            ?.onPermission(type === "permission.requested" ? "requested" : "resolved");
      },
      column: (projectId) => {
        const project = projectStore.get(projectId);
        return policyColumn(projectStore.policyPreset(projectId), project?.trust === "trusted");
      },
    });
    const runner = new ToolRunner({
      registry: this.registry,
      broker,
      db,
      emit: (type, payload, correlation) => this.emit(type, payload, correlation),
      log: this.options.log.child({ module: "tools" }),
      mask: (value) => this.options.secrets.maskValue(value),
      clock: this.clock,
    });
    // Agent events are stored with their session, except deltas (DATA_AND_PERSISTENCE.md 4).
    this.options.events.onEmit((event) => {
      if (event.sessionId && !TRANSIENT_EVENT_TYPES.has(event.type)) {
        try {
          store.appendEvent(event as never);
        } catch (error) {
          this.options.log.error("could not store an event", { type: event.type, err: error });
        }
      }
    });
    return { storage, store, projectStore, checkpoints, broker, runner };
  }
}

interface Parts {
  storage: Storage;
  store: SessionStore;
  projectStore: ProjectStore;
  checkpoints: Checkpoints;
  broker: PermissionBroker;
  runner: ToolRunner;
}

function titleFrom(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}...` : line || "New session";
}

const MAP_ENTRIES = 300;

async function buildProjectMap(workspace: WorkspaceService): Promise<string> {
  const lines: string[] = [];
  for (const entry of await workspace.listDir("")) {
    if (lines.length >= MAP_ENTRIES) break;
    if (entry.ignored) continue;
    lines.push(entry.kind === "directory" ? `${entry.name}/` : entry.name);
    if (entry.kind === "directory" && !entry.outside) {
      const children = await workspace.listDir(entry.path).catch(() => []);
      for (const child of children) {
        if (lines.length >= MAP_ENTRIES) break;
        if (child.ignored) continue;
        lines.push(`  ${child.name}${child.kind === "directory" ? "/" : ""}`);
      }
    }
  }
  let packageInfo = "";
  try {
    const pkg = JSON.parse((await workspace.readText("package.json", 256 * 1024)).text) as {
      name?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).slice(0, 30);
    packageInfo = [
      "package.json:",
      pkg.name ? `  name: ${pkg.name}` : "",
      pkg.scripts ? `  scripts: ${Object.keys(pkg.scripts).join(", ")}` : "",
      deps.length > 0 ? `  dependencies: ${deps.join(", ")}` : "",
    ]
      .filter((line) => line !== "")
      .join("\n");
  } catch {
    // No package.json, or not JSON.
  }
  return [lines.join("\n") || "(empty folder)", packageInfo]
    .filter((part) => part !== "")
    .join("\n\n");
}
