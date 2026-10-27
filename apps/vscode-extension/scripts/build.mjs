// Builds the extension into dist/ (ADR-0015): the extension host entry as one CommonJS file,
// a copy of the runtime bundle, which the extension spawns on VS Code's Electron, and the
// agent panel's webview bundle. Run `pnpm build:packages` first so the runtime bundle exists.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { build as viteBuild } from "vite";

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeBundle = join(extensionDir, "..", "..", "packages", "runtime", "dist", "bundle");
const dist = join(extensionDir, "dist");

if (!existsSync(join(runtimeBundle, "runtime.mjs"))) {
  throw new Error("packages/runtime/dist/bundle/runtime.mjs is missing; run pnpm build:packages");
}

await build({
  entryPoints: [join(extensionDir, "src", "extension.ts")],
  outfile: join(dist, "extension.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  // VS Code 1.140+ runs extensions on Electron's Node 24 (RN-40).
  target: "node24",
  external: ["vscode"],
  sourcemap: "linked",
  logLevel: "warning",
});

mkdirSync(join(dist, "runtime"), { recursive: true });
for (const file of ["runtime.mjs", "runtime.mjs.map"]) {
  copyFileSync(join(runtimeBundle, file), join(dist, "runtime", file));
}

await viteBuild({
  configFile: join(extensionDir, "webview", "vite.config.mts"),
  logLevel: "warn",
});
