import type { MonacoThemeData } from "@jesutobits/extension-schema";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/languages/features/css/css.worker?worker";
import HtmlWorker from "monaco-editor/languages/features/html/html.worker?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";
// One prebuilt stylesheet instead of Monaco's ~100 small ones (vite.config.ts).
import "monaco-editor-stylesheet";

/**
 * Monaco's one-time setup (ADR-0004). Loaded on the first file open, not at startup. Workers
 * are bundled files served from the app itself (CSP `worker-src 'self' blob:`).
 */
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    switch (label) {
      case "typescript":
      case "javascript":
        return new TsWorker();
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      default:
        return new EditorWorker();
    }
  },
};

// Monaco only knows the files it has open, so its type errors are often wrong ("cannot find
// module"). Syntax errors stay; the runtime's typecheck is the source of truth (ADR-0004).
for (const defaults of [
  monaco.typescript.typescriptDefaults,
  monaco.typescript.javascriptDefaults,
]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  defaults.setCompilerOptions({
    ...defaults.getCompilerOptions(),
    jsx: monaco.typescript.JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true,
  });
}

export const THEME_NAME = "jesutobits";

/** Applies a compiled theme to every editor; returns how long it took (budget 200 ms). */
export function applyTheme(theme: MonacoThemeData): number {
  const started = performance.now();
  monaco.editor.defineTheme(THEME_NAME, theme);
  monaco.editor.setTheme(THEME_NAME);
  return performance.now() - started;
}

export { monaco };
