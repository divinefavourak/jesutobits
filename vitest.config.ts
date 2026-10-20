import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "apps/*/src/**/*.test.{ts,tsx}",
      "scripts/**/*.test.mjs",
    ],
    // Runtime integration tests spawn processes; keep their failures readable.
    testTimeout: 10_000,
  },
});
