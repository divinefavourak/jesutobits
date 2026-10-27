import { AppSettingsSchema, type CompanionSkin } from "@jesutobits/protocol";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockHostBridge } from "../../host-bridge";
import { createWorkbench, WorkbenchProvider } from "../../state/workbench-context";
import { Companion } from "./Companion";

function setup() {
  const bridge = new MockHostBridge();
  const { container } = render(
    <WorkbenchProvider value={createWorkbench(bridge)}>
      <Companion />
    </WorkbenchProvider>,
  );
  const root = () => container.querySelector<HTMLElement>("[data-companion-skin]")!;
  const useSkin = (skin: CompanionSkin) =>
    act(() => bridge.changeSettings(AppSettingsSchema.parse({ companion: { skin } })));
  return { root, useSkin };
}

describe("Companion skins", () => {
  it("shows Buddy by default, still while the agent rests", async () => {
    const { root } = setup();
    expect(root().dataset.companionSkin).toBe("buddy");
    const buddy = root().querySelector<HTMLElement>(".buddy-companion");
    expect(buddy?.dataset.kind).toBe("resting");
    expect(screen.getByRole("status").textContent).toBeTruthy();
  });

  it("follows the skin setting, keeping the state in words", async () => {
    const { root, useSkin } = setup();
    const words = screen.getByRole("status").textContent;

    useSkin("mark");
    expect(root().dataset.companionSkin).toBe("mark");
    expect(root().querySelector(".buddy-companion")).toBeNull();

    useSkin("dot");
    expect(root().querySelector(".rounded-full.bg-success")).toBeTruthy();

    useSkin("off");
    expect(root().querySelector("svg, .buddy, .rounded-full.bg-success")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(words);
  });
});
