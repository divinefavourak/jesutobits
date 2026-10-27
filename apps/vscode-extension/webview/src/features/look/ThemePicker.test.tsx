import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MockHostBridge } from "../../host-bridge";
import { createWorkbench, WorkbenchProvider } from "../../state/workbench-context";
import { paletteNamed, readableText, remixOf } from "../../themes/studio-palettes";
import { ThemePicker } from "./ThemePicker";

// Colours come from the Studio palettes (no colour literals in features/).
const LAVENDER = paletteNamed("Lavender dusk")!;
const MATCHA = paletteNamed("Matcha")!;

function setup() {
  const bridge = new MockHostBridge();
  let closed = 0;
  render(
    <WorkbenchProvider value={createWorkbench(bridge)}>
      <ThemePicker onClose={() => (closed += 1)} />
    </WorkbenchProvider>,
  );
  return { bridge, closes: () => closed };
}

describe("ThemePicker", () => {
  it("shows the current theme and switches VS Code's theme", async () => {
    const { bridge } = setup();
    const lavender = await screen.findByRole("button", { name: /^Lavender dusk/ });
    await waitFor(() => expect(lavender.getAttribute("aria-pressed")).toBe("true"));

    await userEvent.click(screen.getByRole("button", { name: /Ocean after hours/ }));
    await waitFor(() => expect(bridge.currentLook.theme).toBe("Ocean after hours"));
    expect(
      screen.getByRole("button", { name: /Ocean after hours/ }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("remixes the current theme once the colour settles, and resets", async () => {
    const { bridge } = setup();
    const accent = await screen.findByLabelText("Custom Accent colour");
    fireEvent.change(accent, { target: { value: MATCHA.accent } });
    expect(screen.getByText("CUSTOM")).toBeTruthy();
    await waitFor(() => expect(bridge.currentLook.remix?.accent).toBe(MATCHA.accent));

    await userEvent.click(screen.getByRole("button", { name: "Reset to Lavender dusk" }));
    await waitFor(() =>
      expect(bridge.currentLook).toEqual({ theme: "Lavender dusk", remix: null }),
    );
    expect(screen.getByText("TRY IT")).toBeTruthy();
  });

  it("warns about low text contrast and fixes it", async () => {
    const { bridge } = setup();
    const text = await screen.findByLabelText("Custom Text colour");
    fireEvent.change(text, { target: { value: LAVENDER.panel } });
    expect(screen.getByRole("status").textContent).toContain("Low text contrast");

    await userEvent.click(screen.getByRole("button", { name: "Improve text contrast" }));
    expect(screen.getByRole("status").textContent).toContain("Text contrast looks good");
    await waitFor(() =>
      expect(bridge.currentLook.remix?.text).toBe(
        readableText({ ...remixOf(LAVENDER), text: LAVENDER.panel }),
      ),
    );
  });

  it("closes on Escape and with Feels like me", async () => {
    const { closes } = setup();
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: /Feels like me/ }));
    expect(closes()).toBe(2);
  });

  it("saves a fresh remix on its own theme before switching, and waits while switching", async () => {
    const { bridge } = setup();
    const calls: string[] = [];
    const { setTheme, remix } = bridge.look;
    let finishSwitch = () => {};
    bridge.look.remix = async (value) => {
      calls.push(`remix ${bridge.currentLook.theme} ${value?.accent ?? "none"}`);
      await remix(value);
    };
    bridge.look.setTheme = async (theme) => {
      calls.push(`theme ${theme}`);
      await new Promise<void>((resolve) => (finishSwitch = resolve));
      await setTheme(theme);
    };

    const accent = await screen.findByLabelText("Custom Accent colour");
    fireEvent.change(accent, { target: { value: MATCHA.accent } });
    // Switch before the remix's timer fires: the remix is written first, on Lavender dusk.
    await userEvent.click(screen.getByRole("button", { name: /^Matcha/ }));
    await waitFor(() =>
      expect(calls).toEqual([`remix Lavender dusk ${MATCHA.accent}`, "theme Matcha"]),
    );

    // While VS Code switches, the remix waits.
    expect((screen.getByLabelText("Custom Accent colour") as HTMLInputElement).disabled).toBe(true);
    finishSwitch();
    await waitFor(() =>
      expect((screen.getByLabelText("Custom Accent colour") as HTMLInputElement).disabled).toBe(
        false,
      ),
    );
    expect((screen.getByLabelText("Custom Canvas colour") as HTMLInputElement).value).toBe(
      MATCHA.bg,
    );
  });
});
