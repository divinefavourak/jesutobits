import type { MethodParams } from "@jesutobits/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { MockHostBridge } from "../../host-bridge";
import { createWorkbench, WorkbenchProvider } from "../../state/workbench-context";
import { ApprovalCard } from "./ApprovalCard";
import { applyEvents, EMPTY_TIMELINE, type TimelineItem } from "./timeline-reducer";
import { PERMISSION_ID, permissionRequested, turnStarted } from "./test-events";

type PermissionItem = Extract<TimelineItem, { kind: "permission" }>;

type PermissionOptions = NonNullable<Parameters<typeof permissionRequested>[0]>;

function permissionItem(options: PermissionOptions = {}): PermissionItem {
  const timeline = applyEvents(EMPTY_TIMELINE, [
    turnStarted({ seq: 1 }),
    permissionRequested({ seq: 2, ...options }),
  ]);
  const item = timeline.turns[0]?.items[0];
  if (item?.kind !== "permission") throw new Error("Expected a permission item");
  return item;
}

function renderCard(item: PermissionItem) {
  const bridge = new MockHostBridge();
  const responses: Array<MethodParams<"permissions.respond">> = [];
  bridge.handle("permissions.respond", (params) => {
    responses.push(params);
    return {};
  });
  const workbench = createWorkbench(bridge);
  render(
    <WorkbenchProvider value={workbench}>
      <ApprovalCard item={item} />
    </WorkbenchProvider>,
  );
  return { bridge, workbench, responses };
}

beforeEach(() => {
  // jsdom has no scrolling; the card calls scrollIntoView when a text field keeps focus.
  Element.prototype.scrollIntoView = () => undefined;
});

describe("ApprovalCard (UX_AND_INTERFACE.md section 6.4)", () => {
  it("shows the exact action, the risk words, the reasons, the diff, the explanation and the rule", () => {
    renderCard(
      permissionItem({
        action: { kind: "file", op: "write", paths: ["src/a.ts"] },
        risk: ["write", "destructive"],
        reasons: ["Writes a file in the project", "The task did not ask for this file"],
        agentExplanation: "The title needs to change.",
        diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
        sessionRule: "Change files in src/",
        offered: ["allow_once", "allow_session", "deny"],
      }),
    );

    expect(screen.getByText("Change src/a.ts")).toBeTruthy();
    expect(screen.getByText("Changes files")).toBeTruthy();
    expect(screen.getByText("Deletes files")).toBeTruthy();
    expect(screen.getByText("Writes a file in the project")).toBeTruthy();
    expect(screen.getByText("The task did not ask for this file")).toBeTruthy();
    expect(screen.getByText("-old")).toBeTruthy();
    expect(screen.getByText("+new")).toBeTruthy();
    expect(screen.getByText("Agent's explanation")).toBeTruthy();
    expect(screen.getByText("The title needs to change.")).toBeTruthy();
    expect(screen.getByText("Rule: Change files in src/")).toBeTruthy();
  });

  it("shows the session rule and its button only when allow_session is offered", () => {
    const { unmount } = render(
      <WorkbenchProvider value={createWorkbench(new MockHostBridge())}>
        <ApprovalCard
          item={permissionItem({
            sessionRule: "Change files in src/",
            offered: ["allow_once", "deny"],
          })}
        />
      </WorkbenchProvider>,
    );

    expect(screen.queryByText(/^Rule:/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow for this session" })).toBeNull();
    unmount();
  });

  it("offers sharing with values hidden only when the request allows it", () => {
    const { unmount } = render(
      <WorkbenchProvider value={createWorkbench(new MockHostBridge())}>
        <ApprovalCard item={permissionItem({ offered: ["allow_once", "deny"] })} />
      </WorkbenchProvider>,
    );

    expect(screen.queryByRole("button", { name: "Share with values hidden" })).toBeNull();
    unmount();
  });

  it("shows the sharing button when allow_redacted is offered", () => {
    renderCard(permissionItem({ offered: ["allow_once", "allow_redacted", "deny"] }));

    expect(screen.getByRole("button", { name: "Share with values hidden" })).toBeTruthy();
  });

  it("is an alertdialog with an accessible name", () => {
    renderCard(permissionItem());

    const dialog = screen.getByRole("alertdialog", { name: "A small permission check" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("puts focus on the card body, never on a button", () => {
    renderCard(permissionItem());

    const dialog = screen.getByRole("alertdialog");
    const body = dialog.querySelector('[tabindex="-1"]');
    expect(body).toBeTruthy();
    expect(document.activeElement).toBe(body);
    expect((document.activeElement as HTMLElement).tagName).not.toBe("BUTTON");
  });

  it("leaves focus in a text field that already had it", () => {
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    textarea.focus();

    renderCard(permissionItem());

    expect(document.activeElement).toBe(textarea);
    textarea.remove();
  });

  it("does not approve on Enter, but Allow once answers the request", async () => {
    const { responses } = renderCard(permissionItem());

    await userEvent.keyboard("{Enter}");
    expect(responses).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Looks good, allow once" }));
    await waitFor(() => expect(responses).toHaveLength(1));
    expect(responses[0]).toMatchObject({
      permissionId: PERMISSION_ID,
      decision: "allow_once",
    });
  });

  it("denies with the trimmed message typed into the denial field", async () => {
    const { responses } = renderCard(permissionItem());

    await userEvent.click(screen.getByRole("button", { name: "Deny with message…" }));
    const message = screen.getByLabelText("Message for the agent");
    await userEvent.type(message, "  Please use src/b.ts  ");
    await userEvent.click(screen.getByRole("button", { name: "Deny and send" }));

    await waitFor(() => expect(responses).toHaveLength(1));
    expect(responses[0]).toMatchObject({
      permissionId: PERMISSION_ID,
      decision: "deny",
      message: "Please use src/b.ts",
    });
  });
});
