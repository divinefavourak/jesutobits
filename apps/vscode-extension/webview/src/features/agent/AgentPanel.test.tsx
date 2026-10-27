import {
  ErrorCodes,
  JesutobitsError,
  type MethodParams,
  type Project,
  type RuntimeEventBase,
  type Session,
} from "@jesutobits/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockHostBridge } from "../../host-bridge";
import { createWorkbench, WorkbenchProvider } from "../../state/workbench-context";
import { OPENROUTER_REF } from "./agent-store";
import { AgentPanel } from "./AgentPanel";
import {
  at,
  CALL_ID,
  fileChange,
  modelStepCompleted,
  SESSION_ID,
  summary,
  toolCompleted,
  toolStarted,
  TURN_ID,
  turnCompleted,
  turnStarted,
} from "./test-events";

const PROJECT: Project = {
  id: "prj_01JABCDEFGHJKMNPQRSTVWXYZ0",
  path: "c:\\work\\habits",
  name: "habits",
  kind: "project",
  trust: "trusted",
  createdByJesutobits: false,
  lastOpenedAt: "2026-10-20T10:00:00.000Z",
  missing: false,
};

const SESSION: Session = {
  id: SESSION_ID,
  projectId: PROJECT.id,
  title: "First session",
  providerId: "openrouter",
  modelId: "openai/gpt-5",
  createdAt: at(0),
  updatedAt: at(10),
  archived: false,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
};

interface PanelOptions {
  history?: RuntimeEventBase[];
  /** False leaves the credential store empty, for the no-key notice. */
  withKey?: boolean;
}

async function setupPanel(options: PanelOptions = {}) {
  const bridge = new MockHostBridge();
  bridge.handle("sessions.list", () => ({ sessions: [SESSION] }));
  bridge.handle("sessions.history", () => ({ events: options.history ?? [], next: null }));

  const sends: Array<MethodParams<"agent.sendMessage">> = [];
  bridge.handle("agent.sendMessage", (params) => {
    sends.push(params);
    return { turnId: TURN_ID };
  });
  const cancels: Array<MethodParams<"agent.cancelTurn">> = [];
  bridge.handle("agent.cancelTurn", (params) => {
    cancels.push(params);
    return {};
  });

  if (options.withKey !== false) {
    bridge.storeSecret(OPENROUTER_REF, "sk-or-test-not-real");
  }

  const workbench = createWorkbench(bridge);
  bridge.openProject(PROJECT);
  await vi.waitFor(() => {
    expect(workbench.agent.getState().activeSessionId).toBe(SESSION_ID);
    expect(workbench.agent.getState().loadingHistory).toBe(false);
  });

  render(
    <WorkbenchProvider value={workbench}>
      <AgentPanel />
    </WorkbenchProvider>,
  );
  return { bridge, workbench, sends, cancels };
}

const completedTurn = (): RuntimeEventBase[] => [
  turnStarted({ seq: 1, text: "Make the title bold" }),
  modelStepCompleted({ seq: 2, step: 0, text: "Here is **bold** text." }),
  turnCompleted({ seq: 3, summary: summary() }),
];

const turnWithTools = (): RuntimeEventBase[] => [
  turnStarted({ seq: 1, text: "Fix the tests" }),
  toolStarted({ seq: 2, callId: CALL_ID, category: "editing", summary: "Editing src/a.ts" }),
  toolCompleted({
    seq: 3,
    callId: CALL_ID,
    ok: true,
    durationMs: 1_200,
    summary: "Edited src/a.ts (+2 −1)",
    diff: [fileChange({ path: "src/a.ts" })],
  }),
  toolStarted({
    seq: 4,
    callId: "call_01JAB2C3D4E5F6G7H8J9K0M1N8",
    category: "testing",
    tool: "run_command",
    summary: "Running the tests",
  }),
  toolCompleted({
    seq: 5,
    callId: "call_01JAB2C3D4E5F6G7H8J9K0M1N8",
    tool: "run_command",
    ok: false,
    durationMs: 800,
    summary: "Tests failed",
    error: { code: "process_failed", message: "Exit code 1", retryable: false },
  }),
  turnCompleted({ seq: 6, summary: summary({ files: [fileChange({ path: "src/a.ts" })] }) }),
];

beforeEach(() => {
  Element.prototype.scrollIntoView = () => undefined;
});

