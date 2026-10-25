import { defineConfig, devices } from "@playwright/test";

/** Not 1420, so the tests can run while `pnpm dev` is open. */
export const E2E_ORIGIN = "http://127.0.0.1:1440";

// Browser E2E (TESTING_STRATEGY.md section 2): the Workbench in Chromium against
// MockHostBridge, relaying to a real runtime that each test starts (e2e/fixtures.ts).
export default defineConfig({
  testDir: "e2e",
  // Each test has its own runtime; one at a time keeps timings honest on CI runners.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: E2E_ORIGIN,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node ../../scripts/dev-web.mjs --port 1440",
    url: E2E_ORIGIN,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
