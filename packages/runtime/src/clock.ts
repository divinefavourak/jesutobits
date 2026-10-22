/**
 * Time for everything that waits: timeouts, backoff, budgets (TESTING_STRATEGY.md section
 * 3.2). Production uses the system clock; tests use `FakeClock` and move time by hand.
 */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /**
   * Resolves after `ms`, or rejects with the signal's reason as soon as it aborts. Never
   * resolves early.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortReason(signal));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

interface Sleeper {
  at: number;
  order: number;
  resolve: () => void;
}

/** A clock that stands still until `advance` is called. */
export class FakeClock implements Clock {
  private time: number;
  private sleepers: Sleeper[] = [];
  private order = 0;

  constructor(start = Date.parse("2026-10-22T10:00:00.000Z")) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const sleeper: Sleeper = {
        at: this.time + Math.max(0, ms),
        order: this.order++,
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        this.sleepers = this.sleepers.filter((other) => other !== sleeper);
        reject(abortReason(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.sleepers.push(sleeper);
    });
  }

  /** How many sleeps are waiting (to check that code is blocked where a test expects). */
  get pending(): number {
    return this.sleepers.length;
  }

  /**
   * Moves time forward by `ms`, waking sleepers in deadline order. Between wakes it lets
   * promise callbacks run, so code that sleeps again inside the window is woken too.
   */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      await flush();
      const next = this.sleepers
        .filter((sleeper) => sleeper.at <= target)
        .sort((a, b) => a.at - b.at || a.order - b.order)[0];
      if (!next) break;
      this.sleepers = this.sleepers.filter((sleeper) => sleeper !== next);
      this.time = Math.max(this.time, next.at);
      next.resolve();
    }
    this.time = target;
    await flush();
  }
}

/** Lets pending promise callbacks (and their follow-ups) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("Aborted", "AbortError");
}
