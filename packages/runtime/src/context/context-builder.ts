import type { ModelInfo, TurnMode } from "@jesutobits/protocol";
import { systemPrompt } from "../agent/prompts/system.js";
import type { ChatMessage, ContentPart, ModelRequest, ToolSpec } from "../providers/types.js";
import type { StoredMessage } from "../sessions/session-store.js";
import type { InstructionFile } from "./instructions.js";
import type { TokenEstimator } from "./token-estimator.js";

/** AGENT_HARNESS.md section 4.3. */
const MAX_RESERVED_OUTPUT = 16_384;
const SAFETY_MARGIN = 0.05;
/** Compaction starts above this share of the available budget (section 4.4). */
export const COMPACTION_THRESHOLD = 0.75;
/** Tool results older than this many steps are replaced with stubs. */
const KEEP_RECENT_STEPS = 6;
/** Shares of the budget for fixed blocks (section 4.1). */
const INSTRUCTIONS_SHARE = 0.06;
const PROJECT_MAP_SHARE = 0.05;

/** Tools whose results are project content; the rest is tool output. */
const PROJECT_FILE_TOOLS = new Set(["read_file", "list_directory", "search_files", "search_text"]);

export interface ContextInput {
  mode: TurnMode;
  model: ModelInfo;
  project: { name: string; root: string; kind: "project" | "general"; trusted: boolean };
  /** The session's messages in order, including this turn's so far. */
  messages: readonly StoredMessage[];
  instructions: readonly InstructionFile[];
  /** A depth-limited tree of the project, or undefined. */
  projectMap?: string;
  tools: readonly ToolSpec[];
  /** Masks known secrets and token shapes in everything sent (SECURITY.md section 6.1). */
  mask(text: string): string;
  /** `providerOptions` passed through to the adapter. */
  providerOptions?: Record<string, unknown>;
  now?: Date;
}

export interface BuiltContext {
  request: ModelRequest;
  /** Estimated input tokens of `request`. */
  estimatedTokens: number;
  /** What the input may use: window minus reserved output and the safety margin. */
  available: number;
  /** Above COMPACTION_THRESHOLD after elision: the loop should compact first. */
  needsCompaction: boolean;
  /** Tool results replaced with stubs. */
  elided: number;
  /** Whole old turns left out because even with stubs they did not fit. */
  droppedMessages: number;
}

export function budgetFor(model: ModelInfo): { reservedOutput: number; available: number } {
  const reservedOutput = Math.min(
    model.maxOutputTokens ?? MAX_RESERVED_OUTPUT,
    MAX_RESERVED_OUTPUT,
  );
  const available = Math.floor((model.contextWindow - reservedOutput) * (1 - SAFETY_MARGIN));
  return { reservedOutput, available: Math.max(1000, available) };
}

/**
 * Decides what the model sees (AGENT_HARNESS.md section 4): the system prompt with the
 * environment, instructions and project map, then history newest-first within the budget.
 * Relevant source files are not pre-loaded; the model reads what it needs.
 */
export class ContextBuilder {
  constructor(private readonly estimator: TokenEstimator) {}

  build(input: ContextInput): BuiltContext {
    const { model } = input;
    const { reservedOutput, available } = budgetFor(model);
    const charsFor = (share: number) => Math.floor(available * share * 3.5);

    const system = input.mask(
      systemPrompt({
        mode: input.mode,
        workspaceKind: input.project.kind,
        restricted: !input.project.trusted,
        environment: [
          environmentBlock(input),
          instructionsBlock(input.instructions, charsFor(INSTRUCTIONS_SHARE)),
          input.projectMap
            ? `<project_map trust="project-file">\n${cut(input.projectMap, charsFor(PROJECT_MAP_SHARE))}\n</project_map>`
            : "",
        ]
          .filter((part) => part !== "")
          .join("\n\n"),
      }),
    );
    const tools = input.mode === "agent" ? [...input.tools] : [];
    const fixed =
      this.estimator.estimate(model.id, system) +
      this.estimator.estimate(model.id, JSON.stringify(tools));

    // History: from the latest summary on, with old tool results elided.
    const history = fromLatestSummary(input.messages);
    const steps = [
      ...new Set(history.flatMap((entry) => (entry.step === undefined ? [] : [entry.step]))),
    ];
    const oldestKept =
      steps.length > KEEP_RECENT_STEPS ? steps[steps.length - KEEP_RECENT_STEPS] : undefined;
    let elided = 0;
    const messages = history.map((entry) => {
      const elide =
        entry.role === "tool" &&
        oldestKept !== undefined &&
        entry.step !== undefined &&
        entry.step < oldestKept;
      if (elide) elided++;
      return toModelMessage(entry, elide, input.mask);
    });
    repairToolPairs(messages);

    // Fit: drop whole oldest turns until it fits, keeping at least the newest turn.
    const cost = (message: ChatMessage) =>
      this.estimator.estimate(model.id, JSON.stringify(message));
    let total = fixed + messages.reduce((sum, message) => sum + cost(message), 0);
    let dropped = 0;
    while (total > available && messages.length > 1) {
      const end = firstTurnBoundary(messages);
      if (end <= 0 || end >= messages.length) break;
      for (const message of messages.splice(0, end)) total -= cost(message);
      dropped += end;
    }

    return {
      request: {
        model: model.id,
        system,
        messages,
        tools,
        maxOutputTokens: reservedOutput,
        ...(input.providerOptions && { providerOptions: input.providerOptions }),
      },
      estimatedTokens: total,
      available,
      needsCompaction: total > available * COMPACTION_THRESHOLD,
      elided,
      droppedMessages: dropped,
    };
  }
}

