import { z } from "zod";
import { errorResult } from "../common/paths.js";
import { toolError, type ToolDefinition } from "../common/types.js";

const SearchInput = z.object({
  query: z.string().min(1).max(1000),
  isRegex: z.boolean().default(false),
  glob: z.string().min(1).max(500).optional().describe("Only files matching, e.g. src/**/*.ts"),
  caseSensitive: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(200),
});

export const searchText: ToolDefinition<z.output<typeof SearchInput>> = {
  name: "search_text",
  description:
    "Search file contents across the project (ripgrep). Plain text by default; set isRegex for a regular expression. Ignored files (node_modules, build output, .gitignore) are skipped. Returns path:line:column and the line. Use it to find where something is defined or used before reading files.",
  input: SearchInput,
  timeoutMs: 45_000,
  activity: "reading",
  classify: async () => ({ classes: ["read"] }),
  async execute(input, ctx, signal) {
    if (!ctx.searchText) return toolError("not_supported", "Text search is not available");
    let outcome;
    try {
      outcome = await ctx.searchText(
        {
          query: input.query,
          isRegex: input.isRegex,
          caseSensitive: input.caseSensitive,
          limit: input.limit,
          ...(input.glob !== undefined && { glob: input.glob }),
        },
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      return errorResult(error);
    }
    if (outcome.matches.length === 0) {
      return { ok: true, modelText: "No matches.", outputPreview: "0 matches" };
    }
    const lines = outcome.matches.map(
      (match) => `${match.path}:${match.line}:${match.column}: ${match.text}`,
    );
    const redacted = ctx.redact(lines.join("\n"));
    const more = outcome.truncated
      ? `\nMore matches exist than the ${input.limit} shown; narrow the query or the glob.`
      : "";
    const count = `${outcome.matches.length}${outcome.truncated ? "+" : ""} matches`;
    return {
      ok: true,
      modelText: `${redacted.text}${more}`,
      outputPreview: count,
      hiddenSecrets: redacted.hidden,
    };
  },
  summarize: (input, result) =>
    result?.ok
      ? `Searched for "${input.query}" (${result.outputPreview ?? ""})`
      : `Searching for "${input.query}"`,
};
