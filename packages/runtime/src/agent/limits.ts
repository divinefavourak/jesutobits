import type { RuntimeSettings } from "@jesutobits/protocol";

/** AGENT_HARNESS.md section 3.4; the defaults are settings (FR-033). */
export interface TurnUsage {
  steps: number;
  toolCalls: number;
  elapsedMs: number;
  turnCostUsd: number;
  sessionCostUsd: number;
}

export type LimitName = "steps" | "toolCalls" | "time" | "turnCost" | "sessionCost";

/** A reached limit: the question asked, and how far "Continue" raises it. */
export interface LimitHit {
  name: LimitName;
  question: string;
}

const WARN_AT = 0.8;

/**
 * Tracks one turn's limits. A reached limit pauses the turn and asks; "Continue" raises it
 * (steps by 20, tool calls by 50, time by the original amount, cost by doubling).
 */
export class TurnLimits {
  private steps: number;
  private toolCalls: number;
  private timeMs: number;
  private turnCost: number;
  private sessionCost: number;
  private readonly warned = new Set<LimitName>();

  constructor(settings: RuntimeSettings["agent"]["limits"]) {
    this.steps = settings.stepsPerTurn;
    this.toolCalls = settings.toolCallsPerTurn;
    this.timeMs = settings.turnMinutes * 60_000;
    this.turnCost = settings.costPerTurnUsd;
    this.sessionCost = settings.costPerSessionUsd;
  }

  /** The first limit reached before another step may start, if any. */
  check(usage: TurnUsage): LimitHit | undefined {
    if (usage.steps >= this.steps) {
      return {
        name: "steps",
        question: `The turn reached ${this.steps} steps. Continue for 20 more?`,
      };
    }
    if (usage.toolCalls >= this.toolCalls) {
      return {
        name: "toolCalls",
        question: `The turn made ${this.toolCalls} tool calls. Continue for 50 more?`,
      };
    }
    if (usage.elapsedMs >= this.timeMs) {
      const minutes = Math.round(this.timeMs / 60_000);
      return { name: "time", question: `The turn has run for ${minutes} minutes. Keep going?` };
    }
    if (usage.turnCostUsd >= this.turnCost) {
      return {
        name: "turnCost",
        question: `The turn has cost ${usd(usage.turnCostUsd)}. Allow up to ${usd(this.turnCost * 2)}?`,
      };
    }
    if (usage.sessionCostUsd >= this.sessionCost) {
      return {
        name: "sessionCost",
        question: `This session has cost ${usd(usage.sessionCostUsd)}. Allow up to ${usd(this.sessionCost * 2)}?`,
      };
    }
    return undefined;
  }

  /** The user chose to continue past `name`. */
  raise(name: LimitName): void {
    switch (name) {
      case "steps":
        this.steps += 20;
        break;
      case "toolCalls":
        this.toolCalls += 50;
        break;
      case "time":
        this.timeMs *= 2;
        break;
      case "turnCost":
        this.turnCost *= 2;
        break;
      case "sessionCost":
        this.sessionCost *= 2;
        break;
    }
    this.warned.delete(name);
  }

  /** Warnings at 80% of each limit, each once until the limit is raised. */
  warnings(usage: TurnUsage): string[] {
    const near: Array<[LimitName, boolean, string]> = [
      ["steps", usage.steps >= this.steps * WARN_AT, `${usage.steps} of ${this.steps} steps used`],
      [
        "toolCalls",
        usage.toolCalls >= this.toolCalls * WARN_AT,
        `${usage.toolCalls} of ${this.toolCalls} tool calls used`,
      ],
      ["time", usage.elapsedMs >= this.timeMs * WARN_AT, "the turn is close to its time limit"],
      [
        "turnCost",
        usage.turnCostUsd >= this.turnCost * WARN_AT,
        `${usd(usage.turnCostUsd)} of the ${usd(this.turnCost)} turn budget used`,
      ],
      [
        "sessionCost",
        usage.sessionCostUsd >= this.sessionCost * WARN_AT,
        `${usd(usage.sessionCostUsd)} of the ${usd(this.sessionCost)} session budget used`,
      ],
    ];
    const messages: string[] = [];
    for (const [name, close, message] of near) {
      if (close && !this.warned.has(name)) {
        this.warned.add(name);
        messages.push(`Approaching a limit: ${message}.`);
      }
    }
    return messages;
  }
}

function usd(value: number): string {
  return `USD ${value.toFixed(2)}`;
}
