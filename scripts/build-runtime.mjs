// Bundles the runtime into one ESM file (ADR-0013). Loading one file instead of hundreds
// of modules keeps `runtime.initialize` well inside NFR-002 on Windows.
// Output: packages/runtime/dist/bundle/runtime.mjs, the file the extension runs and tests spawn.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const runtimeDir = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "runtime");

await build({
  entryPoints: [join(runtimeDir, "src", "main.ts")],
  outfile: join(runtimeDir, "dist", "bundle", "runtime.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  // VS Code's Electron runs the bundle on Node 24 (ADR-0015, RN-40).
  target: "node24",
  sourcemap: "linked",
  minify: true,
  legalComments: "linked",
  // Migrations are .sql files inlined as strings (runtime/src/storage/migrations).
  loader: { ".sql": "text" },
  logLevel: "warning",
});
