import type { PreviewStatus } from "@jesutobits/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MockHostBridge } from "../host-bridge";
import { PreviewApp } from "./PreviewApp";

function setup(status: PreviewStatus) {
  const bridge = new MockHostBridge();
  const calls: string[] = [];
  bridge.handle("preview.get", () => status);
  bridge.handle("preview.start", () => {
    calls.push("start");
    return { ...status, state: "starting" as const };
  });
  render(<PreviewApp bridge={bridge} />);
  return { bridge, calls };
}

const STOPPED: PreviewStatus = {
  state: "stopped",
  strategy: null,
  url: null,
  detail: null,
  log: [],
};

describe("PreviewApp", () => {
  it("rests until the user starts it", async () => {
    const { calls } = setup(STOPPED);
    expect(await screen.findByRole("heading", { name: "Your preview is resting" })).toBeTruthy();
    expect(screen.getByText("Not running")).toBeTruthy();

    // One Start button, in the empty state; the toolbar has nothing to stop.
    const buttons = screen.getAllByRole("button", { name: /Start preview/ });
    expect(buttons).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
    await userEvent.click(buttons[0]!);
    await waitFor(() => expect(calls).toEqual(["start"]));
  });

  it("shows the running app's real address and toggles Inspect", async () => {
    setup({
      state: "ready",
      strategy: "vite-react",
      url: "http://127.0.0.1:5173/",
      detail: null,
      log: [],
    });
    expect(await screen.findByText("127.0.0.1:5173")).toBeTruthy();
    expect(screen.getByTitle("Preview")).toBeTruthy();
    expect(screen.getByText("Your idea, in living colour")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Inspect" }));
    expect(screen.getByRole("button", { name: "Exit Inspect" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByText("Click something in your app to select it")).toBeTruthy();
  });

  it("explains a failed start in words", async () => {
    setup({ ...STOPPED, state: "failed", detail: "No dev script in package.json" });
    expect(
      await screen.findByRole("heading", { name: "The preview could not start" }),
    ).toBeTruthy();
    expect(screen.getByText(/No dev script in package.json/)).toBeTruthy();
  });
});
