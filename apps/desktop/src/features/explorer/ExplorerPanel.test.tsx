import type { DirEntry, Project } from "@jesutobits/protocol";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockHostBridge } from "../../host-bridge";
import { createWorkbench, WorkbenchProvider } from "../../state/workbench-context";
import { absolutePath, ExplorerPanel } from "./ExplorerPanel";

const project: Project = {
  id: "prj_01JAAAAAAAAAAAAAAAAAAAAAAA",
  path: "c:\\work\\big",
  name: "big",
  kind: "project",
  trust: "trusted",
  createdByJesutobits: false,
  lastOpenedAt: null,
  missing: false,
};

describe("ExplorerPanel", () => {
  it("renders only the rows in view for a folder with 5,000 files (NFR-019)", async () => {
    const bridge = new MockHostBridge();
    const entries: DirEntry[] = Array.from({ length: 5000 }, (_, i) => ({
      name: `file-${String(i).padStart(4, "0")}.ts`,
      path: `file-${String(i).padStart(4, "0")}.ts`,
      kind: "file",
      link: false,
      outside: false,
      ignored: false,
    }));
    bridge.handle("projects.open", () => ({ project, needsTrustDecision: false }));
    bridge.handle("projects.detect", () => {
      throw new Error("not needed");
    });
    bridge.handle("fs.listDir", () => ({ entries }));
    const workbench = createWorkbench(bridge);
    await workbench.projects.getState().openRecent(project.id);

    render(
      <WorkbenchProvider value={workbench}>
        <ExplorerPanel />
      </WorkbenchProvider>,
    );

    const first = await screen.findByRole("treeitem", { name: "file-0000.ts" });
    expect(first.getAttribute("aria-setsize")).toBe("5000");
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(100);
  });
});

describe("absolutePath", () => {
  it("joins with the project's own separators", () => {
    expect(absolutePath("c:\\work\\big", "src/lib/a.ts")).toBe("c:\\work\\big\\src\\lib\\a.ts");
    expect(absolutePath("/home/ada/big", "src/a.ts")).toBe("/home/ada/big/src/a.ts");
    expect(absolutePath("/home/ada/big", "")).toBe("/home/ada/big");
  });
});
