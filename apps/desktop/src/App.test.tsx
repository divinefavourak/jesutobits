import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { MockHostBridge } from "./host-bridge";
import { createProjectStore } from "./state/project-store";

describe("App", () => {
  it("shows the runtime status the Host reports and reports its first render", () => {
    const bridge = new MockHostBridge();
    render(<App bridge={bridge} projects={createProjectStore(bridge)} />);

    expect(screen.getByRole("status").textContent).toBe("Ready");
    expect(bridge.readyReports).toBe(1);

    act(() => bridge.setStatus({ status: "failed", detail: "exit 1" }));
    expect(screen.getByRole("status").textContent).toBe("Agent runtime stopped (exit 1)");
    expect(screen.getByRole("alert").textContent).toContain("could not restart by itself");
    expect(screen.getByRole("button", { name: "Restart runtime" })).toBeTruthy();
  });
});
