import { z } from "zod";
import { JesutobitsErrorDataSchema } from "./errors.js";

/** Runtime events travel as JSON-RPC notifications with this method name (ADR-0003). */
export const EVENT_NOTIFICATION_METHOD = "event";

/** `family.name`, for example `turn.started` or `fs.changed`. */
const EVENT_TYPE_PATTERN = /^[a-z]+(?:\.[a-z_]+)+$/;

/**
 * Fields shared by every runtime event (ARCHITECTURE.md section 6.4).
 * Event-specific schemas extend this with their own top-level fields (`defineEvent`).
 */
export const RuntimeEventBaseSchema = z.object({
  /** Per runtime process, strictly increasing. Gaps trigger `events.replay`. */
  seq: z.number().int().nonnegative(),
  ts: z.iso.datetime(),
  /** Discriminator, for example `turn.started`. */
  type: z.string().regex(EVENT_TYPE_PATTERN),
  projectId: z.string().optional(),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  callId: z.string().optional(),
  processId: z.string().optional(),
});
export type RuntimeEventBase = z.infer<typeof RuntimeEventBaseSchema>;

/** Correlation IDs an emitter may attach to an event. */
export type EventCorrelation = Partial<
  Pick<RuntimeEventBase, "projectId" | "sessionId" | "turnId" | "callId" | "processId">
>;

export interface EventDefinition<
  Type extends string = string,
  Payload extends z.ZodRawShape = z.ZodRawShape,
> {
  readonly type: Type;
  readonly description: string;
  /** The event's own fields, which sit next to the base fields. */
  readonly payload: z.ZodObject<Payload>;
  /** The full event: base fields, `type` fixed to this event, then the payload. */
  readonly schema: z.ZodType;
}

export function defineEvent<const Type extends string, Payload extends z.ZodRawShape>(definition: {
  type: Type;
  description: string;
  payload: z.ZodObject<Payload>;
}): EventDefinition<Type, Payload> {
  if (!EVENT_TYPE_PATTERN.test(definition.type)) {
    throw new Error(`Invalid event type ${definition.type}`);
  }
  return {
    ...definition,
    schema: RuntimeEventBaseSchema.extend({
      type: z.literal(definition.type),
      ...definition.payload.shape,
    }).strict(),
  };
}

// Catalogue (ARCHITECTURE.md section 6.4). Each family lands with the feature that emits it.

/** Something went wrong that the user may want to know about, without failing an action. */
export const runtimeWarningEvent = defineEvent({
  type: "runtime.warning",
  description: "A non-fatal problem in the runtime, shown in the Output panel.",
  payload: z.object({
    message: z.string(),
    code: z.string().optional(),
  }),
});

/** An error not tied to a request the Workbench made (those fail the request instead). */
export const runtimeErrorEvent = defineEvent({
  type: "runtime.error",
  description: "An error in background work, with the JesutobitsError that describes it.",
  payload: z.object({
    error: JesutobitsErrorDataSchema,
  }),
});

export const EVENTS = {
  [runtimeWarningEvent.type]: runtimeWarningEvent,
  [runtimeErrorEvent.type]: runtimeErrorEvent,
} as const;

export type EventType = keyof typeof EVENTS;
/** The fields an emitter supplies for an event, besides the base fields. */
export type EventPayload<T extends EventType> = z.input<(typeof EVENTS)[T]["payload"]>;

export function getEvent(type: string): EventDefinition | undefined {
  return Object.hasOwn(EVENTS, type) ? EVENTS[type as EventType] : undefined;
}
