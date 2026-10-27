import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MockHostBridge } from "../../host-bridge";
import { StudioSidebar } from "./StudioSidebar";

function setup() {
  const bridge = new MockHostBridge();
  render(<StudioSidebar bridge={bridge} />);
  return { bridge };
}

describe("StudioSidebar", () => {
  it("starts a new project and goes to the Studio's places", async () => {
    const { bridge } = setup();
    await userEvent.click(screen.getByRole("button", { name: /New project/ }));
    await userEvent.click(screen.getByRole("button", { name: /Recent projects/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Learning Centre/ }));
    await userEvent.click(screen.getByRole("button", { name: /Visit the Learning Centre/ }));
    await userEvent.click(screen.getByRole("button", { name: /Change the look/ }));
    expect(bridge.projectStarts).toEqual(["new"]);
    expect(bridge.navigations).toEqual(["recent", "learning", "learning", "look"]);
  });

  it("says how the co-builder really is, and offers a restart when it stopped", async () => {
    const { bridge } = setup();
    expect(screen.getByRole("status").textContent).toBe("Everything's looking good");
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();

    act(() => bridge.setStatus({ status: "failed", detail: "exited" }));
    expect(screen.getByRole("status").textContent).toBe("Your co-builder stopped");
    expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy();
  });

  it("opens the beginner's tip and leaves its idea in the message box", async () => {
    const { bridge } = setup();
    await userEvent.click(screen.getByRole("button", { name: "A beginner's tip" }));
    expect(screen.getByRole("heading", { name: "You don't have to start big." })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Let's try an idea/ }));
    expect(bridge.composed).toEqual(["Help me build a homepage for my favourite hobby."]);
    expect(screen.queryByRole("heading", { name: "You don't have to start big." })).toBeNull();
  });
});
