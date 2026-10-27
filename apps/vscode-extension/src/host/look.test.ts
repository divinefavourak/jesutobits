import { describe, expect, it } from "vitest";
import { readRemix, remixColors, withRemix } from "./look.js";

const REMIX = { accent: "#c5b1f7", canvas: "#17161c", surfaces: "#201e26", text: "#f2eff7" };

describe("theme remix", () => {
  it("maps the four colours onto the workbench's colour keys", () => {
    const colors = remixColors(REMIX);
    expect(colors["button.background"]).toBe("#c5b1f7");
    expect(colors["editor.background"]).toBe("#17161c");
    expect(colors["sideBar.background"]).toBe("#201e26");
    expect(colors["foreground"]).toBe("#f2eff7");
  });

  it("remixes only the current theme and keeps the user's own customizations", () => {
    const before = {
      "statusBar.foreground": "#ffffff",
      "[Lavender dusk]": { "editorCursor.foreground": "#ff0000" },
      "[Matcha]": { "editor.background": "#000000" },
    };
    const after = withRemix(before, "Lavender dusk", REMIX);

    expect(after["statusBar.foreground"]).toBe("#ffffff");
    expect(after["[Matcha]"]).toEqual({ "editor.background": "#000000" });
    expect(after["[Lavender dusk]"]).toMatchObject({
      "editorCursor.foreground": "#ff0000",
      "editor.background": "#17161c",
    });
    expect(readRemix(after, "Lavender dusk")).toEqual(REMIX);
    expect(readRemix(after, "Matcha")).toBeNull();
  });

  it("removes the remix and nothing else", () => {
    const remixed = withRemix(
      { "[Lavender dusk]": { "editorCursor.foreground": "#ff0000" } },
      "Lavender dusk",
      REMIX,
    );
    expect(withRemix(remixed, "Lavender dusk", null)).toEqual({
      "[Lavender dusk]": { "editorCursor.foreground": "#ff0000" },
    });
    expect(withRemix(withRemix({}, "Matcha", REMIX), "Matcha", null)).toEqual({});
  });
});
