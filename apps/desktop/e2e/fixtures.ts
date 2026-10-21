import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, type Page } from "@playwright/test";
import { startRelay, type DevRelay } from "../../../scripts/dev-relay.mjs";
import { E2E_ORIGIN } from "../playwright.config";

/** The globals `host-bridge/index.ts` reads and sets in development builds. */
type E2EGlobals = {
  __JESUTOBITS_E2E_RELAY__?: string;
  __JESUTOBITS_MOCK_HOST__?: { nextPickedFolder: string | null };
};

export const test = base.extend<{
  /** A real runtime for this test only, with its own database. */
  relay: DevRelay;
  /** A canonical temp folder, removed after the test (Windows short names expanded). */
  tempDir: string;
}>({
  tempDir: async ({}, use) => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "jesutobits-e2e-")));
    await use(dir);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  },
  relay: async ({}, use) => {
    const dataDir = mkdtempSync(join(tmpdir(), "jesutobits-e2e-data-"));
    const relay = await startRelay({ dataDir, origin: E2E_ORIGIN, quiet: true });
    await use(relay);
    await relay.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  },
  page: async ({ page, relay }, use) => {
    await page.addInitScript((setting) => {
      (globalThis as E2EGlobals).__JESUTOBITS_E2E_RELAY__ = setting;
    }, `${relay.url}#${relay.token}`);
    await use(page);
  },
});

export { expect };

/** What the next OS folder dialog returns; null is Cancel. */
export async function chooseFolderInDialog(page: Page, path: string | null): Promise<void> {
  await page.evaluate((picked) => {
    const host = (globalThis as E2EGlobals).__JESUTOBITS_MOCK_HOST__;
    if (!host) throw new Error("The Workbench is not using MockHostBridge");
    host.nextPickedFolder = picked;
  }, path);
}

/** No serious or critical axe violations on what the page shows now (NFR-011). */
export async function expectAccessible(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const serious = violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({
      id: violation.id,
      help: violation.help,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    }));
  expect(serious).toEqual([]);
}
