import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, expectAccessible, openFolder, test } from "../fixtures";

// J-14 approvals (PRODUCT_VISION.md section 6, UX_AND_INTERFACE.md section 6.4, testing
// strategy section 4): in a project where every change asks, the approval card shows the
// exact action, its risk and the agent's explanation; keyboard focus is never on a button
// and Enter does not approve; a denial with a message reaches the model (asserted through
// the cassette's `expect`); "Allow once" runs the change.

// Opening the folder, the scripted turn and the two approvals need some headroom.
test.describe.configure({ timeout: 90_000 });

const OPEN_RELATIVE = "src/greet.ts";
const BEFORE = 'export const greeting = "Hi";\n';
const AFTER = 'export const greeting = "Hello";\n';
const MESSAGE = "Change the greeting to Hello";

function project(dir: string): string {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, OPEN_RELATIVE), BEFORE);
  return dir;
}

/** The approval card for the pending edit_file call. */
function card(page: Page) {
  return page.getByRole("alertdialog", { name: "Approval needed" });
}

async function openAndSend(page: Page, tempDir: string) {
  project(tempDir);
  await page.goto("/");
  await openFolder(page, tempDir, "Use Restricted mode");
  const composer = page.getByLabel("Message to the agent");
  await composer.fill(MESSAGE);
  await composer.press("Control+Enter");
  await expect(page.locator("article").getByText(MESSAGE, { exact: true })).toBeVisible();
}

test.describe(() => {
  const cassette = fileURLToPath(
    new URL("../cassettes/agent-approvals-deny.jsonl", import.meta.url),
  );
  test.use({ relayEnv: { JESUTOBITS_PROVIDER: "scripted", JESUTOBITS_CASSETTE: cassette } });

  test("Enter does not approve; a denial with a message reaches the model (J-14)", async ({
    page,
    tempDir,
  }) => {
    await openAndSend(page, tempDir);

    const approval = card(page);
    await approval.waitFor({ state: "visible" });
    const file = join(tempDir, OPEN_RELATIVE);

    // The card names the exact action, its risk in words, the diff and the agent's own words.
    await expect(approval).toContainText("Change src/greet.ts");
    await expect(approval).toContainText("Changes files");
    await expect(approval).toContainText('+export const greeting = "Hello";');
    await expect(approval).toContainText('-export const greeting = "Hi";');
    await expect(approval).toContainText("Agent's explanation");
    await expect(approval).toContainText('I\'ll replace "Hi" with "Hello" in src/greet.ts.');
    await expectAccessible(page);

    // Focus lands on the card, never on a button of it.
    const focus = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      const dialog = document.querySelector('[role="alertdialog"]');
      const buttons = dialog ? [...dialog.querySelectorAll("button")] : [];
      return {
        cardBody: dialog !== null && active !== null && dialog.contains(active),
        button: buttons.some((button) => button === active || button.contains(active)),
      };
    });
    expect(focus.button).toBe(false);

    // Enter approves nothing: the file on disk is untouched and the card stays.
    await page.keyboard.press("Enter");
    await expect(approval).toBeVisible();
    expect(readFileSync(file, "utf8")).toBe(BEFORE);

    // Deny with a message: the text goes to the model as the tool result (cassette expect).
    await approval.getByRole("button", { name: "Deny with message…" }).click();
    const note = page.getByLabel("Message for the agent");
    await note.fill("Use a constant instead");
    await page.getByRole("button", { name: "Deny and send" }).click();

    // The turn finishes with the model's answer and no change on disk.
    await expect(
      page.locator("article").getByText(/greeting to use a constant instead/),
    ).toBeVisible();
    await expect(page.locator("article").getByText(/Change src\/greet\.ts .*Denied/)).toBeVisible();
    expect(readFileSync(file, "utf8")).toBe(BEFORE);
    await expect(page.getByRole("contentinfo")).toContainText("Agent idle");
  });
});

test.describe(() => {
  const cassette = fileURLToPath(
    new URL("../cassettes/agent-approvals-allow.jsonl", import.meta.url),
  );
  test.use({ relayEnv: { JESUTOBITS_PROVIDER: "scripted", JESUTOBITS_CASSETTE: cassette } });

  test("Allow once runs the edit once approved (J-14)", async ({ page, tempDir }) => {
    await openAndSend(page, tempDir);

    const approval = card(page);
    await approval.waitFor({ state: "visible" });
    const file = join(tempDir, OPEN_RELATIVE);
    await expect(approval).toContainText("Change src/greet.ts");
    await approval.getByRole("button", { name: "Allow once" }).click();

    // The tool ran: the answer with its change, the file on disk, and the decision recorded.
    await expect(page.locator("article").getByText(/Changed the greeting to/)).toBeVisible();
    await expect(
      page.locator("article").getByText(/Change src\/greet\.ts .*Allowed once/),
    ).toBeVisible();
    await expect.poll(() => readFileSync(file, "utf8")).toBe(AFTER);
    await expect(page.locator("article").getByText("1 file changed")).toBeVisible();
    await expect(page.getByRole("contentinfo")).toContainText("Agent idle");
  });
});
