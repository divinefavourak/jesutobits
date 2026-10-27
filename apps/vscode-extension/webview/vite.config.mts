import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webviewDir = dirname(fileURLToPath(import.meta.url));

/**
 * The agent panel's bundle (ADR-0015): one script and one stylesheet with fixed names, which
 * the extension loads into the webview with its own HTML, CSP and nonce.
 */
export default defineConfig({
  root: webviewDir,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: join(webviewDir, "..", "dist", "webview"),
    emptyOutDir: true,
    target: "chrome130",
    sourcemap: true,
    // Fonts and images stay files, so the CSP needs no `data:` sources.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: join(webviewDir, "src", "main.tsx"),
      output: {
        entryFileNames: "main.js",
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith(".css")) ? "main.css" : "[name][extname]",
      },
    },
  },
});
