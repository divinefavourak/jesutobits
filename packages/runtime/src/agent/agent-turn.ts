import {
  ErrorCodes,
  JesutobitsError,
  isFinalTurnState,
  type EventCorrelation,
  type EventPayload,
  type EventType,
  type ModelInfo,
  type PlanItem,
  type PreviewStatus,
  type RuntimeSettings,
  type TurnMode,
  type TurnState,
  type TurnStateReason,
  type TurnSummary,
} from "@jesutobits/protocol";
import type { FileIndex, WorkspaceService } from "@jesutobits/services";
import { newId, type Logger } from "@jesutobits/shared";
import type { Checkpoints } from "../checkpoints/checkpoints.js";
import type { Clock } from "../clock.js";
import type { ContextBuilder, ContextInput } from "../context/context-builder.js";
import { loadInstructions } from "../context/instructions.js";
import type { TokenEstimator } from "../context/token-estimator.js";
import type { SecretRegistry } from "../log/secret-registry.js";
import type { ProhibitedPlaces } from "../permissions/prohibited.js";
import { providerFailure } from "../providers/errors.js";
import {
  ProviderCallError,
  type ProviderCaller,
  type StepResult,
} from "../providers/provider-caller.js";
import type { ModelRequest, ToolCall } from "../providers/types.js";
import type { SessionStore } from "../sessions/session-store.js";
import type {
  ReadTracker,
  CommandOptions,
  CommandResult,
  TextSearchQuery,
  TextSearchResult,
  ToolContext,
} from "../tools/common/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolRunner } from "../tools/runner.js";
import { TurnLimits, type LimitName } from "./limits.js";
import { LoopGuard } from "./loop-guard.js";
import { COMPACTION_PROMPT } from "./prompts/system.js";

type Emit = <T extends EventType>(
  type: T,
  payload: EventPayload<T>,
  correlation?: EventCorrelation,
) => void;

/** Everything a turn needs, supplied by the AgentService for the active project. */
export interface TurnDeps {
  store: SessionStore;
  emit: Emit;
  caller: ProviderCaller;
  contextBuilder: ContextBuilder;
  estimator: TokenEstimator;
  registry: ToolRegistry;
  runner: ToolRunner;
  checkpoints: Checkpoints;
  workspace: WorkspaceService;
  files: FileIndex | undefined;
  settings: RuntimeSettings;
  prohibited: ProhibitedPlaces;
  secrets: SecretRegistry;
  clock: Clock;
  log: Logger;
  model: ModelInfo;
  project: {
    id: string;
    name: string;
    root: string;
    kind: "project" | "general";
    trusted: boolean;
  };
  /** What the session read last, per file (FR-052); shared by the session's turns. */
  reads: ReadTracker;
  /** Files the session touched, for nested AGENTS.md (FR-042). */
  touched: Set<string>;
  projectMap(): Promise<string | undefined>;
  searchText?(query: TextSearchQuery, signal: AbortSignal): Promise<TextSearchResult>;
  runCommand?(argv: string[], options: CommandOptions): Promise<CommandResult>;
  startPreview?(): Promise<PreviewStatus>;
}

/** The turn was cancelled; the reason travels as the abort reason. */
class Cancelled extends Error {
  constructor(readonly reason: TurnStateReason = "user_cancel") {
    super("The turn was cancelled");
    this.name = "Cancelled";
  }
}

/** The user chose Stop at a limit or loop question. */
class StoppedByUser extends Error {}

/** How long a model's explanation before a call may be on an approval card. */
const MAX_EXPLANATION_CHARS = 600;
/** Tools that only look; a step of only these counts as read-only for the loop guard. */
const READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_directory",
  "search_files",
  "search_text",
  "update_plan",
]);
const CONTINUE = "Continue";
const STOP = "Stop";

