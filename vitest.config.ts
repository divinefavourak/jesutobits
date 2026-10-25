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
    // Runtime integration tests spawn processes; keep their failures readable.
    testTimeout: 10_000,
    // Vitest empties CSS imports, `?raw` included; the Tailwind theme test reads this one.
    css: { include: [/styles[\\/]theme\.css/] },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "packages/*/src/**/*.test.ts",
            "packages/*/test/**/*.test.ts",
            "apps/*/src/**/*.test.ts",
            "scripts/**/*.test.mjs",
          ],
        },
      },
      {
        // Workbench components with Testing Library (TESTING_STRATEGY.md section 2).
        extends: true,
        test: {
          name: "components",
          include: ["apps/*/src/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["apps/desktop/src/test/setup-components.ts"],
        },
      },
    ],
  },
});
