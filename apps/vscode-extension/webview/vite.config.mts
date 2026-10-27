import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webviewDir = dirname(fileURLToPath(import.meta.url));
/** Which webview to build: `main` (the agent panel), `preview`, `learn` or `studio` (scripts/build.mjs sets it). */
const ENTRY = process.env.JESUTOBITS_WEBVIEW_ENTRY ?? "main";

/**
 * A webview's bundle (ADR-0015): one script and one stylesheet with fixed names, which the
 * extension loads into the webview with its own HTML, CSP and nonce.
 */
export default defineConfig({
  root: webviewDir,
  // Asset URLs relative to the stylesheet: a webview serves dist/webview from a resource
  // URI, not a site root, so the default "/" pointed the fonts at nothing.
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: join(webviewDir, "..", "dist", "webview"),
    emptyOutDir: true,
    target: "chrome130",
    sourcemap: true,
    // Fonts and images stay files, so the CSP needs no `data:` sources.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: join(webviewDir, "src", ENTRY === "main" ? "main.tsx" : `${ENTRY}/main.tsx`),
      output: {
        entryFileNames: `${ENTRY}.js`,
        codeSplitting: false,
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith(".css")) ? `${ENTRY}.css` : "[name][extname]",
      },
    },
  },
});
