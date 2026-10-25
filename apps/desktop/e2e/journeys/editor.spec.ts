import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, expectAccessible, openFolder, test } from "../fixtures";

// The editor (UX_AND_INTERFACE.md section 5.2, FR-073, FR-052): open, edit, save, changes
// on disk, tabs kept across restarts.

// Some tests include Monaco's first load in the dev server.
test.describe.configure({ timeout: 60_000 });

type MockHost = {
  logs: Array<{ level: string; message: string }>;
  settings: { update(patch: unknown): Promise<unknown> };
  requestClose(): Promise<boolean>;
};

const host = <T>(page: Page, run: (mock: MockHost) => T | Promise<T>) =>
  page.evaluate(`(${run.toString()})(globalThis.__JESUTOBITS_MOCK_HOST__)`) as Promise<Awaited<T>>;

/** The editor's visible text, with Monaco's non-breaking spaces as spaces. */
const editorText = (page: Page) =>
  page
    .locator(".monaco-editor .view-lines")
    .first()
    .evaluate((element) => (element as HTMLElement).innerText.replace(/\u00a0/g, " "));

function fixture(dir: string) {
  writeFileSync(join(dir, "notes.md"), "# Notes\n\nfirst line\n");
  writeFileSync(join(dir, "windows.txt"), "one\r\ntwo\r\n");
}

/** Monaco's first load in the dev server takes seconds (vite.config.ts); later ones are quick. */
const MONACO_LOAD = { timeout: 30_000 };

async function openInEditor(page: Page, name: string) {
  await page
    .getByRole("tree", { name: "Files" })
    .getByRole("treeitem", { name, exact: true })
    .dblclick();
  await expect(page.locator(".monaco-editor").first()).toBeVisible(MONACO_LOAD);
}

test("a file opens from the explorer, is edited and saved through the runtime (J-03)", async ({
  page,
  tempDir,
}) => {
  fixture(tempDir);
  await page.goto("/");
  await openFolder(page, tempDir);

  // A single click opens a preview tab.
  await page
    .getByRole("tree", { name: "Files" })
    .getByRole("treeitem", { name: "notes.md" })
    .click();
  const tabs = page.getByRole("list", { name: "Open files" });
  await expect(tabs.getByRole("button", { name: /^notes\.md ?, preview$/ })).toBeVisible();
  await expect(page.locator(".monaco-editor").first()).toBeVisible(MONACO_LOAD);
  await expect.poll(() => editorText(page)).toContain("first line");

  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("second line");
  // Typing keeps the tab and marks it unsaved.
  await expect(tabs.getByRole("button", { name: /^notes\.md ?, unsaved changes$/ })).toBeVisible();
  await expect(page.getByRole("contentinfo")).toContainText("Ln 4, Col 12");

  await page.keyboard.press("Control+s");
  await expect(tabs.getByRole("button", { name: "notes.md", exact: true })).toBeVisible();
  expect(readFileSync(join(tempDir, "notes.md"), "utf8")).toBe(
    "# Notes\n\nfirst line\nsecond line",
  );
  await expectAccessible(page);
});

test("saving keeps Windows line endings", async ({ page, tempDir }) => {
  fixture(tempDir);
  await page.goto("/");
  await openFolder(page, tempDir);
  await openInEditor(page, "windows.txt");
  await expect(page.getByRole("contentinfo")).toContainText("CRLF");

  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("three");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+s");
  await expect
    .poll(() => readFileSync(join(tempDir, "windows.txt"), "utf8"))
    .toBe("one\r\ntwo\r\nthree\r\n");
});

test("a clean tab follows the disk; a tab with changes shows the bar", async ({
  page,
  tempDir,
}) => {
  fixture(tempDir);
  await page.goto("/");
  await openFolder(page, tempDir);
  await openInEditor(page, "notes.md");

  // Clean: updates in place.
  writeFileSync(join(tempDir, "notes.md"), "# Notes\n\nchanged elsewhere\n");
  await expect.poll(() => editorText(page)).toContain("changed elsewhere");
  // (Monaco has role="alert" live regions of its own; look for the bar's text.)
  await expect(page.getByRole("alert").filter({ hasText: "changed on disk" })).toHaveCount(0);

  // Dirty: the bar, Compare, then Take theirs.
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("mine ");
  writeFileSync(join(tempDir, "notes.md"), "# Theirs\n");
  const bar = page.getByRole("alert").filter({ hasText: "changed on disk" });
  await expect(bar).toBeVisible();
  await expectAccessible(page);
  await bar.getByRole("button", { name: "Compare" }).click();
  await expect(page.locator(".monaco-diff-editor")).toBeVisible();
  await page.getByRole("button", { name: "Take theirs" }).click();
  await expect(page.locator(".monaco-diff-editor")).toHaveCount(0);
  // Monaco does not render the empty last line as text.
  await expect.poll(async () => (await editorText(page)).trim()).toBe("# Theirs");

  // Dirty again, then Keep mine: saving replaces the disk version deliberately.
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("mine");
  writeFileSync(join(tempDir, "notes.md"), "# Theirs again\n");
  await page.getByRole("button", { name: "Keep mine" }).click();
  await page.keyboard.press("Control+s");
  await expect.poll(() => readFileSync(join(tempDir, "notes.md"), "utf8")).toBe("# Theirs\nmine");
});

