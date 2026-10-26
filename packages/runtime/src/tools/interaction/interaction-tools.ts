import { PlanItemSchema } from "@jesutobits/protocol";
import { z } from "zod";
import type { ToolDefinition } from "../common/types.js";

const PlanInput = z.object({ items: z.array(PlanItemSchema).min(1).max(30) });

export const updatePlan: ToolDefinition<z.output<typeof PlanInput>> = {
  name: "update_plan",
  description:
    "Show your plan for multi-step work as a checklist the user can follow (FR-035). Send the whole list each time, with each item's status: pending, in_progress, done or skipped. Keep at most one item in_progress. Skip it for one-step tasks.",
  input: PlanInput,
  timeoutMs: 5_000,
  activity: "planning",
  classify: async () => ({ classes: [] }),
  async execute(input, ctx) {
    const ids = new Set(input.items.map((item) => item.id));
    if (ids.size !== input.items.length) {
      return {
        ok: false,
        error: { code: "invalid_input", message: "Plan item IDs must be unique", retryable: true },
        modelText: "Error (invalid_input): Plan item IDs must be unique",
      };
    }
    ctx.setPlan(input.items);
    const done = input.items.filter((item) => item.status === "done").length;
    return {
      ok: true,
      modelText: `Plan updated: ${done} of ${input.items.length} done.`,
      outputPreview: `${input.items.length} steps`,
    };
  },
  summarize: (input, result) =>
    result?.ok ? `Updated plan: ${input.items.length} steps` : "Updating the plan",
};

const AskInput = z.object({
  question: z.string().min(1).max(2000),
  options: z.array(z.string().min(1).max(200)).max(6).default([]),
});

export const askUser: ToolDefinition<z.output<typeof AskInput>> = {
  name: "ask_user",
  description:
    "Ask the user a clarifying question and wait for the answer (FR-036). Use it only when you cannot make a reasonable choice yourself; offer options when the answer is one of a few choices. The answer arrives as this tool's result.",
  input: AskInput,
  // The wait for the answer is the harness's, not the tool's.
  timeoutMs: 5_000,
  activity: "asking",
  classify: async () => ({ classes: [] }),
  async execute(input, ctx) {
    const questionId = ctx.askUser(input.question, input.options);
    return { ok: true, modelText: "", awaitUser: { questionId } };
  },
  summarize: (input) =>
    `Asked: ${input.question.length > 80 ? `${input.question.slice(0, 77)}...` : input.question}`,
};