describe("AgentPanel (UX_AND_INTERFACE.md section 6)", () => {
  it("shows the user's message, the assistant's Markdown and the turn summary", async () => {
    await setupPanel({ history: completedTurn() });

    expect(screen.getByText("Make the title bold")).toBeTruthy();
    const strong = screen.getByText("bold");
    expect(strong.tagName).toBe("STRONG");
    expect(screen.getByText("No files changed")).toBeTruthy();
  });

  it("lists tool rows in the Timeline tab and filters them by changes and errors", async () => {
    await setupPanel({ history: turnWithTools() });

    await userEvent.click(screen.getByRole("tab", { name: "Activity" }));

    expect(screen.getByText("Edited src/a.ts (+2 −1)")).toBeTruthy();
    expect(screen.getByText("Tests failed")).toBeTruthy();

    await userEvent.click(screen.getByRole("radio", { name: "Changes" }));
    expect(screen.getByText("Edited src/a.ts (+2 −1)")).toBeTruthy();
    expect(screen.queryByText("Tests failed")).toBeNull();

    await userEvent.click(screen.getByRole("radio", { name: "Errors" }));
    expect(screen.getByText("Tests failed")).toBeTruthy();
    expect(screen.queryByText("Edited src/a.ts (+2 −1)")).toBeNull();

    await userEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(screen.getByText("Edited src/a.ts (+2 −1)")).toBeTruthy();
    expect(screen.getByText("Tests failed")).toBeTruthy();
  });

  it("sends on Ctrl+Enter, not on plain Enter", async () => {
    const { sends } = await setupPanel({ history: completedTurn() });
    const composer = screen.getByLabelText("Message to the agent");

    await userEvent.type(composer, "Change the title");
    await userEvent.keyboard("{Enter}");
    expect(sends).toHaveLength(0);

    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      sessionId: SESSION_ID,
      text: "Change the title",
      mode: "agent",
    });
  });

  it("replaces Send with Stop while a turn is live, and Stop cancels that turn", async () => {
    const { cancels } = await setupPanel({
      history: [turnStarted({ seq: 1, text: "Hello" })],
    });

    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => expect(cancels).toHaveLength(1));
    expect(cancels[0]).toEqual({ turnId: TURN_ID });
  });

  it("asks for the key in the extension's password box when none is stored", async () => {
    const { bridge } = await setupPanel({ withKey: false });
    bridge.nextPromptedKey = "sk-or-test-not-real";

    expect(await screen.findByText(/No OpenRouter API key is stored/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Add API key" }));

    await waitFor(async () => expect(await bridge.secrets.exists(OPENROUTER_REF)).toBe(true));
    expect(document.body.textContent).not.toContain("sk-or-test-not-real");
  });

  it("switches the store's mode from the Agent/Ask radio group", async () => {
    const { workbench } = await setupPanel({ history: completedTurn() });

    const group = screen.getByRole("radiogroup", { name: "Mode" });
    await userEvent.click(within(group).getByRole("radio", { name: "Ask" }));
    expect(workbench.agent.getState().mode).toBe("ask");

    await userEvent.click(within(group).getByRole("radio", { name: "Agent" }));
    expect(workbench.agent.getState().mode).toBe("agent");
  });

  it("sends the user to the default-model setting when no model is chosen", async () => {
    const { bridge } = await setupPanel({ history: completedTurn() });
    bridge.handle("agent.sendMessage", () => {
      throw new JesutobitsError(
        ErrorCodes.providerNoModel,
        "Choose a default model for the agent first.",
        {
          userAction: "open_settings",
        },
      );
    });

    await userEvent.type(screen.getByLabelText("Message to the agent"), "Hello");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Choose a default model");

    await userEvent.click(within(alert).getByRole("button", { name: "Open settings" }));
    expect(bridge.openedSettings).toEqual(["jesutobits.providers.openrouter.defaultModel"]);
  });

  it("offers the key prompt when OpenRouter rejects the key", async () => {
    const { bridge } = await setupPanel({ history: completedTurn() });
    bridge.handle("agent.sendMessage", () => {
      throw new JesutobitsError(ErrorCodes.providerAuth, "OpenRouter did not accept the API key.", {
        userAction: "open_settings",
      });
    });
    bridge.nextPromptedKey = "sk-or-new-not-real";

    await userEvent.type(screen.getByLabelText("Message to the agent"), "Hello");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    const alert = await screen.findByRole("alert");
    await userEvent.click(within(alert).getByRole("button", { name: "Add my key" }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(document.body.textContent).not.toContain("sk-or-new-not-real");
  });
});