/**
 * One turn of the agent loop (AGENT_HARNESS.md section 3): model steps and their tool calls
 * until the model stops, the user cancels, a question waits, or a limit is reached. Every
 * transition emits `turn.state_changed`, and only real work changes the state (invariant 6).
 */
export class AgentTurn {
  readonly controller = new AbortController();
  private state: TurnState | null = null;
  private pauseRequested = false;
  private resume: (() => void) | undefined;
  private readonly questions = new Map<string, (answer: string | null) => void>();
  private readonly limits: TurnLimits;
  private readonly guard = new LoopGuard();
  private readonly started: number;
  private steps = 0;
  private toolCalls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd = 0;
  private hiddenSecrets = 0;
  private continuedAfterLength = false;
  /** The session-wide step index of the next model step (for elision). */
  private globalStep: number;

  constructor(
    private readonly deps: TurnDeps,
    readonly id: string,
    readonly sessionId: string,
    private readonly mode: TurnMode,
    private sessionCostUsd: number,
  ) {
    this.limits = new TurnLimits(deps.settings.agent.limits);
    this.started = deps.clock.now();
    this.globalStep = deps.store
      .messages(sessionId)
      .reduce((max, entry) => Math.max(max, (entry.step ?? -1) + 1), 0);
  }

  get currentState(): TurnState | null {
    return this.state;
  }

  private get correlation(): EventCorrelation {
    return { projectId: this.deps.project.id, sessionId: this.sessionId, turnId: this.id };
  }

  /** Runs the turn to its end; never throws (failures end the turn instead). */
  async run(): Promise<void> {
    const signal = this.controller.signal;
    try {
      this.setState("understanding");
      await this.loop(signal);
      this.finish("completed", "done");
    } catch (error) {
      if (signal.aborted || error instanceof Cancelled) {
        const reason = signal.reason instanceof Cancelled ? signal.reason.reason : "user_cancel";
        this.finish("cancelled", reason);
      } else if (error instanceof StoppedByUser) {
        this.finish("cancelled", "limit");
      } else if (error instanceof ProviderCallError) {
        this.fail(providerFailure(error.error));
      } else if (error instanceof JesutobitsError) {
        this.fail(error);
      } else {
        this.deps.log.error("the turn failed unexpectedly", { turnId: this.id, err: error });
        this.fail(
          new JesutobitsError(ErrorCodes.rpcInternal, "The turn failed unexpectedly", {
            userAction: "report",
          }),
        );
      }
    } finally {
      this.closeQuestions();
    }
  }

  cancel(): void {
    if (!this.controller.signal.aborted) this.controller.abort(new Cancelled("user_cancel"));
  }

  /** Lets the current tool finish, then holds at the next safe point (UX 6.1). */
  pause(): void {
    if (this.state && isFinalTurnState(this.state)) return;
    this.pauseRequested = true;
  }

  resumeTurn(): boolean {
    if (!this.pauseRequested && this.state !== "paused") return false;
    this.pauseRequested = false;
    this.resume?.();
    return true;
  }

  /** `agent.answerQuestion`; false when the question is not this turn's or not open. */
  answer(questionId: string, answer: string): boolean {
    const waiting = this.questions.get(questionId);
    if (!waiting) return false;
    this.questions.delete(questionId);
    waiting(answer);
    return true;
  }

  /** The broker asked or got its answer; the state follows (AGENT_HARNESS.md 3.2). */
  onPermission(kind: "requested" | "resolved"): void {
    if (kind === "requested") this.setState("awaiting_approval", "approval");
    else if (this.state === "awaiting_approval") this.setState("tool_running", "approval");
  }

  // The loop.

