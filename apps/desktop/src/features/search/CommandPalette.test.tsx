import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MockHostBridge } from "../../host-bridge";
import type { Command } from "../../state/commands";
import { createWorkbench, WorkbenchProvider } from "../../state/workbench-context";
import { CommandPalette } from "./CommandPalette";

function setup(commands: Command[]) {
  const workbench = createWorkbench(new MockHostBridge());
  workbench.ui.getState().show("commands");
  render(
    <WorkbenchProvider value={workbench}>
      <CommandPalette commands={commands} />
    </WorkbenchProvider>,
  );
  return workbench;
}

describe("CommandPalette", () => {
  it("lists enabled commands with shortcuts, filters as you type and runs the pick", async () => {
    const save = vi.fn();
    const reset = vi.fn();
    const workbench = setup([
      { id: "file.save", title: "command.file.save", keys: "Ctrl+S", run: save },
      { id: "file.saveAll", title: "command.file.saveAll", enabled: () => false, run: vi.fn() },
      { id: "layout.reset", title: "command.layout.reset", run: reset },
    ]);

    const input = screen.getByRole("combobox", { name: "Command palette" });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "File: SaveCtrl+S",
      "View: Reset layout",
    ]);

    await userEvent.type(input, "reset");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(input.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option").id);

    await userEvent.keyboard("{Enter}");
    expect(workbench.ui.getState().overlay).toBeNull();
    await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce());
    expect(save).not.toHaveBeenCalled();
  });

  it("moves with the arrow keys and says when nothing matches", async () => {
    setup([
      { id: "a", title: "command.file.save", run: vi.fn() },
      { id: "b", title: "command.layout.reset", run: vi.fn() },
    ]);
    const options = () => screen.getAllByRole("option");
    // (jsdom's dialog does not move focus the way showModal does in a browser.)
    await userEvent.click(screen.getByRole("combobox"));
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{ArrowDown}");
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{ArrowDown}");
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");

    await userEvent.type(screen.getByRole("combobox"), "zzz");
    expect(screen.getByText("No command matches.")).toBeTruthy();
  });
});
