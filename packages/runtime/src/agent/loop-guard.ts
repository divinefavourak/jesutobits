/**
 * Loop protection (AGENT_HARNESS.md section 3.6). The guard watches steps and tool calls and
 * says when the turn should stop and ask the user, or warn that the agent is exploring
 * without progress. Phase 3 adds the repeated-failing-check rule with checks.
 */
export type GuardVerdict =
  { kind: "ok" } | { kind: "warn"; message: string } | { kind: "ask"; question: string };

const REPEAT_LIMIT = 3;
const INVALID_LIMIT = 3;
const EMPTY_LIMIT = 2;
const READ_ONLY_WARNING = 15;

export class LoopGuard {
  private readonly repeats = new Map<string, { result: string; count: number }>();
  private invalidInARow = 0;
  private emptyInARow = 0;
  private readOnlySteps = 0;
  private warnedReadOnly = false;

  /** After each tool call. `result` is what the model received. */
  observeCall(call: {
    name: string;
    argumentsJson: string;
    invalid: boolean;
    result: string;
  }): GuardVerdict {
    if (call.invalid) {
      this.invalidInARow++;
      if (this.invalidInARow >= INVALID_LIMIT) {
        this.invalidInARow = 0;
        return {
          kind: "ask",
          question: `The agent sent ${INVALID_LIMIT} malformed tool calls in a row. Let it keep trying?`,
        };
      }
    } else {
      this.invalidInARow = 0;
    }
    const key = `${call.name}\u0000${call.argumentsJson}`;
    const seen = this.repeats.get(key);
    const count = seen && seen.result === call.result ? seen.count + 1 : 1;
    this.repeats.set(key, { result: call.result, count });
    if (count >= REPEAT_LIMIT) {
      this.repeats.delete(key);
      return {
        kind: "ask",
        question: `The agent called ${call.name} ${REPEAT_LIMIT} times with the same input and got the same result. Let it continue?`,
      };
    }
    return { kind: "ok" };
  }

  /** After each model step. A step that only read (or did nothing) counts as read-only. */
  observeStep(step: { empty: boolean; readOnly: boolean }): GuardVerdict {
    if (step.empty) {
      this.emptyInARow++;
      if (this.emptyInARow >= EMPTY_LIMIT) {
        this.emptyInARow = 0;
        return {
          kind: "ask",
          question: "The model sent empty replies twice in a row. Try again?",
        };
      }
    } else {
      this.emptyInARow = 0;
    }
    this.readOnlySteps = step.readOnly ? this.readOnlySteps + 1 : 0;
    if (this.readOnlySteps >= READ_ONLY_WARNING && !this.warnedReadOnly) {
      this.warnedReadOnly = true;
      return {
        kind: "warn",
        message: `The agent has only read files for ${READ_ONLY_WARNING} steps in a row.`,
      };
    }
    if (!step.readOnly) this.warnedReadOnly = false;
    return { kind: "ok" };
  }
}