test("deleting an open file shows in the editor at once", async ({ page, tempDir }) => {
  fixture(tempDir);
  await page.goto("/");
  await openFolder(page, tempDir);
  await openInEditor(page, "notes.md");
  await openInEditor(page, "windows.txt");
  const tree = page.getByRole("tree", { name: "Files" });
  const tabs = page.getByRole("list", { name: "Open files" });

  // Moved to the trash in the explorer: its clean tab closes.
  await tree.getByRole("treeitem", { name: "notes.md" }).click();
  await page.keyboard.press("Delete");
  await page.getByRole("dialog").getByRole("button", { name: "Move to trash" }).click();
  await expect(tabs.getByRole("button", { name: /^notes\.md/ })).toHaveCount(0);

  // Deleted elsewhere while it has unsaved changes: the tab stays with the bar.
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.type("keep this ");
  rmSync(join(tempDir, "windows.txt"));
  await expect(
    page.getByRole("alert").filter({ hasText: "This file was deleted on disk." }),
  ).toBeVisible();
  await expect(tabs.getByRole("button", { name: /^windows\.txt/ })).toBeVisible();
  await page.keyboard.press("Control+s");
  await expect
    .poll(() =>
      existsSync(join(tempDir, "windows.txt"))
        ? readFileSync(join(tempDir, "windows.txt"), "utf8")
        : "",
    )
    .toContain("keep this");
});

test("files the editor cannot show say why", async ({ page, tempDir }) => {
  writeFileSync(join(tempDir, "huge.log"), "x".repeat(2 * 1024 * 1024 + 1));
  writeFileSync(join(tempDir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2]));
  await page.goto("/");
  await openFolder(page, tempDir);
  const tree = page.getByRole("tree", { name: "Files" });

  await tree.getByRole("treeitem", { name: "huge.log" }).dblclick();
  await expect(page.getByText("huge.log is larger than 2 MB.")).toBeVisible();
  await tree.getByRole("treeitem", { name: "image.png" }).dblclick();
  await expect(page.getByText("image.png is not a text file")).toBeVisible();
});

test("open tabs and the cursor come back after a restart (FR-008)", async ({ page, tempDir }) => {
  fixture(tempDir);
  await page.goto("/");
  await openFolder(page, tempDir);
  await openInEditor(page, "notes.md");
  await openInEditor(page, "windows.txt");
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+End");
  await expect(page.getByRole("contentinfo")).toContainText("Ln 3, Col 1");
  await page.getByRole("button", { name: "Close project" }).click();
  // Closing saves the open tabs; reload only once it is done.
  await expect(page.getByRole("button", { name: /^jesutobits-e2e-/ })).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: /^jesutobits-e2e-/ }).click();
  const tabs = page.getByRole("list", { name: "Open files" });
  await expect(tabs.getByRole("button", { name: "notes.md", exact: true })).toBeVisible();
  await expect(tabs.getByRole("button", { name: "windows.txt", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("contentinfo")).toContainText("Ln 3, Col 1");
});

test("closing with unsaved changes asks first", async ({ page, tempDir }) => {
  fixture(tempDir);
  await page.goto("/");
  await openFolder(page, tempDir);
  await openInEditor(page, "notes.md");
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("draft ");

  // The window: Cancel keeps it open.
  const closing = host(page, (mock) => mock.requestClose());
  const quit = page.getByRole("dialog", { name: "Save changes before quitting?" });
  await expect(quit).toContainText("1 file has unsaved changes: notes.md.");
  await expectAccessible(page);
  await quit.getByRole("button", { name: "Cancel" }).click();
  expect(await closing).toBe(false);

  // The project: Save all, then it closes.
  await page.getByRole("button", { name: "Close project" }).click();
  await page
    .getByRole("dialog", { name: "Save changes before closing the project?" })
    .getByRole("button", { name: "Save all" })
    .click();
  await expect(page.getByRole("heading", { name: "Recent projects" })).toBeVisible();
  expect(readFileSync(join(tempDir, "notes.md"), "utf8")).toBe("draft # Notes\n\nfirst line\n");
});

test("switching the theme recolours the editor within 200 ms", async ({ page, tempDir }) => {
  fixture(tempDir);
  await page.goto("/");
  await openFolder(page, tempDir);
  await openInEditor(page, "notes.md");
  const background = () =>
    page
      .locator(".monaco-editor")
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
  const before = await background();

  await host(page, (mock) =>
    mock.settings.update({
      appearance: { followOsTheme: false, theme: "builtin.jesutobits-themes/dark" },
    }),
  );
  await expect.poll(background).not.toBe(before);
  const timings = await host(page, (mock) =>
    mock.logs
      .map((entry) => /(?:editor )?theme .*applied in ([\d.]+) ms/.exec(entry.message)?.[1])
      .filter((ms): ms is string => ms !== undefined)
      .map(Number),
  );
  expect(timings.length).toBeGreaterThanOrEqual(2);
  for (const ms of timings) expect(ms).toBeLessThan(200);
});
