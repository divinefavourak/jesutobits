import { z } from "zod";
import { defineMethod } from "./define.js";

/** Where a project's preview is (ROADMAP Phase 4, VISUAL_EDITING.md section 4). */
/** `running`: a program without a web page (a CLI, a game window); its output is the preview. */
export const PreviewStateSchema = z.enum(["stopped", "starting", "ready", "running", "failed"]);
export type PreviewState = z.infer<typeof PreviewStateSchema>;

/** A start command: the program and its arguments, run without a shell like `run_command`. */
export const PreviewCommandSchema = z.array(z.string().min(1).max(4000)).min(1).max(50);

export const PreviewStatusSchema = z.object({
  state: PreviewStateSchema,
  /**
   * `vite-react` runs the project's Vite with visual editing; `generic` runs its dev script;
   * `static` serves its files (an `index.html` site); `command` runs the saved start command.
   */
  strategy: z.enum(["vite-react", "generic", "static", "command"]).nullable(),
  /** What runs, for `generic` and `command`; the folder served, for `static`. */
  command: z.string().max(4000).nullable().optional(),
  /** Loopback only; set once the dev server answers. */
  url: z.string().url().nullable(),
  /** Plain language, for `failed` (and why visual editing is off, when it is). */
  detail: z.string().nullable(),
  /** The last lines the dev server printed, for the logs view and failures. */
  log: z.array(z.string()).max(200),
});
export type PreviewStatus = z.infer<typeof PreviewStatusSchema>;

/**
 * Starts the active project's dev server, or returns the running one. `command` is what the
 * user typed in the preview panel for a project Jesutobits cannot start by itself; it is
 * saved for the project and replaces the running preview.
 */
export const previewStart = defineMethod({
  name: "preview.start",
  description: "Start the active project's preview (its dev server) and wait until it answers.",
  callers: ["workbench"],
  params: z.object({ command: PreviewCommandSchema.optional() }),
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
