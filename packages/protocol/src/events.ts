import { z } from "zod";

/** Runtime events travel as JSON-RPC notifications with this method name (ADR-0003). */
export const EVENT_NOTIFICATION_METHOD = "event";

/**
 * Fields shared by every runtime event (ARCHITECTURE.md section 6.4).
 * Event-specific schemas extend this; the catalogue lands with the features that emit them.
 */
export const RuntimeEventBaseSchema = z.object({
  /** Per runtime process, strictly increasing. Gaps trigger `events.replay`. */
  seq: z.number().int().nonnegative(),
  ts: z.iso.datetime(),
  /** Discriminator, for example `turn.started`. */
  type: z.string().regex(/^[a-z]+(?:\.[a-z_]+)+$/),
  projectId: z.string().optional(),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  callId: z.string().optional(),
  processId: z.string().optional(),
});
export type RuntimeEventBase = z.infer<typeof RuntimeEventBaseSchema>;
