import type { Unsubscribe } from "./types";

/** A set of handlers plus the last value, replayed to late subscribers when `replay` is set. */
export class Listeners<T> {
  private readonly handlers = new Set<(value: T) => void>();
  private last: { value: T } | undefined;

  constructor(private readonly replay: boolean) {}

  add(handler: (value: T) => void): Unsubscribe {
    this.handlers.add(handler);
    if (this.replay && this.last) handler(this.last.value);
    return () => this.handlers.delete(handler);
  }

  emit(value: T): void {
    if (this.replay) this.last = { value };
    for (const handler of this.handlers) handler(value);
  }
}
