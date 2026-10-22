import type { Project } from "@jesutobits/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../../App";
import { MockHostBridge } from "../../host-bridge";
import { createWorkbench } from "../../state/workbench-context";

const habits: Project = {
  id: "prj_01JABCDEFGHJKMNPQRSTVWXYZ0",
  path: "c:\\work\\habits",
  name: "habits",
  kind: "project",
  trust: "unknown",
  createdByJesutobits: false,
  lastOpenedAt: null,
  missing: false,
};
const notes: Project = {
  ...habits,
  id: "prj_01JABCDEFGHJKMNPQRSTVWXYZ1",
  path: "c:\\gone\\notes",
  name: "notes",
  kind: "general",
  trust: "trusted",
  missing: true,
};

function renderApp(recent: Project[]) {
  const bridge = new MockHostBridge();
  // Past first-run onboarding (Onboarding.test.tsx covers it).
  void bridge.uiState.update({ onboarding: { step: 6, completed: true } });
  let list = recent;
  const removed: string[] = [];
  bridge.handle("projects.list", () => ({ projects: list }));
  bridge.handle("projects.remove", ({ id }) => {
    removed.push(id);
    list = list.filter((p) => p.id !== id);
    return {};
  });
  bridge.handle("projects.open", () => ({ project: habits, needsTrustDecision: true }));
  bridge.handle("projects.detect", () => {
    throw new Error("not needed");
  });
  bridge.handle("projects.setTrust", ({ trust }) => ({ project: { ...habits, trust } }));
  render(<App workbench={createWorkbench(bridge)} />);
  return { bridge, removed };
}

describe("StartScreen", () => {
  it("lists recent projects with trust, kind and the Missing marker (FR-004)", async () => {
    renderApp([habits, notes]);
    const list = await screen.findByRole("list");
    const rows = within(list).getAllByRole("listitem");

    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Trust not decided")).toBeTruthy();
    expect(within(rows[0]!).getByText("Never opened")).toBeTruthy();
    expect(within(rows[0]!).queryByRole("button", { name: "Locate…" })).toBeNull();
    expect(within(rows[1]!).getByText("Missing")).toBeTruthy();
    expect(within(rows[1]!).getByText("General workspace")).toBeTruthy();
    expect(within(rows[1]!).getByRole("button", { name: "Locate…" })).toBeTruthy();
  });

  it("removes a project from the list without touching its folder", async () => {
    const { removed } = renderApp([habits, notes]);
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove notes from recent projects" }),
    );

    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    expect(removed).toEqual([notes.id]);
  });

  it("says so when there are no recent projects", async () => {
    renderApp([]);
    expect(await screen.findByText(/No recent projects yet/)).toBeTruthy();
  });

  it("opens a recent project, asks for trust, then shows the project (J-05)", async () => {
    renderApp([habits]);
    await userEvent.click(await screen.findByRole("button", { name: "habits" }));

    const dialog = await screen.findByRole("dialog", { name: "Do you trust this folder?" });
    expect(dialog.textContent).toContain("Opening is safe.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Trust this folder" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const title = screen.getByRole("banner");
    expect(within(title).getByRole("heading", { name: "habits" })).toBeTruthy();
    expect(within(title).getByText("Trusted")).toBeTruthy();
  });
});
