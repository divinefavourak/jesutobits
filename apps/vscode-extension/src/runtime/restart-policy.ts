/**
 * When to restart a crashed runtime (ADR-0002): back off 0.5, 1, 2 and 4 s, and give up after
 * the fifth crash within two minutes. Pure, so the rules are tested without processes or clocks.
 */
export type RestartDecision =
  | { kind: "restart"; afterMs: number }
  /** Too many crashes in the window; carries how many. */
  | { kind: "give_up"; crashes: number };

export class RestartPolicy {
  readonly #backoffMs: readonly number[];
  readonly #windowMs: number;
  readonly #crashesUntilFailed: number;
  #recent: number[] = [];

  constructor(backoffMs: readonly number[], windowMs: number, crashesUntilFailed: number) {
    if (backoffMs.length === 0 || crashesUntilFailed < 1) {
      throw new RangeError("RestartPolicy needs a backoff and at least one crash until failed");
    }
    this.#backoffMs = backoffMs;
    this.#windowMs = windowMs;
    this.#crashesUntilFailed = crashesUntilFailed;
  }

  /**
   * Records a crash at `nowMs` and decides what to do. The wait grows with the number of
   * crashes still inside the window, so a runtime that crashes once a day always restarts
   * after the shortest wait.
   */
  onCrash(nowMs: number): RestartDecision {
    this.#recent = this.#recent.filter((crash) => nowMs - crash < this.#windowMs);
    this.#recent.push(nowMs);
    const count = this.#recent.length;
    if (count >= this.#crashesUntilFailed) return { kind: "give_up", crashes: count };
    const afterMs = this.#backoffMs[Math.min(count - 1, this.#backoffMs.length - 1)] ?? 0;
    return { kind: "restart", afterMs };
  }

  /** Forgets past crashes; used when the user restarts the runtime from Failed. */
  reset(): void {
    this.#recent = [];
  }
}
