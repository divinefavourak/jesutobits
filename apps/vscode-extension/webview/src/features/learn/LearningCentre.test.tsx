import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MockHostBridge } from "../../host-bridge";
import { LearningCentre } from "./LearningCentre";

function setup() {
  const bridge = new MockHostBridge();
  const asked: string[] = [];
  render(<LearningCentre bridge={bridge} onAsk={(text) => asked.push(text)} />);
  return { bridge, asked };
}

describe("LearningCentre", () => {
  it("lists the lessons and opens one", async () => {
    setup();
    expect(screen.getByText("0 of 4 lessons completed")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Make it feel like you/ }));
    expect(
      screen.getByRole("heading", { name: "CSS is your project's personality." }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /All lessons/ }));
    expect(screen.getByRole("heading", { name: "You belong here, too." })).toBeTruthy();
  });

  it("completes a lesson on the right answer and remembers it", async () => {
    const { bridge } = setup();
    await userEvent.click(screen.getByRole("button", { name: /Let's begin/ }));

    await userEvent.click(screen.getByRole("button", { name: "package.json" }));
    expect(screen.getByRole("status").textContent).toContain("Not quite");
    expect(screen.getByText("0 of 4 lessons completed")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "index.css" }));
    expect(screen.getByRole("status").textContent).toContain("Lesson completed");
    expect(screen.getByText("1 of 4 lessons completed")).toBeTruthy();
    await waitFor(async () =>
      expect((await bridge.uiState.get())["learningCompleted"]).toEqual(["basics"]),
    );
  });

  it("opens the lesson's file in the user's project, or says it is missing", async () => {
    const { bridge } = setup();
    await userEvent.click(screen.getByRole("button", { name: /Your first component/ }));
    await userEvent.click(screen.getByRole("button", { name: "Open src/App.tsx in my project" }));
    expect(bridge.openedFiles).toEqual(["src/App.tsx"]);

    bridge.openFile = async () => {
      throw new Error("missing");
    };
    await userEvent.click(screen.getByRole("button", { name: "Open src/App.tsx in my project" }));
    expect(await screen.findByText(/This project has no src\/App.tsx yet/)).toBeTruthy();
  });

  it("asks the co-builder about the lesson", async () => {
    const { asked } = setup();
    await userEvent.click(screen.getByRole("button", { name: /Build with your co-builder/ }));
    expect(screen.queryByRole("button", { name: /in my project/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Ask my co-builder about this" }));
    expect(asked).toEqual([
      "Explain build with your co-builder using my project as an example, in simple terms.",
    ]);
  });
});
