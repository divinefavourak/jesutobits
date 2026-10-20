import { z } from "zod";

/**
 * Messages the Host itself sends to the Workbench (ARCHITECTURE.md section 6.1), as opposed
 * to runtime messages it relays.
 */

/** Runtime lifecycle as the Host sees it (ADR-0002). `restarting` arrives with auto-restart. */
export const RuntimeStatusSchema = z.enum([
  "starting",
  "ready",
  "degraded",
  "restarting",
  "failed",
]);
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

export const RuntimeStatusUpdateSchema = z.object({
  status: RuntimeStatusSchema,
  /** Plain-language reason, shown on degraded and failed states. */
  detail: z.string().optional(),
});
export type RuntimeStatusUpdate = z.infer<typeof RuntimeStatusUpdateSchema>;

export const LogLevelSchema = z.enum(["error", "warn", "info", "debug"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;
