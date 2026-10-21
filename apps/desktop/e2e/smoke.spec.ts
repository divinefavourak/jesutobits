import { expect, expectAccessible, test } from "./fixtures";

// The quickest check that the Workbench, the mock Host and a real runtime work together.
test("the start screen reaches a ready runtime and has no serious axe violations", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("Ready");
  await expect(page.getByText(/No recent projects yet/)).toBeVisible();
  await expectAccessible(page);
});
