import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      // Migrations are .sql files imported as text, as esbuild does for the runtime bundle.
      name: "sql-as-text",
      transform(code, id) {
        if (id.endsWith(".sql"))
          return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
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
