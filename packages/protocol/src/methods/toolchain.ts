import { z } from "zod";
import { defineMethod } from "./define.js";

/**
 * The system toolchain user projects run with (FR-010, ADR-0011): Git, Node.js and the
 * package managers, found on PATH with their versions. Never fails for a missing tool.
 */
export const toolchainDetect = defineMethod({
  name: "toolchain.detect",
  description: "Which of Git, Node.js and the package managers are installed, with versions.",
  callers: ["workbench"],
  params: z.object({}),
  result: z.object({
    tools: z.array(
      z.object({
        name: z.enum(["git", "node", "npm", "pnpm", "yarn", "bun"]),
        found: z.boolean(),
        version: z.string().optional(),
        path: z.string().optional(),
      }),
    ),
  }),
});
