import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chooseFolderInDialog, expect, expectAccessible, test } from "../fixtures";

// J-04 Creating a new project, Phase 1 part: Empty and General workspace templates.

test("a new General workspace is created where the user chose and opens trusted", async ({
  page,
  tempDir,
}) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("Ready");
  await page.getByRole("button", { name: "New project…" }).click();

  const dialog = page.getByRole("dialog", { name: "New project" });
  await expect(dialog.getByRole("button", { name: "Create" })).toBeDisabled();
  await dialog.getByLabel("Name").fill("notes");
  await dialog.getByRole("radio", { name: /General workspace/ }).check();
  await chooseFolderInDialog(page, tempDir);
  await dialog.getByRole("button", { name: "Choose…" }).click();
  await expect(dialog).toContainText(tempDir);
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Create" }).click();

  const title = page.getByRole("banner");
  await expect(title.getByRole("heading", { name: "notes" })).toBeVisible();
  await expect(title.getByText("General workspace")).toBeVisible();
  // Projects Jesutobits creates are trusted: no prompt (SECURITY.md section 5.4).
  await expect(title.getByText("Trusted")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(existsSync(join(tempDir, "notes"))).toBe(true);
});

test("a name that already holds files is refused before anything is written", async ({
  page,
  tempDir,
}) => {
  mkdirSync(join(tempDir, "habits"));
  writeFileSync(join(tempDir, "habits", "keep.txt"), "mine\n");

  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("Ready");
  await page.getByRole("button", { name: "New project…" }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Name").fill("habits");
  await chooseFolderInDialog(page, tempDir);
  await dialog.getByRole("button", { name: "Choose…" }).click();
  await dialog.getByRole("button", { name: "Create" }).click();

  await expect(dialog.getByRole("alert")).toContainText(
    "Could not create the project. A folder named habits already exists there and is not empty",
  );
  await expect(page.getByRole("banner")).toHaveCount(0);
});
