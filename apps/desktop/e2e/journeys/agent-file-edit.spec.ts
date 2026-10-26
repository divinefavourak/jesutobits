import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, expectAccessible, openFolder, test } from "../fixtures";

// J-06 file-editing turn (PRODUCT_VISION.md section 6, TESTING_STRATEGY.md section 4): a
// scripted agent reads src/greet.ts, edits it with edit_file, and answers. The chat and
// timeline show the real steps, the summary is honestly "Unverified", the edit is on disk,
// and Revert turn restores the original bytes.

// Opening the folder and the scripted turn include the dev server and runtime startup.
test.describe.configure({ timeout: 90_000 });

const cassette = fileURLToPath(new URL("../cassettes/agent-file-edit.jsonl", import.meta.url));
const BEFORE = 'export const greeting = "Hi";\n';
const AFTER = 'export const greeting = "Hello";\n';
const MESSAGE = "Change the greeting to Hello";

test.use({ relayEnv: { JESUTOBITS_PROVIDER: "scripted", JESUTOBITS_CASSETTE: cassette } });

test("the agent reads and edits a file on request, and Revert turn restores it (J-06)", async ({
  page,
  tempDir,
}) => {
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(join(tempDir, "src", "greet.ts"), BEFORE);
  await page.goto("/");
  await openFolder(page, tempDir);

  // Send from the composer with Ctrl+Enter; the first activity appears within 2 s (J-06).
  const composer = page.getByLabel("Message to the agent");
  await composer.fill(MESSAGE);
  const sentAt = Date.now();
  await composer.press("Control+Enter");
  await expect(page.locator("article").getByText(MESSAGE, { exact: true })).toBeVisible();
  expect(Date.now() - sentAt).toBeLessThan(2_000);

  // The turn's tool rows and the answer appear in the Chat tab.
  const article = page.locator("article");
  await expect(
    article.locator("summary").filter({ hasText: /^Read src\/greet\.ts/ }),
  ).toBeVisible();
  await expect(
    article.locator("summary").filter({ hasText: /^Edited src\/greet\.ts \(\+1 -1\)$/ }),
  ).toBeVisible();
  await expect(article.getByText(MESSAGE, { exact: true })).toBeVisible();
  await expect(article.locator("strong", { hasText: "Hello" })).toHaveText("Hello");

  // Summary: what changed, with the honest verification label (never "Verified" here).
  await expect(article.getByText("1 file changed")).toBeVisible();
  await expect(article.getByText("Unverified", { exact: true })).toBeVisible();
  await expect(article.getByText("Verified", { exact: true })).toHaveCount(0);

  // The edit went to the user's project through the runtime.
  await expect.poll(() => readFileSync(join(tempDir, "src", "greet.ts"), "utf8")).toBe(AFTER);

  // The Timeline tab lists both tool rows.
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(
    page.locator("ul li summary").filter({ hasText: /^Read src\/greet\.ts/ }),
  ).toHaveCount(1);
  await expect(
    page.locator("ul li summary").filter({ hasText: /^Edited src\/greet\.ts \(\+1 -1\)$/ }),
  ).toHaveCount(1);
  await page.getByRole("tab", { name: "Chat" }).click();

  // Nothing is running once the turn ended.
  await expect(page.getByRole("contentinfo")).toContainText("Agent idle");

  // Revert turn puts the file back exactly as it was.
  await expectAccessible(page);
  await page.getByRole("button", { name: "Revert turn" }).click();
  await expect(page.getByText("Restored 1 file.")).toBeVisible();
  await expect.poll(() => readFileSync(join(tempDir, "src", "greet.ts"), "utf8")).toBe(BEFORE);
});
