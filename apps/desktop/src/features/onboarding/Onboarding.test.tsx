import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../../App";
import { MockHostBridge } from "../../host-bridge";
import { createWorkbench } from "../../state/workbench-context";

function setup() {
  const bridge = new MockHostBridge();
  const prepared: string[] = [];
  bridge.documentsFolder = "C:\\Users\\ada\\Documents";
  bridge.handle("projects.prepareWorkspaceFolder", ({ path }) => {
    prepared.push(path);
    return { path: path.toLowerCase(), created: true };
  });
  bridge.handle("toolchain.detect", () => ({
    tools: [
      { name: "git", found: true, version: "2.51.0" },
      { name: "node", found: false },
      { name: "npm", found: false },
      { name: "pnpm", found: false },
      { name: "yarn", found: false },
      { name: "bun", found: false },
    ],
  }));
  const workbench = createWorkbench(bridge);
  render(<App workbench={workbench} />);
  return { bridge, workbench, prepared };
}

const button = (name: string) => screen.getByRole("button", { name });

describe("Onboarding (UX_AND_INTERFACE.md section 3)", () => {
  it("walks through the steps with Back, and Skip everywhere but the workspace folder", async () => {
    const { bridge, prepared } = setup();
    expect(await screen.findByRole("heading", { name: "Welcome to Jesutobits" })).toBeTruthy();
    expect(screen.getByText("Step 1 of 7")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    await userEvent.click(button("Get started"));

    // Workspace folder: suggested in Documents, cannot be skipped, created on Continue.
    expect(await screen.findByText("C:\\Users\\ada\\Documents\\Jesutobits Projects")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    await userEvent.click(button("Continue"));
    await screen.findByRole("heading", { name: "Check your tools" });
    expect(prepared).toEqual(["C:\\Users\\ada\\Documents\\Jesutobits Projects"]);
    expect((await bridge.settings.get()).workspace.defaultFolder).toBe(
      "c:\\users\\ada\\documents\\jesutobits projects",
    );

    // Toolchain: found and missing, never blocking.
    expect(await screen.findByText("Found (2.51.0)")).toBeTruthy();
    expect(screen.getAllByText("Not found")).toHaveLength(2);
    await userEvent.click(button("Back"));
    await screen.findByRole("heading", { name: "Where new projects go" });
    await userEvent.click(button("Continue"));
    await userEvent.click(await screen.findByRole("button", { name: "Skip" }));
    await screen.findByRole("heading", { name: "Choose a model provider" });
    await userEvent.click(button("Skip"));
    await userEvent.click(await screen.findByRole("button", { name: "Skip" }));
    await screen.findByRole("heading", { name: "Choose a look" });
    expect(screen.getByRole("radio", { name: "Follow system" })).toBeTruthy();
    await userEvent.click(button("Continue"));
    await screen.findByRole("heading", { name: "Your first project" });

    await userEvent.click(button("Finish and go to the start screen"));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Recent projects" })).toBeTruthy(),
    );
  });

  it("asks for a folder when there is no Documents folder to suggest", async () => {
    const { bridge } = setup();
    bridge.documentsFolder = null;
    await userEvent.click(await screen.findByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Where new projects go" });
    expect(screen.getByText("No folder chosen")).toBeTruthy();
    expect((button("Continue") as HTMLButtonElement).disabled).toBe(true);
  });
});
