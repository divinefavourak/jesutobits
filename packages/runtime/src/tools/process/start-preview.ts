import { z } from "zod";
import { errorResult } from "../common/paths.js";
import { toolError, type ToolDefinition } from "../common/types.js";

const StartPreviewInput = z.object({});

/**
 * Starts the project's dev server in the preview panel (ROADMAP Phase 4). It runs project
 * code, so it is `execute` like any command, and never in Restricted Mode.
 */
export const startPreview: ToolDefinition<z.output<typeof StartPreviewInput>> = {
  name: "start_preview",
  description:
    "Start the project's dev server and show the running app in Jesutobits' preview panel. Returns its local URL, or the server's last output if it failed to start. Use it after making UI changes so the user can see them, instead of running the dev script with run_command. Calling it again while the preview runs just returns its URL.",
  input: StartPreviewInput,
  timeoutMs: 120_000,
  activity: "previewing",
  availability: { requiresTrust: true },
  classify: async () => ({ classes: ["execute"] }),
  async execute(_input, ctx) {
    if (!ctx.startPreview) return toolError("not_supported", "Previews are not available here");
    let status;
    try {
      status = await ctx.startPreview();
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
    const log = ctx.redact(status.log.slice(-40).join("\n")).text;
    return toolError(
      "process_failed",
      `The preview did not start: ${status.detail ?? "unknown reason"}${log ? `\nLast output:\n${log}` : ""}`,
    );
  },
  summarize: (_input, result) =>
    result?.ok ? `Started the preview at ${result.outputPreview ?? ""}` : "Starting the preview",
};