  private async loop(signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      await this.checkLimits(signal);
      await this.holdIfPaused(signal);

      const request = await this.buildRequest(signal);
      this.setState("thinking");
      const step = await this.runStep(request, signal);
      const index = this.globalStep++;
      this.steps++;
      this.recordUsage(step);

      // The assistant message, as the model sent it (provider call IDs are kept).
      this.deps.store.appendMessage(this.sessionId, {
        turnId: this.id,
        role: "assistant",
        message: {
          role: "assistant",
          content: step.text === "" ? [] : [{ type: "text", text: step.text }],
          ...(step.toolCalls.length > 0 && { toolCalls: step.toolCalls }),
        },
        step: index,
      });
      const ourIds = step.toolCalls.map(() => newId("call"));
      this.deps.emit(
        "model.step_completed",
        {
          step: index,
          text: step.text,
          toolCalls: step.toolCalls.map((call, i) => ({
            callId: ourIds[i] ?? "",
            tool: call.name,
          })),
          finishReason: step.finishReason,
        },
        this.correlation,
      );

      const verdict = this.guard.observeStep({
        empty: step.text.trim() === "" && step.toolCalls.length === 0,
        readOnly: step.toolCalls.every((call) => READ_ONLY_TOOLS.has(call.name)),
      });
      if (verdict.kind === "warn") this.warn(verdict.message, "agent.exploring");
      if (verdict.kind === "ask") {
        await this.askToContinue(verdict.question, "loop", signal);
        continue;
      }

      if (step.toolCalls.length === 0) {
        // An empty reply is never the end of the work (a reasoning model can spend the whole
        // output limit thinking): nudge it on; the guard asks the user after two in a row.
        if (step.text.trim() === "") {
          this.nudge(
            step.finishReason === "length"
              ? "You used your whole reply on thinking and sent nothing. Stop planning and act now: call a tool, or answer in a few sentences."
              : "Your reply was empty. Carry on with the task: call a tool, or answer.",
          );
          continue;
        }
        // Cut off by the output limit: ask the model to go on, once (section 3.4).
        if (step.finishReason === "length" && !this.continuedAfterLength) {
          this.continuedAfterLength = true;
          this.nudge(
            "Your reply was cut off at the output limit. Continue exactly where you stopped.",
          );
          continue;
        }
        return;
      }

      this.setState("tool_running");
      const explanation = step.text.trim().slice(0, MAX_EXPLANATION_CHARS);
      for (const [i, call] of step.toolCalls.entries()) {
        signal.throwIfAborted();
        if (this.state !== "tool_running") this.setState("tool_running");
        await this.runTool(call, ourIds[i] ?? newId("call"), index, explanation, signal);
      }
      await this.holdIfPaused(signal);
    }
  }

  /** A note from Jesutobits to the model, stored as a user message so it is in the history. */
  private nudge(text: string): void {
    this.deps.store.appendMessage(this.sessionId, {
      turnId: this.id,
      role: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    });
  }

  private async runStep(request: ModelRequest, signal: AbortSignal): Promise<StepResult> {
    const step = this.globalStep;
    return this.deps.caller.runStep(
      request,
      signal,
      {
        onAttempt: (attempt) => {
          if (this.state !== "thinking") this.setState("thinking");
          this.deps.emit(
            "model.request_started",
            { step, attempt, modelId: request.model },
            this.correlation,
          );
        },
        onEvent: (event) => {
          if (event.type === "text_delta") {
            if (this.state === "thinking") this.setState("responding");
            this.deps.emit("model.text_delta", { step, text: event.text }, this.correlation);
          } else if (event.type === "reasoning_delta") {
            this.deps.emit("model.reasoning_delta", { step, text: event.text }, this.correlation);
          }
        },
        onError: (error, attempt, retryInMs) => {
          this.deps.emit(
            "model.error",
            { step, attempt, error, ...(retryInMs !== undefined && { retryInMs }) },
            this.correlation,
          );
          if (error.category === "rate_limited" && retryInMs !== undefined) {
            this.warn(
              `OpenRouter is limiting requests. Trying again in ${Math.ceil(retryInMs / 1000)} s.`,
              "provider.rate_limited",
            );
          }
        },
        onContextLength: async () => {
          await this.compact(signal);
          return this.buildRequest(signal, true);
        },
      },
      { reasoning: this.deps.model.capabilities.reasoning },
    );
  }

  private async runTool(
    call: ToolCall,
    callId: string,
    step: number,
    explanation: string,
    signal: AbortSignal,
  ): Promise<void> {
    const ctx = this.toolContext(callId);
    const outcome = await this.deps.runner.run(
      {
        callId,
        name: call.name,
        argumentsJson: call.argumentsJson,
        ...(explanation !== "" && { agentExplanation: explanation }),
      },
      ctx,
      signal,
    );
    this.toolCalls++;
    let { result } = outcome;
    if (result.ok && result.hiddenSecrets) this.hiddenSecrets += result.hiddenSecrets;
    if (result.ok && result.awaitUser) {
      const answer = await this.waitForAnswer(result.awaitUser.questionId, signal);
      result = { ...result, modelText: `The user answered: ${answer}` };
    }
    for (const path of pathsOf(outcome.input)) this.deps.touched.add(path);

    const tool = this.deps.registry.get(call.name);
    let summary = call.name;
    try {
      summary =
        tool && outcome.input !== undefined
          ? tool.summarize(outcome.input as never, result)
          : call.name;
    } catch {
      // The summary is cosmetic.
    }
    this.deps.store.appendMessage(this.sessionId, {
      turnId: this.id,
      role: "tool",
      message: {
        role: "tool",
        toolCallId: call.id,
        content: [{ type: "text", text: result.modelText }],
        ...(!result.ok && { isError: true }),
      },
      tool: { name: call.name, summary },
      step,
    });

    const verdict = this.guard.observeCall({
      name: call.name,
      argumentsJson: call.argumentsJson,
      invalid: outcome.decision === "invalid",
      result: result.modelText,
    });
    if (verdict.kind === "ask") await this.askToContinue(verdict.question, "loop", signal);
  }

  private toolContext(callId: string): ToolContext {
    const { deps } = this;
    return {
      projectId: deps.project.id,
      sessionId: this.sessionId,
      turnId: this.id,
      callId,
      workspace: deps.workspace,
      prohibited: deps.prohibited,
      files: deps.files,
      reads: deps.reads,
      redactValues: false,
      checkpoints: {
        before: (path) => deps.checkpoints.before(deps.workspace, deps.project.id, this.id, path),
        after: (path, after) => deps.checkpoints.after(this.id, path, after),
      },
      redact: (text) => {
        const masked = deps.secrets.mask(text);
        const hidden =
          (masked.match(/\[REDACTED:/g)?.length ?? 0) - (text.match(/\[REDACTED:/g)?.length ?? 0);
        return { text: masked, hidden: Math.max(0, hidden) };
      },
      setPlan: (items: PlanItem[]) => this.deps.emit("plan.updated", { items }, this.correlation),
      askUser: (question, options) => this.ask(question, options, "agent"),
      ...(deps.searchText && { searchText: deps.searchText }),
      projectRoot: deps.project.root,
      ...(deps.runCommand && { runCommand: deps.runCommand }),
      ...(deps.startPreview && { startPreview: deps.startPreview }),
    };
  }

  // Context.

  private async buildRequest(signal: AbortSignal, afterCompaction = false): Promise<ModelRequest> {
    const input = await this.contextInput();
    let built = this.deps.contextBuilder.build(input);
    if (built.needsCompaction && !afterCompaction) {
      await this.compact(signal, built.request);
      built = this.deps.contextBuilder.build(await this.contextInput());
    }
    if (built.elided > 0 || built.droppedMessages > 0) {
      this.deps.log.debug("context trimmed", {
        turnId: this.id,
        elided: built.elided,
        dropped: built.droppedMessages,
      });
    }
    this.lastEstimate = built.estimatedTokens;
    return built.request;
  }

  private lastEstimate = 0;

  private async contextInput(): Promise<ContextInput> {
    const { deps } = this;
    const instructions = await loadInstructions(deps.workspace, deps.touched, 40_000);
    const projectMap = await deps.projectMap();
    return {
      mode: this.mode,
      model: deps.model,
      project: {
        name: deps.project.name,
        root: deps.project.root,
        kind: deps.project.kind,
        trusted: deps.project.trusted,
      },
      messages: deps.store.messages(this.sessionId),
      instructions,
      ...(projectMap !== undefined && { projectMap }),
      tools: deps.registry.specs({ trusted: deps.project.trusted }),
      mask: (text) => deps.secrets.mask(text),
      providerOptions: deps.settings.providers.openrouter.options as Record<string, unknown>,
    };
  }

  /**
   * Compaction (AGENT_HARNESS.md section 4.4): the model writes a structured summary that
   * replaces the history before the last two turns' worth; the full history stays stored.
   */
  private async compact(signal: AbortSignal, request?: ModelRequest): Promise<void> {
    const previous = this.state;
    this.setState("compacting", "compaction");
    const base = request ?? this.deps.contextBuilder.build(await this.contextInput()).request;
    const result = await this.deps.caller.runStep(
      {
        ...base,
        tools: [],
        messages: [
          ...base.messages,
          { role: "user", content: [{ type: "text", text: COMPACTION_PROMPT }] },
        ],
      },
      signal,
      {},
      { reasoning: this.deps.model.capabilities.reasoning },
    );
    this.recordUsage(result);
    if (result.text.trim() !== "") {
      this.deps.store.appendMessage(this.sessionId, {
        turnId: this.id,
        role: "summary",
        message: { role: "user", content: [{ type: "text", text: result.text }] },
      });
    }
    this.setState(previous && previous !== "compacting" ? previous : "thinking", "compaction");
  }

  // Usage, limits and questions.

  private recordUsage(step: StepResult): void {
    const usage = step.usage;
    if (!usage) return;
    const pricing = this.deps.model.pricing;
    const cost =
      usage.costUsd ??
      (pricing
        ? (usage.inputTokens * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok) /
          1_000_000
        : 0);
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.costUsd += cost;
    this.sessionCostUsd += cost;
    this.deps.estimator.observe(this.deps.model.id, this.lastEstimate, usage.inputTokens);
    this.deps.store.addUsage(this.sessionId, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: cost,
    });
    this.deps.emit(
      "model.usage",
      {
        step: Math.max(0, this.globalStep - 1),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.cachedInputTokens !== undefined && {
          cachedInputTokens: usage.cachedInputTokens,
        }),
        costUsd: cost,
        turnCostUsd: this.costUsd,
        sessionCostUsd: this.sessionCostUsd,
      },
      this.correlation,
    );
  }

  private usage() {
    return {
      steps: this.steps,
      toolCalls: this.toolCalls,
      elapsedMs: this.deps.clock.now() - this.started,
      turnCostUsd: this.costUsd,
      sessionCostUsd: this.sessionCostUsd,
    };
  }

  private async checkLimits(signal: AbortSignal): Promise<void> {
    for (const message of this.limits.warnings(this.usage()))
      this.warn(message, "agent.limit_near");
    for (;;) {
      const hit = this.limits.check(this.usage());
      if (!hit) return;
      await this.askToContinue(hit.question, "limit", signal, hit.name);
    }
  }

  /** Stops the turn and asks; returns if the user chose to continue (section 3.4, 3.6). */
  private async askToContinue(
    question: string,
    source: "limit" | "loop",
    signal: AbortSignal,
    limit?: LimitName,
  ): Promise<void> {
    const questionId = this.ask(question, [CONTINUE, STOP], source);
    const previous = this.state;
    const answer = await this.waitForAnswer(
      questionId,
      signal,
      source === "limit" ? "limit" : "question",
    );
    if (answer.trim().toLowerCase() !== CONTINUE.toLowerCase()) throw new StoppedByUser();
    if (limit) this.limits.raise(limit);
    if (previous)
      this.setState(
        previous === "awaiting_user" ? "thinking" : previous,
        source === "limit" ? "limit" : "question",
      );
  }

  private ask(
    question: string,
    options: readonly string[],
    source: "agent" | "limit" | "loop",
  ): string {
    const questionId = newId("qst");
    this.questions.set(questionId, () => undefined);
    this.deps.emit(
      "question.asked",
      { questionId, question, options: [...options], source },
      this.correlation,
    );
    return questionId;
  }

  private waitForAnswer(
    questionId: string,
    signal: AbortSignal,
    reason: TurnStateReason = "question",
  ): Promise<string> {
    const previous = this.state;
    this.setState("awaiting_user", reason);
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        // Closed unanswered: the Workbench removes the question card.
        if (this.questions.delete(questionId)) {
          this.deps.emit("question.answered", { questionId, answer: null }, this.correlation);
        }
        reject(signal.reason);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.questions.set(questionId, (answer) => {
        signal.removeEventListener("abort", onAbort);
        this.deps.emit("question.answered", { questionId, answer }, this.correlation);
        if (answer === null) {
          reject(new Cancelled());
          return;
        }
        if (previous && previous !== "awaiting_user")
          this.setState(previous === "tool_running" ? "tool_running" : "thinking", reason);
        resolve(answer);
      });
    });
  }

  private closeQuestions(): void {
    for (const [questionId] of this.questions) {
      this.deps.emit("question.answered", { questionId, answer: null }, this.correlation);
    }
    this.questions.clear();
  }

  private async holdIfPaused(signal: AbortSignal): Promise<void> {
    if (!this.pauseRequested) return;
    const previous = this.state;
    this.setState("paused", "pause");
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.resume = () => {
        signal.removeEventListener("abort", onAbort);
        this.resume = undefined;
        resolve();
      };
    });
    this.setState(previous === "tool_running" ? "thinking" : (previous ?? "thinking"), "pause");
  }

  // State and endings.

  private setState(to: TurnState, reason?: TurnStateReason): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    this.deps.store.setTurnState(this.id, to);
    this.deps.emit("turn.state_changed", { from, to, ...(reason && { reason }) }, this.correlation);
  }

  private warn(message: string, code: string): void {
    this.deps.emit("runtime.warning", { message, code }, this.correlation);
  }

  private summary(): TurnSummary {
    const files = this.deps.checkpoints.changes(this.id);
    return {
      files,
      steps: this.steps,
      toolCalls: this.toolCalls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
      // No checks exist yet (Phase 3): changed files are never labelled verified (FR-039).
      verification: files.length > 0 ? "unverified" : null,
      hiddenSecrets: this.hiddenSecrets,
    };
  }

  private finish(state: "completed" | "cancelled", reason: string): void {
    const summary = this.summary();
    this.setState(
      state,
      state === "cancelled" ? (reason === "limit" ? "limit" : "user_cancel") : undefined,
    );
    this.deps.store.finishTurn(this.id, { state, reason, summary });
    if (state === "completed") this.deps.emit("turn.completed", { summary }, this.correlation);
    else this.deps.emit("turn.cancelled", { summary }, this.correlation);
  }

  private fail(error: JesutobitsError): void {
    const summary = this.summary();
    this.setState("failed", "error");
    this.deps.store.finishTurn(this.id, {
      state: "failed",
      reason: error.code,
      summary,
      error: error.toData(),
    });
    this.deps.emit("turn.failed", { error: error.toData(), summary }, this.correlation);
  }
}

/** Project paths a tool input names, for nested instructions files. */
function pathsOf(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  return ["path", "from", "to"].flatMap((key) =>
    typeof record[key] === "string" ? [record[key] as string] : [],
  );
}
