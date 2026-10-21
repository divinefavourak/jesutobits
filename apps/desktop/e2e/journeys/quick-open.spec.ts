import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, expectAccessible, openFolder, test } from "../fixtures";

// Quick open and the command palette (UX_AND_INTERFACE.md sections 5.3 and 9, FR-074, FR-079).

// Opening a file may include Monaco's first load in the dev server.
test.describe.configure({ timeout: 60_000 });

/** The palette's choices (the layout picker's <option>s are options too). */
const choices = (page: Page) => page.getByRole("listbox").getByRole("option");

function fixture(dir: string) {
  mkdirSync(join(dir, "src", "lib"), { recursive: true });
  writeFileSync(join(dir, "src", "App.tsx"), "export {};\n");
  writeFileSync(join(dir, "src", "lib", "date.ts"), "export {};\n");
  writeFileSync(join(dir, "README.md"), "# Habits\n");
}

test("Ctrl+P finds files by fuzzy name and opens them; recent files come first", async ({
  page,
  tempDir,
}) => {
  fixture(tempDir);
  await page.goto("/");
  await openFolder(page, tempDir);
  const tabs = page.getByRole("list", { name: "Open files" });

  await page.keyboard.press("Control+p");
  const input = page.getByRole("combobox", { name: "Go to file" });
  await expect(input).toBeFocused();
  await input.fill("sldt");
  const first = choices(page).first();
  await expect(first).toHaveText(/^date\.ts\s*src\/lib$/);
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expectAccessible(page);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(tabs.getByRole("button", { name: "date.ts", exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // With nothing typed, the file shown last is first.
  await page.keyboard.press("Control+p");
  await expect(choices(page).first()).toHaveText(/^date\.ts/);
  // Esc closes it and nothing else happens.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Ctrl+K runs commands, shows their shortcuts and hides those that cannot run", async ({
  page,
  tempDir,
}) => {
  fixture(tempDir);
  await page.goto("/");
  await openFolder(page, tempDir);

  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox", { name: "Command palette" });
  await expect(input).toBeFocused();
  // No file is open, so there is nothing to save.
  await expect(page.getByRole("option", { name: /File: Save$/ })).toHaveCount(0);
  await input.fill("focus layout");
  await expect(choices(page).first()).toContainText("View: Focus layout");
  await expect(choices(page).first()).toContainText("Alt+4");
  await expectAccessible(page);
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Layout")).toHaveValue("focus");

  // The palette also reaches quick open.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Command palette" }).fill("go to file");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("combobox", { name: "Go to file" })).toBeFocused();
});
