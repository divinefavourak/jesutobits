import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockHostBridge } from "../../host-bridge";
import { createWorkbench, WorkbenchProvider } from "../../state/workbench-context";
import { QuickOpen } from "./QuickOpen";

describe("QuickOpen", () => {
  it("asks again while the index is building, so the note goes away when it is done", async () => {
    const bridge = new MockHostBridge();
    let calls = 0;
    bridge.handle("fs.quickOpen", () => {
      calls += 1;
      const indexing = calls < 2;
      return {
        results: indexing ? [] : [{ path: "src/App.tsx", score: 1, positions: [] }],
        indexing,
        complete: true,
      };
    });
    const workbench = createWorkbench(bridge);
    workbench.ui.getState().show("files");
    render(
      <WorkbenchProvider value={workbench}>
        <QuickOpen />
      </WorkbenchProvider>,
    );

    expect(await screen.findByText(/Still listing the project's files/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("option").textContent).toContain("App.tsx"), {
      timeout: 3000,
    });
    expect(screen.queryByText(/Still listing the project's files/)).toBeNull();
    expect(calls).toBe(2);
  });
});
