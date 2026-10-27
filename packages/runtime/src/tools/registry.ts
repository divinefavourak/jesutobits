import { z } from "zod";
import type { ToolSpec } from "../providers/types.js";
import { listDirectory, readFile, searchFiles } from "./files/read-tools.js";
import { deletePath, editFile, movePath, writeFile } from "./files/write-tools.js";
import { askUser, updatePlan } from "./interaction/interaction-tools.js";
import { runCommand } from "./process/run-command.js";
import { startPreview } from "./process/start-preview.js";
import { searchText } from "./search/search-text.js";
import type { AnyTool } from "./common/types.js";

/** The built-in tools; Git and previews come later. */
export const BUILTIN_TOOLS: readonly AnyTool[] = [
  listDirectory,
  readFile,
  searchFiles,
  searchText,
  writeFile,
  editFile,
  movePath,
  deletePath,
  runCommand,
  startPreview,
  updatePlan,
  askUser,
] as unknown as readonly AnyTool[];

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  constructor(tools: readonly AnyTool[] = BUILTIN_TOOLS) {
    for (const tool of tools) {
      if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) throw new Error(`Bad tool name ${tool.name}`);
      if (this.tools.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** The tools as the model sees them; Restricted projects keep only those that need no trust. */
  specs(options: { trusted: boolean }): ToolSpec[] {
    return [...this.tools.values()]
      .filter((tool) => options.trusted || !tool.availability?.requiresTrust)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: toParameters(tool.input),
      }));
  }
}

/** JSON Schema of the input as the model writes it: defaults make fields optional. */
function toParameters(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  return json;
}
