import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Monaco's export map hides package.json and min/, so go through the package link itself.
const monacoRoot = join(dirname(fileURLToPath(import.meta.url)), "node_modules", "monaco-editor");
const EMPTY_CSS = "\0monaco-empty-css";

/**
 * Monaco's ESM build imports about 100 small stylesheets, each a separate request through
 * the CSS pipeline: the first file open took 12 to 30 s in development. Those imports become
 * empty, and `monaco-setup.ts` imports the package's single prebuilt stylesheet instead
 * (same version, fonts and images inlined as data: URLs).
 */
function monacoStylesheet(): Plugin {
  return {
    name: "jesutobits:monaco-stylesheet",
    enforce: "pre",
    resolveId(source) {
      return /monaco-editor[\\/]esm[\\/].*\.css(?:\?.*)?$/.test(source) ? EMPTY_CSS : undefined;
    },
    load(id) {
      return id === EMPTY_CSS ? "export {};" : undefined;
    },
  };
}

/**
 * Development only. The dev server inlines each pre-bundled dependency's source map into
 * the response; for Monaco that turned a 5 MB chunk into 19 MB and 7 to 12 s per load.
 * Chunks this large lose their source map; smaller dependencies keep theirs.
 */
function dropHugeDependencyMaps(): Plugin {
  return {
    name: "jesutobits:drop-huge-dependency-maps",
    apply: "serve",
    transform(code, id) {
      if (!id.includes("/.vite/deps/") || code.length < 1_000_000) return undefined;
      return { code, map: { mappings: "" } };
    },
  };
}

// Workbench build (ADR-0013). Port 1420 is fixed so the Tauri dev config can point at it.
export default defineConfig({
  plugins: [monacoStylesheet(), dropHugeDependencyMaps(), react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: {
      "monaco-editor-stylesheet": join(monacoRoot, "min", "vs", "editor", "editor.main.css"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    // The Tauri CLI watches the Host. Watching src-tauri/target (thousands of folders after a
    // cargo build) blocked the dev server for 20 to 45 s on every cold start.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // Monaco loads on the first file open. Pre-bundling it when the server starts keeps Vite
  // from discovering it then, re-optimising and reloading the page mid-session.
  optimizeDeps: { include: ["monaco-editor"] },
  worker: { format: "es" },
  build: {
    target: "es2023",
  },
});
