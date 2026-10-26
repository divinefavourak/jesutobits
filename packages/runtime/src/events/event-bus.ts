import {
  EVENTS,
  type EventCorrelation,
  type EventPayload,
  type EventType,
  type MethodResult,
  type RuntimeEventBase,
} from "@jesutobits/protocol";
import type { Logger } from "@jesutobits/shared";
import { z } from "zod";

/** Enough for a Workbench reload; older gaps are filled by reloading state instead. */
const DEFAULT_CAPACITY = 2000;

export interface EventBusOptions {
  /** Delivers one event to the Host as an `event` notification. */
  send(event: RuntimeEventBase): void;
  log: Logger;
  now?: () => Date;
  capacity?: number;
  /**
   * Masks secrets in every event before it is checked, sent, buffered or stored
   * (SECURITY.md section 6.1): the SecretRegistry's `maskValue`.
   */
  mask?: (value: unknown) => unknown;
}

/**
 * Numbers, checks and delivers runtime events (ARCHITECTURE.md section 6.4). `seq` is
 * strictly increasing for the life of the process, and recent events stay in a ring buffer
 * for `events.replay`, because the Host drops events while no Workbench is subscribed.
 */
export class EventBus {
  private nextSeq = 0;
  private readonly buffer: RuntimeEventBase[] = [];
  private readonly capacity: number;
  private readonly now: () => Date;
  private readonly listeners = new Set<(event: RuntimeEventBase) => void>();

  constructor(private readonly options: EventBusOptions) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Emits an event. Every event is checked against its schema in `@jesutobits/protocol`;
   * an invalid one is a bug in the emitter and throws there, before anything is sent.
   */
  emit<T extends EventType>(
    type: T,
    payload: EventPayload<T>,
    correlation: EventCorrelation = {},
  ): RuntimeEventBase {
    const unmasked = {
      seq: this.nextSeq,
      ts: this.now().toISOString(),
      type,
      ...correlation,
      ...payload,
    };
    const candidate = this.options.mask ? this.options.mask(unmasked) : unmasked;
    const parsed = EVENTS[type].schema.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(`Invalid ${type} event: ${z.prettifyError(parsed.error)}`);
    }
    const event = parsed.data as RuntimeEventBase;
    this.nextSeq += 1;
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    try {
      this.options.send(event);
    } catch (error) {
      // The event stays replayable; a failed write must not fail the emitter.
      this.options.log.error("could not send an event", { type, seq: event.seq, err: error });
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.options.log.error("an event listener failed", { type, seq: event.seq, err: error });
      }
    }
    return event;
  }

  /** Called with every event after it is sent (the session store persists agent events). */
  onEmit(listener: (event: RuntimeEventBase) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Events after `afterSeq` still in the buffer (`events.replay`). */
  replay(afterSeq: number): MethodResult<"events.replay"> {
    const lastSeq = this.nextSeq - 1;
    const oldest = this.buffer[0]?.seq ?? this.nextSeq;
    return {
      events: this.buffer.filter((event) => event.seq > afterSeq),
      // Complete when nothing between afterSeq and the oldest buffered event was dropped.
      complete: afterSeq + 1 >= oldest,
      lastSeq,
    };
  }
}
