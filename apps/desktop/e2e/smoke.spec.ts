import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chooseFolderInDialog, expect, expectAccessible, test } from "./fixtures";

// The E2E smoke subset run on every pull request (TESTING_STRATEGY.md section 7).
test("the Workbench reaches a ready runtime and has no serious axe violations", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("status").first()).toHaveText("Ready");
  await expectAccessible(page);
});

test("a folder chosen in the dialog opens through the real runtime (J-05)", async ({
  page,
  tempDir,
}) => {
  const folder = join(tempDir, "habits");
  mkdirSync(folder);
  await page.goto("/");
  await expect(page.getByRole("status").first()).toHaveText("Ready");

  await chooseFolderInDialog(page, folder);
  await page.getByRole("button", { name: "Open folder…" }).click();

  await expect(page.getByText("Opened habits (unknown)")).toBeVisible();
});
