import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { MockHostBridge } from "./host-bridge";

describe("App", () => {
  it("shows the runtime status the Host reports and reports its first render", () => {
    const bridge = new MockHostBridge();
    render(<App bridge={bridge} />);

    expect(screen.getAllByRole("status")[0]?.textContent).toBe("Ready");
    expect(bridge.readyReports).toBe(1);

    act(() => bridge.setStatus({ status: "failed", detail: "exit 1" }));
    expect(screen.getAllByRole("status")[0]?.textContent).toBe("Agent runtime stopped (exit 1)");
    expect(screen.getByRole("button", { name: "Restart runtime" })).toBeTruthy();
  });
});
