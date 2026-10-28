import { z } from "zod";
import { errorResult } from "../common/paths.js";
import { toolError, type ToolDefinition } from "../common/types.js";

const StartPreviewInput = z.object({
  command: z
    .array(z.string().min(1).max(4000))
    .min(1)
    .max(50)
    .optional()
    .describe(
      'Only for a project without a dev/start script or index.html: the program that starts it and its arguments, e.g. ["python", "app.py"] or ["go", "run", "."]. No shell. Saved for this project, so later previews reuse it.',
    ),
});

/**
 * Starts the project's dev server in the preview panel (ROADMAP Phase 4). It runs project
 * code, so it is `execute` like any command, and never in Restricted Mode.
 */
export const startPreview: ToolDefinition<z.output<typeof StartPreviewInput>> = {
  name: "start_preview",
  description:
    "Start the project's app and show it in Jesutobits' preview panel: the dev or start script, a plain index.html site (served with live reload), or the given command for anything else (Python, Go, a game...). Returns its local URL, its output when it has no web page, or the last output if it failed. Use it after making changes so the user can see them, instead of running a server with run_command. Calling it again while the preview runs just returns its URL; passing a command replaces it.",
  input: StartPreviewInput,
  timeoutMs: 120_000,
  activity: "previewing",
  availability: { requiresTrust: true },
  classify: async (input) =>
    input.command
      ? {
          classes: ["execute"],
          action: { kind: "command", argv: input.command, cwd: ".", shell: false },
        }
      : { classes: ["execute"] },
  async execute(input, ctx) {
    if (!ctx.startPreview) return toolError("not_supported", "Previews are not available here");
    let status;
    try {
      status = await ctx.startPreview(input.command);
    } catch (error) {
      return errorResult(error);
    }
    if (status.state === "ready" && status.url) {
      const visual =
        status.strategy === "vite-react"
          ? " Visual editing is on: the user can click elements in the preview to inspect and edit them."
          : "";
      return {
        ok: true,
        modelText: `The preview is running at ${status.url} and is shown to the user.${visual}`,
        outputPreview: status.url,
      };
    }
    if (status.state === "running") {
      const output = ctx.redact(status.log.slice(-40).join("\n")).text;
      return {
        ok: true,
        modelText: `The program is running but printed no web address, so the preview shows its output to the user.${output ? `\nOutput so far:\n${output}` : ""}`,
        outputPreview: status.command ?? "running",
      };
    }
    const log = ctx.redact(status.log.slice(-40).join("\n")).text;
    return toolError(
      "process_failed",
      `The preview did not start: ${status.detail ?? "unknown reason"}${log ? `\nLast output:\n${log}` : ""}`,
    );
  },
  summarize: (input, result) =>
    result?.ok
      ? `Started the preview: ${result.outputPreview ?? ""}`
      : input.command
        ? `Starting the preview with ${input.command.join(" ")}`
        : "Starting the preview",
};
