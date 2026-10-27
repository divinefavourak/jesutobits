import { isAbsolute, relative, resolve } from "node:path";
import { ErrorCodes, JesutobitsError } from "@jesutobits/protocol";
import { z } from "zod";
import { errorResult } from "../common/paths.js";
import { toolError, type ToolDefinition } from "../common/types.js";

/** The model sees the end of long output, where errors and summaries usually are. */
const MAX_MODEL_OUTPUT = 12_000;

const RunInput = z.object({
  argv: z
    .array(z.string().min(1).max(4000))
    .min(1)
    .max(200)
    .describe(
      'The program and its arguments, e.g. ["npm", "test"] or ["npx", "tsc", "--noEmit"]. No shell: pipes, &&, redirects and globs do not work.',
    ),
  cwd: z.string().max(1000).default(".").describe("Folder to run in, relative to the project root"),
  timeoutSeconds: z.number().int().min(1).max(600).default(120),
});

type RunCommandInput = z.output<typeof RunInput>;

/** `cwd` relative to the project root, or undefined when it leaves the project. */
function confine(root: string, cwd: string): string | undefined {
  const inside = relative(resolve(root), resolve(root, cwd));
  if (inside.startsWith("..") || isAbsolute(inside)) return undefined;
  return inside === "" ? "." : inside.replaceAll("\\", "/");
}

/**
 * Runs a program in the project (ROADMAP Phase 3, ADR-0011): argv only, no shell, always
 * approved by the user (`execute`), never in Restricted Mode. A non-zero exit is a result
 * for the model to read, not a tool error.
 */
export const runCommand: ToolDefinition<RunCommandInput> = {
  name: "run_command",
  description:
    "Run a program in the project and get its exit code and output: install dependencies, run tests, type-check, lint or build. Pass argv as a list (no shell). The user approves every command. Do not use it to read or write files (use the file tools) or to start long-running servers such as dev servers (use start_preview).",
  input: RunInput,
  timeoutMs: 610_000,
  activity: "running",
  availability: { requiresTrust: true },
  async classify(input, ctx) {
    const cwd = confine(ctx.projectRoot, input.cwd);
    if (cwd === undefined) {
      return { classes: ["execute"], prohibited: "The folder is outside the project." };
    }
    return {
      classes: ["execute"],
      action: { kind: "command", argv: input.argv, cwd, shell: false },
    };
  },
  async execute(input, ctx, signal) {
    if (!ctx.runCommand) return toolError("not_supported", "Commands cannot run here");
    const cwd = confine(ctx.projectRoot, input.cwd);
    if (cwd === undefined) {
      return toolError("outside_workspace", "The folder is outside the project");
    }
    let result;
    try {
      result = await ctx.runCommand(input.argv, {
        cwd: resolve(ctx.projectRoot, cwd),
        timeoutMs: input.timeoutSeconds * 1000,
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof JesutobitsError) {
        if (error.code === ErrorCodes.processNotFound) {
          return toolError("not_found", `${input.argv[0]} is not installed or not on PATH`);
        }
        if (error.code === ErrorCodes.processTimeout) {
          return toolError(
            "timeout",
            `${input.argv.join(" ")} did not finish within ${input.timeoutSeconds} s and was stopped`,
            { retryable: true },
          );
        }
        if (error.code === ErrorCodes.processInvalidCommand) {
          return toolError("invalid_input", error.message);
        }
      }
      return errorResult(error);
    }
    const combined = [result.stdout, result.stderr].filter((part) => part.trim() !== "").join("\n");
    const tail =
      combined.length > MAX_MODEL_OUTPUT
        ? `[… ${combined.length - MAX_MODEL_OUTPUT} earlier characters omitted]\n${combined.slice(-MAX_MODEL_OUTPUT)}`
        : combined;
    const redacted = ctx.redact(tail);
    const exit = result.exitCode === null ? "stopped by a signal" : `exit code ${result.exitCode}`;
    const seconds = (result.durationMs / 1000).toFixed(1);
    return {
      ok: true,
      modelText: `${exit} after ${seconds} s${result.truncated ? " (output truncated)" : ""}\n${redacted.text || "(no output)"}`,
      outputPreview: exit,
      hiddenSecrets: redacted.hidden,
    };
  },
  summarize: (input, result) =>
    result?.ok
      ? `Ran ${input.argv.join(" ")} (${result.outputPreview ?? ""})`
      : `Running ${input.argv.join(" ")}`,
};
