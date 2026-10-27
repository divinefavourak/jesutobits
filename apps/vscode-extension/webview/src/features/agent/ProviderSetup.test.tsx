import type { MethodResult, ModelInfo } from "@jesutobits/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MockHostBridge } from "../../host-bridge";
import { createWorkbench, WorkbenchProvider } from "../../state/workbench-context";
import { OPENROUTER_REF } from "./agent-store";
import { KeyForm, ModelPicker } from "./ProviderSetup";

const SECRET = "sk-or-typed-not-real";

function capabilities(tools: boolean) {
  return {
    tools,
    toolChoice: tools,
    parallelToolCalls: tools,
    vision: true,
    structuredOutputs: true,
    reasoning: false,
  };
}

const MODELS: ModelInfo[] = [
  {
    id: "openai/gpt-5-mini",
    displayName: "GPT-5 mini",
    contextWindow: 400_000,
    capabilities: capabilities(true),
    source: "provider",
  },
  {
    id: "meta/llama",
    displayName: "Llama",
    contextWindow: 128_000,
    capabilities: capabilities(false),
    pricing: { inputPerMTok: 0.2, outputPerMTok: 0.4, currency: "USD" },
    source: "provider",
  },
  {
    id: "anthropic/claude-sonnet",
    displayName: "Claude Sonnet",
    contextWindow: 200_000,
    capabilities: capabilities(true),
    pricing: { inputPerMTok: 3, outputPerMTok: 15, currency: "USD" },
    source: "provider",
  },
];

interface KeyFormOptions {
  hasKey?: boolean;
  testResult?: MethodResult<"models.testConnection">;
  /** What the extension's password box returns; null cancels. */
  promptedKey?: string | null;
}

async function setupKeyForm(options: KeyFormOptions = {}) {
  const bridge = new MockHostBridge();
  let tests = 0;
  let prompts = 0;

  const prompt = bridge.secrets.prompt;
  bridge.secrets.prompt = async (ref) => {
    prompts += 1;
    return prompt(ref);
  };

  bridge.handle("models.testConnection", () => {
    tests += 1;
    return options.testResult ?? { ok: true };
  });
  bridge.handle("models.list", () => ({ models: [], fetchedAt: null }));

  if (options.hasKey) bridge.storeSecret(OPENROUTER_REF, "sk-or-existing-not-real");
  if (options.promptedKey !== undefined) bridge.nextPromptedKey = options.promptedKey;

  const workbench = createWorkbench(bridge);
  render(
    <WorkbenchProvider value={workbench}>
      <KeyForm />
    </WorkbenchProvider>,
  );
  return { bridge, workbench, tests: () => tests, prompts: () => prompts };
}

describe("KeyForm (FR-021, FR-023, SECURITY.md section 3)", () => {
  it("stores the key typed into the extension's password box, tests it and never renders it back", async () => {
    const { bridge, tests } = await setupKeyForm({ promptedKey: SECRET });

    await userEvent.click(await screen.findByRole("button", { name: "Enter key…" }));

    await waitFor(() => expect(tests()).toBe(1));
    expect(await bridge.secrets.exists(OPENROUTER_REF)).toBe(true);
    expect(await screen.findByText("Connected to OpenRouter.")).toBeTruthy();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("stores nothing and runs no test when the key prompt is cancelled", async () => {
    const { bridge, tests, prompts } = await setupKeyForm({ promptedKey: null });

    await userEvent.click(await screen.findByRole("button", { name: "Enter key…" }));

    await waitFor(() => expect(prompts()).toBe(1));
    expect(tests()).toBe(0);
    expect(await bridge.secrets.exists(OPENROUTER_REF)).toBe(false);
    expect(screen.queryByText("Connected to OpenRouter.")).toBeNull();
  });

  it("reports the provider's error message when the connection test fails", async () => {
    await setupKeyForm({
      hasKey: true,
      testResult: {
        ok: false,
        error: { category: "auth", message: "OpenRouter rejected the key.", retryable: false },
      },
    });

    const test = await screen.findByRole("button", { name: "Test connection" });
    await waitFor(() => expect((test as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(test);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("OpenRouter rejected the key.");
  });

  it("removes the stored key", async () => {
    const { bridge } = await setupKeyForm({ hasKey: true });
    const remove = vi.spyOn(bridge.secrets, "delete");

    await userEvent.click(await screen.findByRole("button", { name: "Remove key" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith(OPENROUTER_REF));
    expect(await bridge.secrets.exists(OPENROUTER_REF)).toBe(false);
  });
});

describe("ModelPicker (FR-022)", () => {
  it("lists tools-capable models first, the others apart, with price and context", async () => {
    const bridge = new MockHostBridge();
    bridge.handle("models.list", () => ({ models: MODELS, fetchedAt: null }));
    render(
      <WorkbenchProvider value={createWorkbench(bridge)}>
        <ModelPicker />
      </WorkbenchProvider>,
    );

    const select = screen.getByLabelText("Default model") as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));

    const options = within(select).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Choose a model…",
      "Claude Sonnet · 200,000 tokens · USD 3 / 15 per million",
      "GPT-5 mini · 400,000 tokens",
      "Llama · 128,000 tokens · USD 0.2 / 0.4 per million",
    ]);

    const askOnly = screen.getByRole("group", { name: "Answers without tools" });
    expect(
      within(askOnly).getByRole("option", {
        name: "Llama · 128,000 tokens · USD 0.2 / 0.4 per million",
      }),
    ).toBeTruthy();
  });

  it("saves the chosen model as the provider's default", async () => {
    const bridge = new MockHostBridge();
    bridge.handle("models.list", () => ({ models: MODELS, fetchedAt: null }));
    render(
      <WorkbenchProvider value={createWorkbench(bridge)}>
        <ModelPicker />
      </WorkbenchProvider>,
    );

    const select = screen.getByLabelText("Default model") as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    await userEvent.selectOptions(select, "anthropic/claude-sonnet");

    expect(select.value).toBe("anthropic/claude-sonnet");
    await vi.waitFor(async () => {
      const settings = await bridge.settings.get();
      expect(settings.providers.openrouter.defaultModel).toBe("anthropic/claude-sonnet");
    });
  });
});
