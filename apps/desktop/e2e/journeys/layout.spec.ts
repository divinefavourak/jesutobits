import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, expectAccessible, openFolder, test } from "../fixtures";

// Dock layout and presets (UX_AND_INTERFACE.md section 4, FR-070, FR-071, FR-008).

test("a project opens in the Code layout, without serious axe violations", async ({
  page,
  tempDir,
}) => {
  await page.goto("/");
  await openFolder(page, tempDir);

  const dock = (name: string) => page.getByRole("region", { name });
  await expect(dock("Left dock").getByRole("tab", { name: "Explorer" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(dock("Center dock").getByRole("tab", { name: "Editor" })).toBeVisible();
  await expect(dock("Right dock").getByRole("tab", { name: "Agent" })).toBeVisible();
  await expect(dock("Bottom dock").getByRole("tab", { name: "Terminal" })).toBeVisible();
  await expect(page.getByLabel("Layout")).toHaveValue("code");
  await expectAccessible(page);
});

test("docks collapse, panels move, and the layout is kept per project across restarts", async ({
  page,
  tempDir,
}) => {
  const habits = join(tempDir, "habits");
  const notes = join(tempDir, "notes");
  mkdirSync(habits);
  mkdirSync(notes);
  const dock = (name: string) => page.getByRole("region", { name });

  await page.goto("/");
  await openFolder(page, habits);

  // Ctrl+B collapses the left dock to an icon rail; the rail brings the panel back.
  await page.keyboard.press("Control+b");
  await expect(dock("Left dock").getByRole("tab")).toHaveCount(0);
  await dock("Left dock").getByRole("button", { name: "Show Explorer" }).click();
  await expect(dock("Left dock").getByRole("tab", { name: "Explorer" })).toBeVisible();

  // Move Output to the right dock through the panel menu, with the keyboard.
  await dock("Bottom dock").getByRole("tab", { name: "Output" }).click();
  await dock("Bottom dock").getByRole("button", { name: "Output options" }).click();
  await page.getByRole("menuitem", { name: "Move to Right dock" }).press("Enter");
  await expect(dock("Right dock").getByRole("tab", { name: "Output" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByLabel("Layout")).toContainText("Custom (based on Code)");

  // Splitters work from the keyboard.
  const splitter = page.getByRole("separator", { name: "Resize Left dock" });
  await splitter.focus();
  await page.keyboard.press("ArrowRight");
  await expect(splitter).toHaveAttribute("aria-valuenow", "276");

  // Another project has its own layout.
  await page.getByRole("button", { name: "Close project" }).click();
  await openFolder(page, notes);
  await expect(dock("Bottom dock").getByRole("tab", { name: "Output" })).toBeVisible();
  await page.getByRole("button", { name: "Close project" }).click();

  // After a restart, habits comes back as the user left it.
  await page.reload();
  await page.getByRole("button", { name: "habits", exact: true }).click();
  await expect(dock("Right dock").getByRole("tab", { name: "Output" })).toBeVisible();
  await expect(page.getByRole("separator", { name: "Resize Left dock" })).toHaveAttribute(
    "aria-valuenow",
    "276",
  );

  await page.getByRole("button", { name: "Reset layout" }).click();
  await expect(dock("Bottom dock").getByRole("tab", { name: "Output" })).toBeVisible();
});

test("Alt+4 switches to Focus and F6 moves between docks", async ({ page, tempDir }) => {
  await page.goto("/");
  await openFolder(page, tempDir);
  const dock = (name: string) => page.getByRole("region", { name });

  await page.keyboard.press("Alt+4");
  await expect(page.getByLabel("Layout")).toHaveValue("focus");
  await expect(dock("Left dock").getByRole("tab")).toHaveCount(0);
  await expect(dock("Right dock").getByRole("tab")).toHaveCount(0);
  await expect(dock("Bottom dock").getByRole("tab")).toHaveCount(0);
  await expectAccessible(page);

  await page.keyboard.press("Alt+2");
  await page.keyboard.press("F6");
  await expect(dock("Left dock").getByRole("tab", { name: "Explorer" })).toBeFocused();
  await page.keyboard.press("F6");
  await expect(dock("Center dock").getByRole("tab", { name: "Editor" })).toBeFocused();
  await page.keyboard.press("Shift+F6");
  await expect(dock("Left dock").getByRole("tab", { name: "Explorer" })).toBeFocused();
});
