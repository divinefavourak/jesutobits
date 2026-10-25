import { z } from "zod";
import { RuntimeEventBaseSchema } from "../events.js";
import { defineMethod } from "./define.js";

/**
 * Events the Workbench missed, for example while it reloaded and the Host had no channel to
 * deliver them to (ADR-0003). The runtime keeps recent events in a ring buffer; `complete`
 * is false when some events after `afterSeq` have already left it, and the Workbench then
 * reloads its state from the owning methods instead.
 */
export const eventsReplay = defineMethod({
  name: "events.replay",
  description: "Recent events after a sequence number, for filling gaps.",
  callers: ["workbench"],
  params: z.object({
    afterSeq: z.number().int().min(-1),
  }),
  result: z.object({
    /** In `seq` order. Each event also carries its own type-specific fields. */
    events: z.array(RuntimeEventBaseSchema.loose()),
    /** False when the buffer no longer holds every event after `afterSeq`. */
    complete: z.boolean(),
    /** The newest `seq` emitted so far, or -1 before the first event. */
    lastSeq: z.number().int().min(-1),
  }),
});
