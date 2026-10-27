import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";
import { boundaryRules, isolatedFolders } from "./scripts/eslint-rules/boundaries.mjs";
import jesutobits from "./scripts/eslint-rules/index.mjs";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig([
  globalIgnores(["**/dist/", "**/node_modules/", "**/coverage/", "**/.vscode-test/", "fixtures/"]),

  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Package and module boundaries (PROJECT_STRUCTURE.md section 3, NFR-017).
  {
    plugins: { jesutobits },
    rules: {
      "jesutobits/import-boundaries": [
        "error",
        { root, rules: boundaryRules, isolate: isolatedFolders },
      ],
    },
  },

  // Stdout carries the protocol (ADR-0003).
  {
    files: ["packages/runtime/**", "packages/services/**"],
    rules: { "no-console": "error" },
  },

  // Only providers/ talks to the network (NFR-015).
  {
    files: ["packages/runtime/src/**"],
    ignores: ["packages/runtime/src/providers/**", "**/*.test.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message: "Only runtime/src/providers/ performs network requests (NFR-015).",
        },
        {
          name: "WebSocket",
          message: "Only runtime/src/providers/ performs network requests (NFR-015).",
        },
      ],
    },
  },

  // Webviews: browser code.
  {
    files: ["apps/vscode-extension/webview/src/**", "packages/visual-bridge/src/**"],
    languageOptions: { globals: { ...globals.browser } },
  },
  // Spike scripts run in Node but pass functions to a browser page to run.
  {
    files: ["scripts/spikes/**"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["apps/vscode-extension/webview/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ["apps/vscode-extension/webview/src/**"],
    ignores: ["apps/vscode-extension/webview/src/ui/markdown/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "Only ui/markdown/ may produce HTML from strings (SECURITY.md section 8).",
        },
      ],
    },
  },
  {
    files: [
      "apps/vscode-extension/webview/src/features/**",
      "apps/vscode-extension/webview/src/ui/**",
    ],
    rules: { "jesutobits/no-raw-colors": "error" },
  },
]);
