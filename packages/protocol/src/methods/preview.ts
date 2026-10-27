import { z } from "zod";
import { defineMethod } from "./define.js";

/** Where a project's preview is (ROADMAP Phase 4, VISUAL_EDITING.md section 4). */
export const PreviewStateSchema = z.enum(["stopped", "starting", "ready", "failed"]);
export type PreviewState = z.infer<typeof PreviewStateSchema>;

export const PreviewStatusSchema = z.object({
  state: PreviewStateSchema,
  /** `vite-react` runs the project's Vite with visual editing; `generic` runs its dev script. */
  strategy: z.enum(["vite-react", "generic"]).nullable(),
  /** Loopback only; set once the dev server answers. */
  url: z.string().url().nullable(),
  /** Plain language, for `failed` (and why visual editing is off, when it is). */
  detail: z.string().nullable(),
  /** The last lines the dev server printed, for the logs view and failures. */
  log: z.array(z.string()).max(200),
});
export type PreviewStatus = z.infer<typeof PreviewStatusSchema>;

/** Starts the active project's dev server, or returns the running one. */
export const previewStart = defineMethod({
  name: "preview.start",
  description: "Start the active project's preview (its dev server) and wait until it answers.",
  callers: ["workbench"],
  params: z.object({}),
  result: PreviewStatusSchema,
});

export const previewStop = defineMethod({
  name: "preview.stop",
  description: "Stop the active project's preview.",
  callers: ["workbench"],
  params: z.object({}),
  result: PreviewStatusSchema,
});

export const previewGet = defineMethod({
  name: "preview.get",
  description: "The active project's preview status.",
  callers: ["workbench"],
  params: z.object({}),
  result: PreviewStatusSchema,
});

/**
 * Replaces the Tailwind classes of one JSX element (VISUAL_EDITING.md section 7), found by
 * its `data-jesutobits-loc`. Only the user's own action in Jesutobits' inspector calls this;
 * the preview's bridge can only report a selection (invariant 8).
 */
export const visualSetClasses = defineMethod({
  name: "visual.setClasses",
  description: "Change the classes of the JSX element at a source location.",
  callers: ["workbench"],
  params: z.object({
    /** `src/Hero.tsx:24:7`, from the element's `data-jesutobits-loc`. */
    loc: z.string().min(5).max(1024),
    remove: z.array(z.string().min(1).max(200)).max(100),
    add: z.array(z.string().min(1).max(200)).max(100),
  }),
  result: z.object({ path: z.string(), changed: z.boolean() }),
});
