import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, expectAccessible, setDocumentsFolder, test } from "../fixtures";

// J-01 Opening the application for the first time (PRODUCT_VISION.md section 6, FR-001).
test.use({ onboarded: false });

test("first run walks through onboarding, creates the workspace folder and ends on the start screen", async ({
  page,
  tempDir,
}) => {
  const documents = join(tempDir, "Documents");
  mkdirSync(documents);
  const workspace = join(documents, "Jesutobits Projects");

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome to Jesutobits" })).toBeVisible();
  await expect(page.getByText("Step 1 of 7")).toBeVisible();
  await expect(page.getByText(/only your messages and the files the agent reads/)).toBeVisible();
  await expectAccessible(page);
  await setDocumentsFolder(page, documents);
  await page.getByRole("button", { name: "Get started" }).click();

  // Workspace folder: suggested, created only on Continue (FR-002).
  await expect(page.getByText(workspace)).toBeVisible();
  expect(existsSync(workspace)).toBe(false);
  await expect(page.getByRole("button", { name: "Skip" })).toHaveCount(0);
  await expectAccessible(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Check your tools" })).toBeVisible();
  expect(existsSync(workspace)).toBe(true);

  // Toolchain check against the real runtime: this machine has Node.js.
  await expect(page.getByRole("listitem").filter({ hasText: "Node.js" })).toContainText("Found");
  await expectAccessible(page);

  // A restart resumes at the same step (J-01).
  await page.reload();
  await expect(page.getByRole("heading", { name: "Check your tools" })).toBeVisible();
  await expect(page.getByText("Step 3 of 7")).toBeVisible();

  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByRole("heading", { name: "Choose a model provider" })).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByRole("button", { name: "Skip" }).click();

  // The look: choosing a theme applies it at once.
  await expect(page.getByRole("heading", { name: "Choose a look" })).toBeVisible();
  await page.getByRole("radio", { name: "High Contrast" }).check();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "builtin.jesutobits-themes/high-contrast",
  );
  await expectAccessible(page);
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Your first project" })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Finish and go to the start screen" }).click();
  await expect(page.getByRole("heading", { name: "Recent projects" })).toBeVisible();

  // Not shown again.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Recent projects" })).toBeVisible();
});

test("the first project can be created from onboarding", async ({ page, tempDir }) => {
  const documents = join(tempDir, "Documents");
  mkdirSync(documents);
  await page.goto("/");
  await setDocumentsFolder(page, documents);
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  for (const _ of ["toolchain", "provider", "credentials", "look"]) {
    await page.getByRole("button", { name: "Skip" }).click();
  }

  await page.getByRole("button", { name: "New project…" }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  // The workspace folder chosen a moment ago is the location.
  await expect(dialog).toContainText(join(documents, "Jesutobits Projects"), {
    ignoreCase: true,
  });
  await dialog.getByLabel("Name").fill("habits");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("banner").getByRole("heading", { name: "habits" })).toBeVisible();
  expect(existsSync(join(documents, "Jesutobits Projects", "habits"))).toBe(true);
});