function environmentBlock(input: ContextInput): string {
  const date = (input.now ?? new Date()).toISOString().slice(0, 10);
  return [
    "<environment>",
    `Operating system: ${process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux"}`,
    `Project: ${input.project.name} (${input.project.kind === "general" ? "General workspace" : "project"})`,
    `Project root: ${input.project.root}`,
    `Paths in tools are relative to the project root and use /.`,
    `Trust: ${input.project.trusted ? "trusted" : "untrusted (Restricted mode)"}`,
    "Available checks: none yet (commands and checks arrive in a later version)",
    `Date: ${date}`,
    "</environment>",
  ].join("\n");
}

function instructionsBlock(files: readonly InstructionFile[], maxChars: number): string {
  let left = maxChars;
  const blocks: string[] = [];
  for (const file of files) {
    if (left <= 0) break;
    const text = cut(file.text, left);
    left -= text.length;
    const note =
      file.truncated || text.length < file.text.length ? "\n[Shortened to fit the context.]" : "";
    blocks.push(
      `<project_instructions path="${file.path}" trust="project-instructions">\n${text}${note}\n</project_instructions>`,
    );
  }
  return blocks.join("\n");
}

function cut(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars))}…`;
}

/** The latest summary and what follows it; everything before is replaced by the summary. */
function fromLatestSummary(messages: readonly StoredMessage[]): StoredMessage[] {
  let start = 0;
  messages.forEach((entry, index) => {
    if (entry.role === "summary") start = index;
  });
  return messages.slice(start);
}

/** Converts a stored message, wrapping tool output with its provenance (section 4.5). */
function toModelMessage(
  entry: StoredMessage,
  elide: boolean,
  mask: (text: string) => string,
): ChatMessage {
  const message = entry.message;
  const maskParts = (parts: ContentPart[]): ContentPart[] =>
    parts.map((part) => (part.type === "text" ? { type: "text", text: mask(part.text) } : part));
  if (entry.role === "summary") {
    const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    return {
      role: "user",
      content: [
        {
          type: "text",
          text: mask(
            `<session_summary trust="agent-summary">\nThe conversation before this point was summarised:\n${text}\n</session_summary>`,
          ),
        },
      ],
    };
  }
  if (message.role === "tool") {
    const tool = entry.tool?.name ?? "tool";
    const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    const body = elide
      ? `[elided: ${entry.tool?.summary ?? tool}. Call ${tool} again if you need it.]`
      : text;
    const trust =
      tool === "ask_user" ? "user" : PROJECT_FILE_TOOLS.has(tool) ? "project-file" : "tool-output";
    return {
      role: "tool",
      toolCallId: message.toolCallId,
      content: [
        {
          type: "text",
          text: mask(`<tool_result tool="${tool}" trust="${trust}">\n${body}\n</tool_result>`),
        },
      ],
      ...(message.isError && { isError: true }),
    };
  }
  if (message.role === "assistant") {
    return { ...message, content: maskParts(message.content) };
  }
  return { role: "user", content: maskParts(message.content) };
}

/**
 * Every tool call needs a result before the next message, or providers refuse the request.
 * A turn that was interrupted or failed mid-step can leave calls without one; they get a
 * result saying so (the tool may or may not have run, so the model must check).
 */
function repairToolPairs(messages: ChatMessage[]): void {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== "assistant" || !message.toolCalls?.length) continue;
    const answered = new Set<string>();
    let next = index + 1;
    while (next < messages.length && messages[next]?.role === "tool") {
      const result = messages[next];
      if (result?.role === "tool") answered.add(result.toolCallId);
      next++;
    }
    const missing = message.toolCalls.filter((call) => !answered.has(call.id));
    messages.splice(
      next,
      0,
      ...missing.map((call): ChatMessage => ({
        role: "tool",
        toolCallId: call.id,
        content: [
          {
            type: "text",
            text: `<tool_result tool="${call.name}" trust="tool-output">
This call did not finish (the turn was stopped or interrupted). Check the current state before relying on it.
</tool_result>`,
          },
        ],
        isError: true,
      })),
    );
    index = next + missing.length - 1;
  }
}

/** The index after the first turn's messages: the next user message after the first. */
function firstTurnBoundary(messages: readonly ChatMessage[]): number {
  for (let index = 1; index < messages.length; index++) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}
