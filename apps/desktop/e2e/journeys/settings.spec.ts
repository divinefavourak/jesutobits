import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { chooseFolderInDialog, expect, expectAccessible, openFolder, test } from "../fixtures";

// Settings (FR-011, UX_AND_INTERFACE.md section 8): Phase 1 sections.

test("appearance changes apply at once and the settings pages have no serious axe violations", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("button", { name: "Appearance" }).click();
  await page.getByRole("radio", { name: "Light" }).check();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "builtin.jesutobits-themes/light",
  );
  await page.getByLabel("Interface size").selectOption("1.25");
  await expect
    .poll(() =>
      page.locator("html").evaluate((html) => html.style.getPropertyValue("--jesutobits-ui-scale")),
    )
    .toBe("1.25");
  await page.getByLabel("Reduce motion").check();
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "true");
  await expectAccessible(page);

  for (const section of ["Workspace", "Advanced", "About"]) {
    await page.getByRole("button", { name: section, exact: true }).click();
    await expect(page.getByRole("heading", { name: section, level: 2 })).toBeVisible();
    await expectAccessible(page);
  }

  // Settings survive a restart (the Host's settings.json; here the mock's storage).
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "builtin.jesutobits-themes/light",
  );
});

test("the workspace folder and a project's trust are changed in settings (J-03, J-05)", async ({
  page,
  tempDir,
}) => {
  const project = join(tempDir, "habits");
  const projects = join(tempDir, "Projects");
  mkdirSync(project);
  mkdirSync(projects);
  await page.goto("/");
  await openFolder(page, project, "Use Restricted mode");
  await expect(page.getByRole("banner").getByText("Restricted")).toBeVisible();

  await page.keyboard.press("Control+Comma");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

  await chooseFolderInDialog(page, projects);
  await page.getByRole("button", { name: "Change…" }).click();
  await expect(page.getByRole("main")).toContainText(projects);

  await page.getByRole("button", { name: "This project" }).click();
  await page.getByRole("radio", { name: /^Trusted/ }).check();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.getByRole("banner").getByText("Trusted")).toBeVisible();
});
