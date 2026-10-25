import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chooseFolderInDialog, expect, expectAccessible, test } from "../fixtures";

// J-05 Opening an existing project (PRODUCT_VISION.md section 6).

test("opening a folder asks for trust, writes nothing and shows the project", async ({
  page,
  tempDir,
}) => {
  const folder = join(tempDir, "habits");
  mkdirSync(folder);
  writeFileSync(join(folder, "notes.txt"), "hello\n");
  const before = readdirSync(folder, { recursive: true });

  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("Ready");
  await chooseFolderInDialog(page, folder);
  await page.getByRole("button", { name: "Open folder…" }).click();

  const dialog = page.getByRole("dialog", { name: "Do you trust this folder?" });
  await expect(dialog).toContainText("Opening is safe.");
  // Focus is on the dialog, not on Trust: Enter decides nothing (UX_AND_INTERFACE.md 6.4).
  await expect(dialog).toBeFocused();
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Use Restricted mode" }).click();
  await expect(dialog).toBeHidden();

  const title = page.getByRole("banner");
  await expect(title.getByRole("heading", { name: "habits" })).toBeVisible();
  await expect(title.getByText("Restricted")).toBeVisible();
  await expect(title).toContainText("There is no package.json in this folder.");
  await expectAccessible(page);

  // Opening a project writes nothing into it (FR-007).
  expect(readdirSync(folder, { recursive: true })).toEqual(before);

  await title.getByRole("button", { name: "Close project" }).click();
  const row = page.getByRole("listitem").filter({ hasText: "habits" });
  await expect(row.getByText("Restricted")).toBeVisible();
  await expect(row).toContainText("Last opened");
});

test("the trust decision is remembered for the folder", async ({ page, tempDir }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("Ready");
  await chooseFolderInDialog(page, tempDir);
  await page.getByRole("button", { name: "Open folder…" }).click();
  await page.getByRole("button", { name: "Trust this folder" }).click();
  await page.getByRole("button", { name: "Close project" }).click();

  // A reload is a restart for the Workbench; the runtime keeps the recent list.
  await page.reload();
  await page.getByRole("button", { name: /^jesutobits-e2e-/ }).click();
  await expect(page.getByRole("banner").getByText("Trusted")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a missing project can be located or removed (FR-004)", async ({ page, tempDir }) => {
  const folder = join(tempDir, "habits");
  const moved = join(tempDir, "habits-moved");
  mkdirSync(folder);

  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("Ready");
  await chooseFolderInDialog(page, folder);
  await page.getByRole("button", { name: "Open folder…" }).click();
  await page.getByRole("button", { name: "Decide later" }).click();
  await page.getByRole("button", { name: "Close project" }).click();

  renameSync(folder, moved);
  await page.reload();
  const row = page.getByRole("listitem").filter({ hasText: "habits" });
  await expect(row.getByText("Missing")).toBeVisible();
  await expectAccessible(page);

  await chooseFolderInDialog(page, moved);
  await row.getByRole("button", { name: "Locate…" }).click();
  const located = page.getByRole("listitem").filter({ hasText: "habits-moved" });
  await expect(located.getByText("Missing")).toHaveCount(0);

  await located.getByRole("button", { name: "Remove habits-moved from recent projects" }).click();
  await expect(page.getByText(/No recent projects yet/)).toBeVisible();
  // Removing forgets the project; the folder stays.
  expect(readdirSync(tempDir)).toEqual(["habits-moved"]);
});
