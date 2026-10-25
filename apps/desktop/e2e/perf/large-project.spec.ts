import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, openFolder, test } from "../fixtures";

// NFR-019 and NFR-003 in the Workbench: a project with 100,000 files opens, lists, and finds
// files without freezing the page. Generating the tree takes a while, so this runs only with
// JESUTOBITS_PERF=1 (nightly), like packages/services/test/large-tree.perf.test.ts.
test.skip(!process.env.JESUTOBITS_PERF, "set JESUTOBITS_PERF=1 to run");
test.describe.configure({ timeout: 300_000 });

/** No main-thread task over this long (NFR-003). */
const LONG_TASK_MS = 100;

test("a 100,000-file project opens and is searchable without long main-thread tasks", async ({
  page,
  tempDir,
}) => {
  const project = join(tempDir, "large-tree");
  execFileSync(process.execPath, ["../../scripts/gen-large-tree.mjs", project], {
    stdio: "ignore",
  });

  await page.goto("/");
  await page.evaluate(() => {
    const longTasks: number[] = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    }).observe({ type: "longtask", buffered: false });
    (globalThis as { __longTasks?: number[] }).__longTasks = longTasks;
  });

  await openFolder(page, project);
  const tree = page.getByRole("tree", { name: "Files" });
  await expect(tree.getByRole("treeitem").first()).toBeVisible({ timeout: 60_000 });

  // Quick open over the whole index once it is built.
  await page.keyboard.press("Control+p");
  const input = page.getByRole("combobox", { name: "Go to file" });
  await expect(page.getByText("Still listing the project's files")).toHaveCount(0, {
    timeout: 120_000,
  });
  await input.fill("pkg-4/module-19/part-19/file-49");
  await expect(page.getByRole("listbox").getByRole("option").first()).toBeVisible();

  const longTasks = await page.evaluate(
    () => (globalThis as { __longTasks?: number[] }).__longTasks ?? [],
  );
  process.stdout.write(
    `# long tasks: ${longTasks.length}, longest ${Math.round(Math.max(0, ...longTasks))} ms\n`,
  );
  expect(longTasks.filter((ms) => ms > LONG_TASK_MS)).toEqual([]);
});
