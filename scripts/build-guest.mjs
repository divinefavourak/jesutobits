// Bundles the code that runs inside user projects (PROJECT_STRUCTURE.md section 3.1,
// ADR-0013): the Vite plugin, with @babel/parser and magic-string inlined, so nothing has to
// be installed into the project. Targets the oldest Node that Vite 8 supports.
// Output: packages/vite-plugin/dist/bundle/index.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "vite-plugin");

await build({
  entryPoints: [join(pluginDir, "src", "index.ts")],
  outfile: join(pluginDir, "dist", "bundle", "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20.19",
  // Type-only import; the project's own Vite is the one that runs.
  external: ["vite"],
  minify: true,
  sourcemap: "linked",
  legalComments: "linked",
  logLevel: "warning",
});
