import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, expectAccessible, openFolder, test } from "../fixtures";

// The file explorer (UX_AND_INTERFACE.md section 5.1, FR-072, NFR-019).

function fixture(dir: string) {
  mkdirSync(join(dir, "src", "lib"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  writeFileSync(join(dir, "README.md"), "# Habits\n");
  writeFileSync(join(dir, "src", "App.tsx"), "export {};\n");
  writeFileSync(join(dir, "src", "lib", "date.ts"), "export {};\n");
}

test("the tree lists folders lazily, dims ignored ones and works from the keyboard", async ({
  page,
  tempDir,
}) => {
  fixture(tempDir);
  await page.goto("/");
  await openFolder(page, tempDir);

  const tree = page.getByRole("tree", { name: "Files" });
  const item = (name: string) => tree.getByRole("treeitem", { name, exact: true });
  await expect(item("src")).toHaveAttribute("aria-expanded", "false");
  // Ignored entries are dimmed and say so to screen readers.
  await expect(tree.getByRole("treeitem", { name: /^node_modules ?, ignored$/ })).toBeVisible();
  await expect(item("App.tsx")).toHaveCount(0);
  await expectAccessible(page);

  // Folders first, then files, each sorted by name.
  await expect(tree.getByRole("treeitem")).toHaveText([
    "node_modules, ignored",
    "src",
    ".gitignore",
    "README.md",
  ]);

  await item("src").click();
  await expect(item("src")).toHaveAttribute("aria-expanded", "true");
  await expect(item("App.tsx")).toHaveAttribute("aria-level", "2");

  // Arrow keys: down into lib, right to expand, right to its first child, left to the parent.
  await page.keyboard.press("ArrowDown");
  await expect(item("lib")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(item("lib")).toHaveAttribute("aria-expanded", "true");
  // Right moves into the folder once its listing has arrived.
  await expect(item("date.ts")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(item("date.ts")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(item("lib")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(item("lib")).toHaveAttribute("aria-expanded", "false");
  await expectAccessible(page);
});

test("files are created, renamed and moved to the trash through the runtime", async ({
  page,
  tempDir,
}) => {
  fixture(tempDir);
  await page.goto("/");
  await openFolder(page, tempDir);
  const tree = page.getByRole("tree", { name: "Files" });
  const item = (name: string) => tree.getByRole("treeitem", { name, exact: true });

  // New file in the selected folder.
  await item("src").click();
  await page.getByRole("button", { name: "New file" }).click();
  await page.getByLabel("Name of the new file").fill("habit.ts");
  await page.keyboard.press("Enter");
  await expect(item("habit.ts")).toHaveAttribute("aria-selected", "true");
  expect(readFileSync(join(tempDir, "src", "habit.ts"), "utf8")).toBe("");

  // A name that exists is refused and the field stays open.
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Name of the new folder").fill("lib");
  await page.keyboard.press("Enter");
  // Monaco (loaded by the file just created) has role="alert" live regions of its own.
  await expect(page.getByRole("alert").filter({ hasText: "already exists" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Name of the new folder")).toHaveCount(0);

  // F2 renames.
  await item("habit.ts").click();
  await page.keyboard.press("F2");
  await page.getByLabel("New name for habit.ts").fill("habits.ts");
  await page.keyboard.press("Enter");
  await expect(item("habits.ts")).toBeVisible();
  expect(existsSync(join(tempDir, "src", "habits.ts"))).toBe(true);
  expect(existsSync(join(tempDir, "src", "habit.ts"))).toBe(false);

  // Delete asks first, then moves it to the trash (the dev relay's stand-in trash).
  await item("habits.ts").click();
  await page.keyboard.press("Delete");
  const confirm = page.getByRole("dialog", { name: "Move habits.ts to the trash?" });
  await expect(confirm).toBeFocused();
  await expectAccessible(page);
  await confirm.getByRole("button", { name: "Move to trash" }).click();
  await expect(item("habits.ts")).toHaveCount(0);
  expect(existsSync(join(tempDir, "src", "habits.ts"))).toBe(false);
});

test("changes made outside Jesutobits appear in the tree", async ({ page, tempDir }) => {
  fixture(tempDir);
  await page.goto("/");
  await openFolder(page, tempDir);
  const tree = page.getByRole("tree", { name: "Files" });

  writeFileSync(join(tempDir, "notes.md"), "made elsewhere\n");
  await expect(tree.getByRole("treeitem", { name: "notes.md", exact: true })).toBeVisible();
});

test("the context menu copies paths and reveals in the file manager", async ({
  page,
  context,
  relay,
  tempDir,
}) => {
  fixture(tempDir);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await openFolder(page, tempDir);
  const tree = page.getByRole("tree", { name: "Files" });
  const readme = tree.getByRole("treeitem", { name: "README.md", exact: true });

  await readme.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Actions for README.md" });
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await expectAccessible(page);
  await menu.getByRole("menuitem", { name: "Copy relative path" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("README.md");

  // Shift+F10 opens the same menu from the keyboard.
  await readme.click();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Reveal in file manager" }).click();
  await expect.poll(() => relay.revealed.at(-1)).toMatch(/README\.md$/);
});
